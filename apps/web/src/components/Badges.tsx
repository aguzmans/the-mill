import { CheckCircle2, GitCompareArrows, Loader2, AlertTriangle, CircleDot } from "lucide-react";
import type { SyncStatus, Health, NodeStatus } from "../lib/mock";
import { Tip } from "./InfoTip";

export function SyncBadge({ status }: { status: SyncStatus }) {
  const synced = status === "Synced";
  return (
    <Tip
      text={
        synced
          ? "Synced — running state matches the target git revision."
          : "OutOfSync — git has moved ahead of what's applied. Reconcile to catch up."
      }
    >
      <span
        data-testid="sync-badge"
        data-status={status}
        className={`chip ${synced ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}
      >
        {synced ? <CheckCircle2 className="h-3.5 w-3.5" /> : <GitCompareArrows className="h-3.5 w-3.5" />}
        {status}
      </span>
    </Tip>
  );
}

export function HealthBadge({ health }: { health: Health }) {
  const map = {
    Healthy: { cls: "bg-emerald-500/15 text-emerald-300", icon: <CheckCircle2 className="h-3.5 w-3.5" />, tip: "Healthy — latest revision compiled and all triggers are firing." },
    Progressing: { cls: "bg-sky-500/15 text-sky-300", icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, tip: "Progressing — a sync/compile is in flight." },
    Degraded: { cls: "bg-rose-500/15 text-rose-300", icon: <AlertTriangle className="h-3.5 w-3.5" />, tip: "Degraded — invalid YAML, a compile error, or a failing trigger. Last-known-good keeps running." },
  }[health];
  return (
    <Tip text={map.tip}>
      <span data-testid="health-badge" data-health={health} className={`chip ${map.cls}`}>
        {map.icon}
        {health}
      </span>
    </Tip>
  );
}

const statusStyles: Record<NodeStatus, { cls: string; label: string }> = {
  idle: { cls: "bg-slate-500/15 text-slate-300", label: "Idle" },
  queued: { cls: "bg-indigo-500/15 text-indigo-300", label: "Queued" },
  running: { cls: "bg-sky-500/15 text-sky-300", label: "Running" },
  succeeded: { cls: "bg-emerald-500/15 text-emerald-300", label: "Succeeded" },
  failed: { cls: "bg-rose-500/15 text-rose-300", label: "Failed" },
};

export function StatusPill({ status }: { status: NodeStatus }) {
  const s = statusStyles[status];
  return (
    <span data-testid="run-status" data-status={status} className={`chip ${s.cls}`}>
      {status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleDot className="h-3.5 w-3.5" />}
      {s.label}
    </span>
  );
}
