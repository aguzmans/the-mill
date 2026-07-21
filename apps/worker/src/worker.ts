import Redis from "ioredis";
import os from "node:os";
import { MillQueue, SecretStore, type JobSpec, type RunningJob } from "@mill/queue";
import { runWorkflow, DockerExecutor, type Executor } from "@mill/executor";
import { createLogger } from "@mill/telemetry";

const log = createLogger("worker");

// Stateless worker (ARCHITECTURE §3.5): register + heartbeat, pull jobs (never more than
// it can carry), execute via the shared executor, stream per-node status/logs to Redis.
// Concurrency is a dynamic min–max band that pauses pulling under memory pressure.

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const q = new MillQueue(redis);
const secretStore = new SecretStore(redis); // UI-managed secrets, merged per job (below)

// Worker id MUST be unique per pod — the registry (and each worker's processing list + the
// crash reaper) key on it. k8s pod names end in a per-pod random suffix, so take the LAST
// dash-segment; slicing the FRONT collapsed every `mill-worker-*` pod to the same id.
const rawWorkerId = process.env.MILL_WORKER_ID ?? process.env.HOSTNAME ?? crypto.randomUUID();
const workerId = "w-" + (rawWorkerId.split("-").pop() || rawWorkerId).slice(0, 8);
const host = os.hostname();
const concMin = Number(process.env.MILL_CONC_MIN ?? 1);
const concMax = Number(process.env.MILL_CONC_MAX ?? process.env.MILL_CONCURRENCY ?? 8);
const memMaxMB = Number(process.env.MILL_MEM_MAX_MB ?? 1024);
const pausePct = Number(process.env.MILL_PAUSE_PCT ?? 85);
const resumePct = Number(process.env.MILL_RESUME_PCT ?? 70);
// Node secrets come from three sources (a node only ever sees the refs it declares — makeCtx
// scrubs to `secrets: [...]`, so exposing the whole set here is safe): individual env vars
// (e.g. `envFrom` a k8s Secret), the MILL_SECRETS JSON blob, and the Redis store (UI-managed).
// The env-derived set is fixed at startup; the Redis set is re-read per job so edits apply live.
const envSecrets: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ...(process.env.MILL_SECRETS ? JSON.parse(process.env.MILL_SECRETS) : {}),
};

// Isolation: MILL_EXECUTOR=docker runs each job in its own hardened container.
const isolate: Executor | null = process.env.MILL_EXECUTOR === "docker"
  ? new DockerExecutor({ image: process.env.MILL_IMAGE ?? "mill-backend", workdirVolume: process.env.MILL_WORKDIR_VOLUME, defaultWallMs: 60_000 })
  : null;

let inFlight = 0;
let paused = false;
let exclusiveActive = false; // dedicated to an exclusive job → pull nothing else until done
const executorTier = isolate ? "docker" : "in-process";
const running = new Map<string, RunningJob>(); // jobs executing right now (for the Fleet view)

const memMB = () => Math.round(process.memoryUsage().rss / (1024 * 1024));
const memPct = () => Math.round((memMB() / memMaxMB) * 100);
const beat = () => q.heartbeat({
  id: workerId, host, inFlight, concMin, concMax, paused, exclusive: exclusiveActive,
  beatAt: Date.now(), memMB: memMB(), memMaxMB, executor: executorTier,
  jobs: Array.from(running.values()),
});
setInterval(() => beat().catch(() => {}), 3000);

async function handle(spec: JobSpec, raw: string) {
  // Replace concurrency policy: a run superseded while still queued must not execute.
  const pre = await q.getJob(spec.id).then((j) => j.status).catch(() => undefined);
  if (pre === "superseded") {
    log.info("skip superseded job (Replace policy)", { job: spec.id, workflow: spec.workflow });
    await q.ack(workerId, raw).catch(() => {});
    return;
  }
  running.set(spec.id, { id: spec.id, workflow: spec.workflow, startedAt: Date.now() });
  await q.markRunning(spec.id, workerId);
  // Re-read UI-managed secrets per job (cheap HGETALL) so a value added in the UI applies to
  // the next run without a worker restart. Env/k8s Secrets < Redis store (UI wins on conflict).
  const secrets = { ...envSecrets, ...(await secretStore.all().catch(() => ({}))) };
  const job = { projectDir: spec.projectDir, workflow: spec.workflow, input: spec.input, secrets, revision: spec.revision, request: spec.request as import("@mill/sdk").RequestCtx | undefined };
  let res;
  if (isolate) {
    // Isolated in a container; replay the run's events to Redis once it finishes.
    res = await isolate.execute(job);
    for (const e of res.events ?? []) await q.publishEvent(spec.id, e as any).catch(() => {});
  } else {
    // In-process: journal completed nodes so a requeued job (after a worker crash) resumes
    // where it left off instead of re-doing finished work.
    const journal = await q.journalGet(spec.id).catch(() => ({}));
    res = await runWorkflow(job, (e) => { q.publishEvent(spec.id, e).catch(() => {}); }, {
      journal,
      onNodeDone: (k, o) => { q.journalSet(spec.id, k, o).catch(() => {}); },
    });
    if (res.status === "succeeded") await q.journalClear(spec.id).catch(() => {}); // done — drop the journal
  }
  await q.markDone(spec.id, res.status, {
    result: JSON.stringify(res.result ?? null),
    error: res.error ?? "",
    ms: String(res.ms),
    worker: workerId,
    isolation: executorTier,
  });
  await q.publishEvent(spec.id, { type: "done", status: res.status, result: res.result ?? null, error: res.error ?? null });
  await q.ack(workerId, raw); // remove from processing only after it's done + recorded
  log[res.status === "failed" ? "warn" : "info"]("job " + res.status, { job: spec.id, workflow: spec.workflow, ms: res.ms, executor: executorTier, error: res.error || undefined });
}

async function loop() {
  log.info("worker online", { workerId, concMin, concMax, executor: executorTier, redis: process.env.REDIS_URL ?? "redis://localhost:6379" });
  await beat();
  while (true) {
    // Reactive gate: pause pulling above the memory threshold (never below min).
    paused = inFlight >= concMin && memPct() > (paused ? resumePct : pausePct);
    // While dedicated to an exclusive job, take nothing else until it finishes.
    if (exclusiveActive || inFlight >= concMax || (paused && inFlight >= concMin)) {
      await Bun.sleep(50);
      continue;
    }
    const job = await q.pull(workerId, 5);
    if (!job) continue;

    // Exclusive job wants the whole worker/pod. If we're already busy, hand it back so an
    // idle worker (or a fresh autoscaled pod) can dedicate itself; otherwise claim exclusivity.
    if (job.spec.exclusive) {
      if (inFlight > 0) {
        await q.requeue(workerId, job.raw);
        await Bun.sleep(200); // back off so we don't hot-loop re-pulling the same job
        continue;
      }
      exclusiveActive = true;
      log.info("exclusive claim", { job: job.spec.id, workflow: job.spec.workflow });
    }

    inFlight++;
    handle(job.spec, job.raw)
      .catch((e) => log.error("job errored", { job: job.spec.id, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => { inFlight--; if (job.spec.exclusive) exclusiveActive = false; running.delete(job.spec.id); });
  }
}

loop();
