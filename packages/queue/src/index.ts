import Redis from "ioredis";

// Redis-backed job queue + worker registry + live event bus.
//
// This is a deliberate, minimal stand-in so the local Gate-2 stack is reliable end to
// end. The production swap is BullMQ (retries/backoff, repeatable-cron, stalled-job
// recovery) behind this same seam — see ARCHITECTURE §3.4 / ROADMAP M2.

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "superseded";

export interface JobSpec {
  id: string;
  projectDir: string;
  workflow: string;
  input: unknown;
  revision?: string; // git SHA the job was enqueued at (cache-busts node imports)
  request?: unknown; // webhook envelope (raw body + headers + query) → ctx.request
  exclusive?: boolean; // run alone on a worker/pod until done (no co-tenant jobs)
}

export interface RunningJob {
  id: string;
  workflow: string;
  startedAt: number; // epoch ms
}

export interface WorkerInfo {
  id: string;
  host: string;
  inFlight: number;
  concMin: number;
  concMax: number;
  paused: boolean;
  // Enrichment for the Fleet view (optional — older workers may omit them).
  beatAt?: number; // epoch ms of this heartbeat (drives "heartbeat age")
  memMB?: number; // live RSS
  memMaxMB?: number; // admission ceiling this worker sizes against
  executor?: string; // "docker" (isolated) | "in-process"
  exclusive?: boolean; // currently dedicated to an exclusive job (taking no co-tenants)
  jobs?: RunningJob[]; // jobs currently executing on this worker
}

/** A finished job, as recorded in the rolling stats window. */
export interface CompletionRecord {
  w: string; // workflow
  ok: 0 | 1; // succeeded?
  d: number; // durationMs (start → finish)
  wait: number; // waitMs (enqueue → start)
  t: number; // finishedAt (epoch ms)
}

export interface QueueEvent {
  [k: string]: unknown;
  type: string;
}

export class MillQueue {
  private blocking?: Redis; // dedicated connection for BRPOP (blocking)

  /**
   * @param ttl seconds a job's keys (hash/events/journal/runs index) live after creation.
   *   Default 7 days (604800). Override via MILL_JOB_TTL_SECONDS — sizes Redis memory (see
   *   docs/DEPLOYMENT.md § Redis sizing). @param completedMax rolling cap on the global
   *   completed-runs list that feeds the dashboard (MILL_COMPLETED_MAX).
   */
  constructor(
    private redis: Redis,
    private prefix = "mill",
    private ttl = Number(process.env.MILL_JOB_TTL_SECONDS ?? 604800),
    private completedMax = Number(process.env.MILL_COMPLETED_MAX ?? 5000),
  ) {}

  private key(...parts: (string | number)[]) {
    return [this.prefix, ...parts].join(":");
  }

  // ── producer ──────────────────────────────────────────────────────────────
  async enqueue(spec: JobSpec & { trigger?: string; runKey?: string }): Promise<void> {
    await this.redis.hset(this.key("job", spec.id), {
      status: "queued",
      workflow: spec.workflow,
      project: spec.projectDir,
      input: JSON.stringify(spec.input ?? {}), // kept so a run can be retried with the same input
      trigger: spec.trigger ?? "manual",
      revision: spec.revision ?? "",
      createdAt: Date.now().toString(),
    });
    await this.redis.expire(this.key("job", spec.id), this.ttl);
    // Per-workflow recent-runs index (newest first, capped) for the Run history view.
    if (spec.runKey) {
      const rk = this.key("runs", spec.runKey);
      await this.redis.lpush(rk, spec.id);
      await this.redis.ltrim(rk, 0, 49);
      await this.redis.expire(rk, this.ttl);
    }
    await this.redis.lpush(this.key("queue"), JSON.stringify(spec));
  }

  /**
   * In-progress runs for a workflow (status queued or running), newest first. Used to enforce
   * a cron workflow's concurrencyPolicy (Forbid/Replace) before enqueuing another run.
   */
  async activeRuns(runKey: string): Promise<{ id: string; status: string }[]> {
    const ids = await this.redis.lrange(this.key("runs", runKey), 0, 49);
    const out: { id: string; status: string }[] = [];
    for (const id of ids) {
      const status = await this.redis.hget(this.key("job", id), "status");
      if (status === "queued" || status === "running") out.push({ id, status });
    }
    return out;
  }

  /** Mark a still-queued job superseded so the worker skips it when pulled (Replace policy). */
  async supersede(id: string): Promise<void> {
    await this.setStatus(id, "superseded", { supersededAt: Date.now().toString() });
  }

  /** Recent runs for a workflow (newest first), each enriched with its job hash. */
  async recentRuns(runKey: string, limit = 20): Promise<Record<string, string>[]> {
    const ids = await this.redis.lrange(this.key("runs", runKey), 0, limit - 1);
    const out: Record<string, string>[] = [];
    for (const id of ids) {
      const j = await this.getJob(id);
      if (Object.keys(j).length) out.push({ id, ...j });
    }
    return out;
  }

