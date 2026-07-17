import Redis from "ioredis";
import os from "node:os";
import { MillQueue, type JobSpec, type RunningJob } from "@mill/queue";
import { runWorkflow, DockerExecutor, type Executor } from "@mill/executor";

// Stateless worker (ARCHITECTURE §3.5): register + heartbeat, pull jobs (never more than
// it can carry), execute via the shared executor, stream per-node status/logs to Redis.
// Concurrency is a dynamic min–max band that pauses pulling under memory pressure.

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const q = new MillQueue(redis);

const workerId = "w-" + ((process.env.MILL_WORKER_ID ?? process.env.HOSTNAME ?? crypto.randomUUID()).slice(0, 6));
const host = os.hostname();
const concMin = Number(process.env.MILL_CONC_MIN ?? 1);
const concMax = Number(process.env.MILL_CONC_MAX ?? process.env.MILL_CONCURRENCY ?? 8);
const memMaxMB = Number(process.env.MILL_MEM_MAX_MB ?? 1024);
const pausePct = Number(process.env.MILL_PAUSE_PCT ?? 85);
const resumePct = Number(process.env.MILL_RESUME_PCT ?? 70);
const secrets: Record<string, string> = process.env.MILL_SECRETS ? JSON.parse(process.env.MILL_SECRETS) : {};

// Isolation: MILL_EXECUTOR=docker runs each job in its own hardened container.
const isolate: Executor | null = process.env.MILL_EXECUTOR === "docker"
  ? new DockerExecutor({ image: process.env.MILL_IMAGE ?? "mill-backend", workdirVolume: process.env.MILL_WORKDIR_VOLUME, defaultWallMs: 60_000 })
  : null;

let inFlight = 0;
let paused = false;
const executorTier = isolate ? "docker" : "in-process";
const running = new Map<string, RunningJob>(); // jobs executing right now (for the Fleet view)

const memMB = () => Math.round(process.memoryUsage().rss / (1024 * 1024));
const memPct = () => Math.round((memMB() / memMaxMB) * 100);
const beat = () => q.heartbeat({
  id: workerId, host, inFlight, concMin, concMax, paused,
  beatAt: Date.now(), memMB: memMB(), memMaxMB, executor: executorTier,
  jobs: Array.from(running.values()),
});
setInterval(() => beat().catch(() => {}), 3000);

async function handle(spec: JobSpec, raw: string) {
  running.set(spec.id, { id: spec.id, workflow: spec.workflow, startedAt: Date.now() });
  await q.markRunning(spec.id, workerId);
  const job = { projectDir: spec.projectDir, workflow: spec.workflow, input: spec.input, secrets, revision: spec.revision };
  let res;
  if (isolate) {
    // Isolated in a container; replay the run's events to Redis once it finishes.
    res = await isolate.execute(job);
    for (const e of res.events ?? []) await q.publishEvent(spec.id, e as any).catch(() => {});
  } else {
    res = await runWorkflow(job, (e) => { q.publishEvent(spec.id, e).catch(() => {}); });
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
}

async function loop() {
  console.log(`mill-worker ${workerId} online · concurrency ${concMin}-${concMax} · executor=${isolate ? "docker (isolated)" : "in-process"} · redis=${process.env.REDIS_URL ?? "redis://localhost:6379"}`);
  await beat();
  while (true) {
    // Reactive gate: pause pulling above the memory threshold (never below min).
    paused = inFlight >= concMin && memPct() > (paused ? resumePct : pausePct);
    if (inFlight >= concMax || (paused && inFlight >= concMin)) {
      await Bun.sleep(50);
      continue;
    }
    const job = await q.pull(workerId, 5);
    if (!job) continue;
    inFlight++;
    handle(job.spec, job.raw)
      .catch((e) => console.error(`job ${job.spec.id} errored:`, e))
      .finally(() => { inFlight--; running.delete(job.spec.id); });
  }
}

loop();
