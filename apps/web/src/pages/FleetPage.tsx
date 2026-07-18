import { motion } from "framer-motion";
import { Cpu, Layers, Activity, MemoryStick, HeartPulse, Gauge, ShieldCheck, Zap, Timer, CheckCircle2, Hourglass, Clock, Loader2, AlertTriangle } from "lucide-react";
import { workers as mockWorkers, queue as mockQueue, fleetStats as mockStats, isolationLadder } from "../lib/mock";
import { InfoTip } from "../components/InfoTip";
import { Spec } from "../components/Kit";
import { useFleet } from "../lib/useLive";
import { LIVE, type FleetStats } from "../lib/api";

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${ms}ms`);

type ViewJob = { id: string; workflow: string; node?: string; elapsedMs: number; memMB?: number };
type ViewWorker = {
  id: string; host: string; status: string; executor: string; paused: boolean;
  heartbeatAgeS: number; leaseTtlS: number; memMB: number; memMaxMB: number;
  concMin: number; concMax: number; inFlight: number; jobs: ViewJob[];
};
type ViewQueue = { depth: number; oldestWaitMs: number; byWorkflow: { workflow: string; count: number }[] };

function Meter({ value, max, warn }: { value: number; max: number; warn?: boolean }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const color = warn && pct > 80 ? "bg-rose-500" : pct > 80 ? "bg-amber-500" : "bg-brand-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <motion.div className={`h-full ${color}`} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.5 }} />
    </div>
  );
}

const statusBadge: Record<string, string> = {
  default: "bg-emerald-500/15 text-emerald-300",
  dev: "bg-violet-500/15 text-violet-300",
  local: "bg-cyan-500/15 text-cyan-300",
  next: "bg-sky-500/15 text-sky-300",
  later: "bg-slate-500/15 text-slate-300",
  optin: "bg-amber-500/15 text-amber-300",
};

export function FleetPage() {
  const { fleet, ready } = useFleet();
  const now = fleet?.now ?? 0;

  // Live in LIVE mode (real workers + rolling stats from /api/fleet); mock otherwise.
  const workers: ViewWorker[] = ready
    ? fleet!.workers.map((w) => ({
        id: w.id, host: w.host, status: "online", executor: w.executor ?? "in-process", paused: w.paused,
        heartbeatAgeS: w.beatAt ? Math.max(0, Math.round((now - w.beatAt) / 1000)) : 0,
        leaseTtlS: 15, memMB: w.memMB ?? 0, memMaxMB: w.memMaxMB ?? 1024,
        concMin: w.concMin, concMax: w.concMax, inFlight: w.inFlight,
        jobs: (w.jobs ?? []).map((j) => ({ id: j.id, workflow: j.workflow, elapsedMs: Math.max(0, now - j.startedAt) })),
      }))
    : mockWorkers.map((w) => ({
        id: w.id, host: w.host, status: w.status, executor: w.executor, paused: w.paused,
        heartbeatAgeS: w.heartbeatAgeS, leaseTtlS: w.leaseTtlS, memMB: w.memMB, memMaxMB: w.memMaxMB,
        concMin: w.concMin, concMax: w.concMax, inFlight: w.inFlight,
        jobs: w.jobs.map((j) => ({ id: j.id, workflow: j.workflow, node: j.node, elapsedMs: j.elapsedMs, memMB: j.memMB })),
      }));
  const fleetStats: FleetStats = ready ? fleet!.stats : {
    throughputPerMin: mockStats.throughputPerMin, completedLastHour: mockStats.completedLastHour,
    failedLastHour: mockStats.failedLastHour,
    p50Ms: mockStats.p50Ms, p95Ms: mockStats.p95Ms, successRatePct: mockStats.successRatePct,
    avgWaitMs: mockStats.avgWaitMs, throughputTrend: mockStats.throughputTrend,
  };
  const failed = fleetStats.failedLastHour ?? 0;
  const queue: ViewQueue = ready ? fleet!.queue
    : { depth: mockQueue.depth, oldestWaitMs: mockQueue.oldestWaitMs, byWorkflow: mockQueue.byWorkflow };

  const online = workers.filter((w) => w.status === "online").length;
  const inFlight = workers.reduce((s, w) => s + w.inFlight, 0);
  // Which isolation rung is actually serving right now = the executor(s) the live workers report.
  const activeExecutors = new Set(workers.filter((w) => w.status === "online").map((w) => w.executor));

  return (
    <div className="space-y-6" data-testid="fleet-page">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
          Worker Fleet
          <InfoTip text="Stateless Bun workers pull jobs from the queue and run each node in-process inside their own hardened, HPA-scaled pod (the pod is the isolation boundary). They register in Redis on startup with a heartbeat TTL and never run alongside the api." />
          {LIVE && (
            <span className={`chip text-[10px] ${ready ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-500/15 text-slate-400"}`} data-testid="fleet-source">
              {ready ? "live" : "connecting…"}
            </span>
          )}
        </h1>
        <p className="mt-1 flex items-center gap-2 text-sm text-slate-400">
          Fleet scaled by the HPA on memory/CPU, or on queue depth via KEDA/custom metrics; each worker runs a dynamic min–max concurrency band. <Spec doc="ARCH §9" />
        </p>
      </div>

      {/* Failures banner — impossible to miss when runs are failing. */}
      {failed > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200" data-testid="failures-banner" role="alert">
          <AlertTriangle className="h-5 w-5 shrink-0 text-rose-400" />
          <span>
            <strong className="font-semibold text-rose-100">{failed.toLocaleString()} failed run{failed === 1 ? "" : "s"}</strong> in the last hour
            {fleetStats.completedLastHour > 0 && <> · success rate {fleetStats.successRatePct}%</>}. Check Run history for the failing workflows.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { icon: <Cpu className="h-4 w-4" />, label: "Workers online", value: online, tip: "Live workers pulling jobs. A missed heartbeat expires the registry lease and requeues their in-flight jobs.", testid: "stat-workers", danger: false },
          { icon: <Layers className="h-4 w-4" />, label: "Queue depth", value: queue.depth, tip: "Jobs waiting in the Redis queue. Workers pull from here as capacity frees up; the fleet scales on worker memory/CPU (HPA), not on this number.", testid: "stat-queue", danger: false },
          { icon: <Activity className="h-4 w-4" />, label: "Jobs in flight", value: inFlight, tip: "Jobs currently executing across the fleet.", testid: "stat-inflight", danger: false },
          { icon: <AlertTriangle className="h-4 w-4" />, label: "Failed (1h)", value: failed, tip: "Runs that finished failed in the last hour. Red = attention needed — open Run history to see which workflows and why. Alerting: mill_jobs_total{status=\"failed\"}.", testid: "stat-failed", danger: failed > 0 },
        ].map((s, i) => (
          <motion.div key={s.label} className={`card p-4 ${s.danger ? "border-rose-500/40 bg-rose-500/5" : ""}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} data-testid={s.testid} data-danger={s.danger ? "true" : undefined}>
            <div className={`flex items-center gap-2 text-sm ${s.danger ? "text-rose-300" : "text-slate-400"}`}>
              {s.icon} {s.label}
              <InfoTip text={s.tip} />
            </div>
            <div className={`mt-1 text-3xl font-semibold ${s.danger ? "text-rose-300" : "text-white"}`}>{s.value}</div>
          </motion.div>
        ))}
      </div>

      {/* autoscaling explainer — two levels */}
      <div className="card p-4" data-testid="autoscaling-panel">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Gauge className="h-4 w-4 text-slate-400" /> Autoscaling — two levels
          <InfoTip text="Each worker self-limits its own concurrency; the HPA scales the number of workers on memory/CPU. Pull-based = no central placement, per-job caps kill a hungry child, not the pod." />
        </h2>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-white/5 bg-ink-950/40 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-200">
              Per-worker concurrency <span className="chip bg-white/5 font-mono text-[10px] text-slate-400">dynamic min–max</span>
            </div>
            <ul className="space-y-1 text-[11px] text-slate-400">
              <li><span className="font-mono text-slate-300">min</span> — always runs at least this many (forward progress)</li>
              <li><span className="font-mono text-slate-300">max</span> — hard ceiling on simultaneous jobs</li>
              <li>admission reserves each job's declared <span className="font-mono">memMB</span> → many light jobs <em>or</em> a few heavy ones</li>
              <li><span className="text-amber-300">pauses</span> pulling when live memory/CPU crosses the threshold — even mid-run — and resumes when it drains</li>
            </ul>
          </div>
          <div className="rounded-lg border border-white/5 bg-ink-950/40 p-3">
            <div className="mb-2 text-xs font-medium text-slate-200">Fleet size</div>
            <div className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
              <ScaleCard title="HPA / KEDA" sub="scale pods on memory/CPU or queue depth" note="queue-depth autoscaling via mill_queue_depth (KEDA/adapter)" />
              <ScaleCard title="Cluster Autoscaler" sub="provision nodes" note="right-sizes the cluster" />
            </div>
          </div>
        </div>
      </div>

      {/* execution + queue */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2" data-testid="execution-panel">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Activity className="h-4 w-4 text-slate-400" /> Execution
            <InfoTip text="Fleet-wide throughput and latency (from Prometheus in the real app). The signals that matter for capacity: throughput vs. queue growth, p95 job duration, and schedule-to-start wait." />
            <Spec doc="ARCH §3.6" />
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat icon={<Zap className="h-3.5 w-3.5" />} label="Throughput" value={`${fleetStats.throughputPerMin}/min`} sub={`${fleetStats.completedLastHour.toLocaleString()} last hour`} />
            <Stat icon={<Timer className="h-3.5 w-3.5" />} label="p50 / p95" value={`${fmtMs(fleetStats.p50Ms)} / ${fmtMs(fleetStats.p95Ms)}`} sub="job duration" />
            <Stat icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="Success rate" value={`${fleetStats.successRatePct}%`} sub="last hour" />
            <Stat icon={<Hourglass className="h-3.5 w-3.5" />} label="Avg wait" value={fmtMs(fleetStats.avgWaitMs)} sub="schedule → start" />
            <div className="rounded-lg border border-white/5 bg-ink-950/40 p-2.5" data-testid="throughput-trend">
              <div className="text-[11px] text-slate-500">Throughput trend</div>
              <Sparkline data={fleetStats.throughputTrend} />
              <div className="mt-0.5 text-[10px] text-slate-600">last 12 min · jobs/min</div>
            </div>
          </div>
        </div>

        <div className="card p-4" data-testid="queue-panel">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Layers className="h-4 w-4 text-slate-400" /> Pending queue
            <InfoTip text="What's waiting in Redis, how long the head-of-line job has waited, and which workflows are backed up." />
          </h2>
          <div className="mt-3 flex items-end justify-between">
            <div>
              <div className="text-3xl font-semibold text-white">{queue.depth}</div>
              <div className="text-[11px] text-slate-500">jobs waiting</div>
            </div>
            <div className="text-right">
              <div className="inline-flex items-center gap-1 text-sm text-amber-300"><Clock className="h-3.5 w-3.5" /> {fmtMs(queue.oldestWaitMs)}</div>
              <div className="text-[11px] text-slate-500">oldest wait</div>
            </div>
          </div>
          <div className="mt-3 space-y-1.5" data-testid="queue-by-workflow">
            {queue.byWorkflow.map((q) => (
              <div key={q.workflow}>
                <div className="mb-0.5 flex items-center justify-between text-[11px] text-slate-400"><span className="truncate">{q.workflow}</span><span>{q.count}</span></div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"><div className="h-full bg-brand-500" style={{ width: `${Math.round((q.count / Math.max(1, queue.depth)) * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* workers */}
      <div className="space-y-3" data-testid="worker-list">
        {workers.map((w, i) => (
          <motion.div key={w.id} className="card p-4" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} data-testid={`worker-${w.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${w.status === "online" ? "bg-emerald-400 animate-pulseRing" : "bg-amber-400"}`} />
                <span className="font-mono text-sm text-white">{w.host}</span>
                <span className="chip bg-white/5 text-slate-300">{w.status}</span>
                <span className="chip bg-brand-500/15 font-mono text-brand-200" title="Executor tier this worker runs">{w.executor}</span>
                {w.paused && (
                  <span className="chip bg-amber-500/15 text-amber-300" data-testid={`paused-${w.id}`}>
                    paused
                    <InfoTip text="Stopped pulling new jobs: its accepted jobs turned heavy and live memory crossed the pause threshold. In-flight jobs finish; it resumes when memory drains." />
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1" title="Seconds since last heartbeat; lease TTL requeues on expiry" data-testid={`heartbeat-${w.id}`}>
                  <HeartPulse className="h-3.5 w-3.5 text-emerald-300" /> {w.heartbeatAgeS}s / {w.leaseTtlS}s TTL
                </span>
                <span className="inline-flex items-center gap-1">
                  <MemoryStick className="h-3.5 w-3.5" /> {w.memMB}/{w.memMaxMB} MB
                </span>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    Concurrency
                    <InfoTip text={`Dynamic band ${w.concMin}–${w.concMax}: the worker pulls up to max while resources allow, never below min, and pauses when memory/CPU is high.`} />
                  </span>
                  <span>{w.inFlight}/{w.concMax} jobs · min {w.concMin}</span>
                </div>
                <Meter value={w.inFlight} max={w.concMax} />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
                  <span>Memory</span>
                  <span>{Math.round((w.memMB / w.memMaxMB) * 100)}%</span>
                </div>
                <Meter value={w.memMB} max={w.memMaxMB} warn />
              </div>
            </div>

            {/* jobs currently running on this worker */}
            <div className="mt-3" data-testid={`jobs-${w.id}`}>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                <Activity className="h-3.5 w-3.5" /> Running now
                <InfoTip text="A sample of the jobs executing on this worker right now — the workflow, the node in progress, elapsed time, and live memory." />
              </div>
              <div className="space-y-1">
                {w.jobs.map((j) => (
                  <div key={j.id} className="flex items-center justify-between gap-2 rounded-md border border-white/5 bg-ink-950/40 px-2 py-1 text-[11px]">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-300" />
                      <span className="font-mono text-slate-600">{j.id.length > 8 ? j.id.slice(0, 8) : j.id}</span>
                      <span className="truncate text-slate-300">{j.workflow}</span>
                      {j.node && <span className="shrink-0 text-slate-600">›</span>}
                      {j.node && <span className="truncate font-mono text-slate-400">{j.node}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-slate-500">
                      <span>{fmtMs(j.elapsedMs)}</span>
                      {j.memMB != null && <span className={j.memMB > 256 ? "text-amber-300" : ""}>{j.memMB}MB</span>}
                    </span>
                  </div>
                ))}
                {w.inFlight > w.jobs.length && (
                  <div className="px-2 text-[10px] text-slate-600">+ {w.inFlight - w.jobs.length} more in flight</div>
                )}
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* isolation ladder */}
      <div className="card p-4" data-testid="isolation-ladder">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <ShieldCheck className="h-4 w-4 text-emerald-300" /> Isolation ladder
          <InfoTip text="How each node is sandboxed. On EKS the worker runs nodes in-process INSIDE a locked-down, HPA-scaled pod — the pod is the boundary (the 'default' rung). One Executor seam means a stronger rung is a config swap, not a rewrite. The 'live' rung is highlighted from what the online workers actually report; DockerExecutor is a local-only demo and the lower rungs are roadmap." />
          <Spec doc="ARCH §6" />
          {ready && activeExecutors.size > 0 && (
            <span className="chip bg-emerald-500/15 text-[10px] text-emerald-300" data-testid="ladder-active-executor">
              live: {[...activeExecutors].join(", ")}
            </span>
          )}
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-white/5">
                <th className="py-2 pr-3 font-medium">Executor</th>
                <th className="py-2 pr-3 font-medium">Trust</th>
                <th className="py-2 pr-3 font-medium">Cold start</th>
                <th className="py-2 pr-3 font-medium">Boundary</th>
                <th className="py-2 pr-3 font-medium">Stage</th>
              </tr>
            </thead>
            <tbody>
              {isolationLadder.map((r) => {
                const live = ready && r.executor != null && activeExecutors.has(r.executor);
                return (
                <tr key={r.tier} className={`border-b border-white/5 last:border-0 ${live ? "bg-emerald-500/[0.06]" : ""}`} data-testid={`ladder-${r.tier}`} data-live={live ? "true" : undefined}>
                  <td className="py-2 pr-3 font-mono text-slate-200">
                    {live && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle" title="A live worker is running this tier" />}
                    {r.name}
                  </td>
                  <td className="py-2 pr-3 text-slate-400">{r.trust}</td>
                  <td className="py-2 pr-3 font-mono text-slate-400">{r.coldStart}</td>
                  <td className="py-2 pr-3 text-slate-400">{r.boundary}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {live && <span className="chip mr-1 bg-emerald-500/20 text-emerald-200" data-testid={`ladder-live-${r.tier}`}>live</span>}
                    <span className={`chip ${statusBadge[r.status]}`}>{r.status === "default" ? "default" : r.status === "optin" ? "opt-in" : r.status}</span>
                    <InfoTip text={r.note} />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ScaleCard({ title, sub, note }: { title: string; sub: string; note: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-ink-950/40 p-3">
      <div className="font-mono text-slate-200">{title}</div>
      <div className="text-slate-400">{sub}</div>
      <div className="mt-1 text-[10px] text-slate-600">{note}</div>
    </div>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-ink-950/40 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-500">{icon}{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-white">{value}</div>
      <div className="text-[10px] text-slate-600">{sub}</div>
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="mt-1 flex h-8 items-end gap-0.5">
      {data.map((v, i) => (
        <div key={i} className="flex-1 rounded-sm bg-brand-500/60" style={{ height: `${Math.max(10, Math.round((v / max) * 100))}%` }} title={`${v}/min`} />
      ))}
    </div>
  );
}