  // ── consumer (reliable: pulled jobs sit in the worker's processing list) ────
  /**
   * Blocking pull on a dedicated connection. Atomically moves the job into the worker's
   * processing list so a crash before ack leaves it recoverable (see reapDead).
   */
  async pull(workerId: string, timeoutSec = 5): Promise<{ spec: JobSpec; raw: string } | null> {
    if (!this.blocking) this.blocking = this.redis.duplicate();
    const raw = await this.blocking.blmove(this.key("queue"), this.key("processing", workerId), "RIGHT", "LEFT", timeoutSec);
    return raw ? { spec: JSON.parse(raw) as JobSpec, raw } : null;
  }

  /** Remove a finished job from the worker's processing list. */
  async ack(workerId: string, raw: string): Promise<void> {
    await this.redis.lrem(this.key("processing", workerId), 1, raw);
  }

  /**
   * Return a just-pulled job to the queue's pull end so another (idle) worker takes it next.
   * Used when a busy worker pulls an `exclusive` job it can't run alone right now. Atomic so
   * the job is never lost between the two lists.
   */
  async requeue(workerId: string, raw: string): Promise<void> {
    const p = this.redis.multi();
    p.lrem(this.key("processing", workerId), 1, raw); // remove from my processing list
    p.rpush(this.key("queue"), raw);                  // back to the RIGHT (pull) end → picked next
    await p.exec();
  }

  /**
   * Requeue in-flight jobs of workers whose heartbeat has expired (crashed mid-job).
   * Returns how many jobs were requeued. Run periodically by the controller.
   */
  async reapDead(): Promise<number> {
    const prefix = this.key("processing", "");
    const keys = await this.redis.keys(this.key("processing", "*"));
    let requeued = 0;
    for (const pk of keys) {
      const workerId = pk.slice(prefix.length);
      if (await this.redis.exists(this.key("worker", workerId))) continue; // still alive
      let raw: string | null;
      while ((raw = await this.redis.lmove(pk, this.key("queue"), "RIGHT", "LEFT"))) {
        requeued++;
        try {
          const spec = JSON.parse(raw) as JobSpec;
          await this.setStatus(spec.id, "queued", { requeued: "true" });
        } catch { /* ignore malformed */ }
      }
      await this.redis.del(pk);
    }
    return requeued;
  }

  async setStatus(id: string, status: JobStatus, extra: Record<string, string> = {}): Promise<void> {
    await this.redis.hset(this.key("job", id), { status, ...extra });
  }

  // ── monotonic metrics (a single Redis hash of counters, for Prometheus) ──────
  /** Latency histogram bucket upper-bounds, in seconds (Prometheus convention). */
  static readonly BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
  async metricInc(field: string, by = 1): Promise<void> { await this.redis.hincrby(this.key("metrics"), field, by).catch(() => {}); }
  async metricAll(): Promise<Record<string, string>> { return this.redis.hgetall(this.key("metrics")); }
  /** Observe a duration/wait into a named cumulative histogram (…_bucket:le, …_sum, …_count). */
  private async observe(name: string, seconds: number): Promise<void> {
    const p = this.redis.pipeline();
    for (const le of MillQueue.BUCKETS) if (seconds <= le) p.hincrby(this.key("metrics"), `${name}_bucket:${le}`, 1);
    p.hincrby(this.key("metrics"), `${name}_bucket:+Inf`, 1);
    p.hincrbyfloat(this.key("metrics"), `${name}_sum`, seconds);
    p.hincrby(this.key("metrics"), `${name}_count`, 1);
    await p.exec().catch(() => {});
  }

  /** Mark a job as started (records startedAt so wait/duration can be derived). */
  async markRunning(id: string, worker: string): Promise<void> {
    await this.redis.hset(this.key("job", id), { status: "running", worker, startedAt: Date.now().toString() });
  }

  /**
   * Terminal transition: write the final fields AND append a compact record to the
   * rolling stats window (capped) so the Fleet view can compute throughput/latency.
   */
  async markDone(id: string, status: JobStatus, extra: Record<string, string> = {}): Promise<void> {
    const now = Date.now();
    const j = await this.getJob(id);
    await this.redis.hset(this.key("job", id), { status, finishedAt: now.toString(), ...extra });
    if (status === "succeeded" || status === "failed") {
      const createdAt = Number(j.createdAt || now);
      const startedAt = Number(j.startedAt || createdAt);
      const rec: CompletionRecord = {
        w: j.workflow || "unknown",
        ok: status === "succeeded" ? 1 : 0,
        d: Math.max(0, now - startedAt),
        wait: Math.max(0, startedAt - createdAt),
        t: now,
      };
      const wkey = this.key("completed");
      await this.redis.rpush(wkey, JSON.stringify(rec));
      await this.redis.ltrim(wkey, -this.completedMax, -1); // keep the last N completions (MILL_COMPLETED_MAX)
      await this.redis.expire(wkey, this.ttl);
      // Monotonic counters + latency/wait histograms for Prometheus.
      await this.metricInc(`jobs_total:${status}`);
      await this.metricInc(`jobs_wf:${rec.w}:${status}`);
      await this.observe("job_duration_seconds", rec.d / 1000);
      await this.observe("job_wait_seconds", rec.wait / 1000);
    }
  }

