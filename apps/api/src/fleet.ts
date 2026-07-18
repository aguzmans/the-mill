// Pure fleet-stats math, split out of the HTTP handler so it can be unit-tested without
// Redis. The controller reads the rolling completion window + queued specs from the
// queue and hands them here.
import type { CompletionRecord, JobSpec } from "@mill/queue";

export interface FleetStats {
  throughputPerMin: number; // recent rate (mean of the 12×1-min trend)
  completedLastHour: number;
  failedLastHour: number; // failures in the rolling window — surfaced prominently for operators
  p50Ms: number;
  p95Ms: number;
  successRatePct: number;
  avgWaitMs: number;
  throughputTrend: number[]; // 12 buckets, oldest → newest
}

export interface QueueView {
  depth: number;
  oldestWaitMs: number;
  byWorkflow: { workflow: string; count: number }[];
}

/** Nearest-rank percentile (p in 0..100). Returns 0 for an empty set. */
export function percentile(vals: number[], p: number): number {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

export function computeStats(window: CompletionRecord[], now: number): FleetStats {
  const durs = window.map((r) => r.d);
  const oks = window.filter((r) => r.ok === 1).length;

  const trend = Array(12).fill(0) as number[];
  for (const r of window) {
    const minsAgo = Math.floor((now - r.t) / 60_000);
    if (minsAgo >= 0 && minsAgo < 12) trend[11 - minsAgo]++;
  }

  return {
    throughputPerMin: Math.round(trend.reduce((a, b) => a + b, 0) / 12),
    completedLastHour: window.length,
    failedLastHour: window.length - oks,
    p50Ms: percentile(durs, 50),
    p95Ms: percentile(durs, 95),
    successRatePct: window.length ? Math.round((oks / window.length) * 100) : 100,
    avgWaitMs: window.length ? Math.round(window.reduce((a, r) => a + r.wait, 0) / window.length) : 0,
    throughputTrend: trend,
  };
}

export function computeQueueView(queued: JobSpec[], depth: number, oldestCreatedAt: number, now: number): QueueView {
  const byWorkflowMap = new Map<string, number>();
  for (const s of queued) byWorkflowMap.set(s.workflow, (byWorkflowMap.get(s.workflow) ?? 0) + 1);
  const byWorkflow = [...byWorkflowMap.entries()]
    .map(([workflow, count]) => ({ workflow, count }))
    .sort((a, b) => b.count - a.count);
  return {
    depth,
    oldestWaitMs: oldestCreatedAt ? Math.max(0, now - oldestCreatedAt) : 0,
    byWorkflow,
  };
}