  /** Completions in the rolling window, newest last. Optionally only those since `sinceMs`. */
  async completedWindow(sinceMs = 0): Promise<CompletionRecord[]> {
    const arr = await this.redis.lrange(this.key("completed"), 0, -1);
    const out: CompletionRecord[] = [];
    for (const s of arr) {
      try {
        const r = JSON.parse(s) as CompletionRecord;
        if (r.t >= sinceMs) out.push(r);
      } catch { /* ignore malformed */ }
    }
    return out;
  }

  /** Specs currently waiting in the queue (oldest last — head-of-line is index -1). */
  async queuedSpecs(): Promise<JobSpec[]> {
    const arr = await this.redis.lrange(this.key("queue"), 0, -1);
    const out: JobSpec[] = [];
    for (const s of arr) { try { out.push(JSON.parse(s) as JobSpec); } catch { /* ignore */ } }
    return out;
  }

  /** createdAt (epoch ms) of the oldest waiting job, or 0 if the queue is empty. */
  async oldestQueuedCreatedAt(): Promise<number> {
    const raw = await this.redis.lindex(this.key("queue"), -1); // RIGHT end = oldest (lpush/pull-right)
    if (!raw) return 0;
    try {
      const spec = JSON.parse(raw) as JobSpec;
      const j = await this.getJob(spec.id);
      return Number(j.createdAt || 0);
    } catch { return 0; }
  }

  async getJob(id: string): Promise<Record<string, string>> {
    return this.redis.hgetall(this.key("job", id));
  }

  // ── node-boundary journal (durability: a requeued job resumes, skipping done nodes) ──
  async journalGet(id: string): Promise<Record<string, unknown>> {
    const h = await this.redis.hgetall(this.key("job", id, "journal"));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(h)) { try { out[k] = JSON.parse(v); } catch { /* skip */ } }
    return out;
  }
  async journalSet(id: string, node: string, output: unknown): Promise<void> {
    const k = this.key("job", id, "journal");
    await this.redis.hset(k, node, JSON.stringify(output ?? null));
    await this.redis.expire(k, this.ttl);
  }
  async journalClear(id: string): Promise<void> {
    await this.redis.del(this.key("job", id, "journal"));
  }

  // ── event bus (live logs) ───────────────────────────────────────────────────
  async publishEvent(id: string, event: QueueEvent): Promise<void> {
    const s = JSON.stringify(event);
    const chan = this.key("job", id, "events");
    await this.redis.rpush(chan, s);
    await this.redis.expire(chan, this.ttl);
    await this.redis.publish(chan, s);
  }

  async getEvents(id: string): Promise<QueueEvent[]> {
    const arr = await this.redis.lrange(this.key("job", id, "events"), 0, -1);
    return arr.map((x) => JSON.parse(x) as QueueEvent);
  }

  /** Subscribe to live events for a job. Returns an async unsubscribe. */
  subscribe(id: string, onEvent: (e: QueueEvent) => void): () => Promise<void> {
    const sub = this.redis.duplicate();
    const chan = this.key("job", id, "events");
    sub.subscribe(chan).catch(() => {});
    sub.on("error", () => {}); // a dropped pub/sub connection must never crash the process
    sub.on("message", (_c, msg) => { try { onEvent(JSON.parse(msg) as QueueEvent); } catch { /* ignore malformed */ } });
    // Cleanup must be crash-proof: the connection may already be closed (client gone,
    // redis hiccup), in which case unsubscribe/disconnect throw — swallow both.
    return async () => {
      try { await sub.unsubscribe(chan); } catch { /* already closed */ }
      try { sub.disconnect(); } catch { /* already gone */ }
    };
  }

  // ── worker registry (heartbeat with TTL) ────────────────────────────────────
  async heartbeat(w: WorkerInfo, ttlSec = 15): Promise<void> {
    await this.redis.set(this.key("worker", w.id), JSON.stringify(w), "EX", ttlSec);
  }

  async workers(): Promise<WorkerInfo[]> {
    const keys = await this.redis.keys(this.key("worker", "*"));
    if (!keys.length) return [];
    const vals = await this.redis.mget(keys);
    return vals.filter((v): v is string => !!v).map((v) => JSON.parse(v) as WorkerInfo);
  }

  async queueDepth(): Promise<number> {
    return this.redis.llen(this.key("queue"));
  }
}
