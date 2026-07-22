import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Play, Flag, Split, Code2, ExternalLink, Repeat, GitFork, Loader2, CheckCircle2, XCircle } from "lucide-react";
import type { NodeStatus, NodeKind } from "../lib/mock";

const statusRing: Record<NodeStatus, string> = {
  idle: "border-white/10",
  queued: "border-indigo-400/50",
  running: "border-sky-400 animate-pulseRing",
  succeeded: "border-emerald-400/70",
  failed: "border-rose-500/70",
  cancelled: "border-amber-400/60",
};

/** Per-kind accent + icon, reused by the palette and inspector. */
export const kindAccent: Record<NodeKind, { text: string; border: string; bg: string; dot: string }> = {
  start: { text: "text-emerald-300", border: "border-emerald-400/40", bg: "bg-emerald-500/10", dot: "!bg-emerald-400" },
  jscode: { text: "text-brand-300", border: "border-brand-400/40", bg: "bg-brand-500/10", dot: "!bg-brand-400" },
  if: { text: "text-amber-300", border: "border-amber-400/40", bg: "bg-amber-500/10", dot: "!bg-amber-400" },
  callScript: { text: "text-cyanx", border: "border-cyan-400/40", bg: "bg-cyan-500/10", dot: "!bg-cyanx" },
  loop: { text: "text-fuchsia-300", border: "border-fuchsia-400/40", bg: "bg-fuchsia-500/10", dot: "!bg-fuchsia-400" },
  fanout: { text: "text-sky-300", border: "border-sky-400/40", bg: "bg-sky-500/10", dot: "!bg-sky-400" },
  end: { text: "text-slate-300", border: "border-slate-400/30", bg: "bg-slate-500/10", dot: "!bg-slate-400" },
};

export function KindIcon({ kind, className }: { kind: NodeKind; className?: string }) {
  const cls = className ?? "h-3.5 w-3.5";
  switch (kind) {
    case "start": return <Play className={cls} />;
    case "jscode": return <Code2 className={cls} />;
    case "if": return <Split className={cls} />;
    case "callScript": return <ExternalLink className={cls} />;
    case "loop": return <Repeat className={cls} />;
    case "fanout": return <GitFork className={cls} />;
    case "end": return <Flag className={cls} />;
  }
}

function StatusIcon({ status }: { status: NodeStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-300" />;
  if (status === "succeeded") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 text-rose-300" />;
  return null;
}

// Top-to-bottom flow: edges enter the top of a node and leave the bottom.
const targetHandle = <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-brand-400" />;
const sourceHandle = <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-cyanx" />;

export function MillNode({ data, selected }: NodeProps) {
  const kind = ((data.kind as NodeKind) ?? "jscode") as NodeKind;
  const status = (data.status as NodeStatus) ?? "idle";
  const accent = kindAccent[kind];
  const label = data.label as string;
  const running = status !== "idle";
  const icon = running ? <StatusIcon status={status} /> : <span className={accent.text}><KindIcon kind={kind} /></span>;
  const ringSel = selected ? "ring-2 ring-brand-500" : "";

  // start / end — compact pills with a single handle.
  if (kind === "start" || kind === "end") {
    return (
      <div
        data-testid={`node-${data.nodeKey}`}
        data-status={status}
        data-kind={kind}
        className={`flex w-28 items-center gap-2 rounded-full border ${accent.border} ${accent.bg} px-3 py-2 shadow-lg shadow-black/30 ${statusRing[status]} ${ringSel}`}
      >
        {kind === "end" && targetHandle}
        {icon}
        <span className="text-sm font-medium text-white">{label}</span>
        {kind === "start" && sourceHandle}
      </div>
    );
  }

  // if — target on the left, two labelled source handles (true / false) on the right.
  if (kind === "if") {
    return (
      <div
        data-testid={`node-${data.nodeKey}`}
        data-status={status}
        data-kind={kind}
        className={`relative w-44 rounded-xl border ${accent.border} bg-ink-800/95 px-3 py-2.5 shadow-lg shadow-black/30 ${statusRing[status]} ${ringSel}`}
      >
        {targetHandle}
        <div className="flex items-center gap-2">
          {icon}
          <span className="truncate text-sm font-medium text-white">{label}</span>
        </div>
        {data.condition ? <div className="mt-1 truncate font-mono text-[10px] text-amber-200/80">if ({data.condition as string})</div> : null}
        <Handle id="true" type="source" position={Position.Bottom} style={{ left: "38%" }} className="!h-2 !w-2 !border-0 !bg-emerald-400" />
        <Handle id="false" type="source" position={Position.Bottom} style={{ left: "72%" }} className="!h-2 !w-2 !border-0 !bg-rose-400" />
        <span className="pointer-events-none absolute right-1.5 top-[30%] text-[9px] font-medium text-emerald-300">T</span>
        <span className="pointer-events-none absolute right-1.5 top-[64%] text-[9px] font-medium text-rose-300">F</span>
      </div>
    );
  }

  // jscode / callScript / loop — standard card.
  const call = data.call as { workflow: string; standalone?: boolean; project?: string } | undefined;
  return (
    <div
      data-testid={`node-${data.nodeKey}`}
      data-status={status}
      data-kind={kind}
      className={`w-48 rounded-xl border bg-ink-800/95 px-3 py-2.5 shadow-lg shadow-black/30 transition-colors ${
        running ? statusRing[status] : accent.border
      } ${ringSel}`}
    >
      {targetHandle}
      <div className="flex items-center gap-2">
        {icon}
        <span className="truncate text-sm font-medium text-white">{label}</span>
      </div>
      {kind === "jscode" && data.filename ? (
        <div className="mt-1 truncate font-mono text-[10px] text-slate-500">{data.filename as string}</div>
      ) : null}
      {kind === "callScript" ? (
        <div className="mt-1 flex items-center gap-1 truncate text-[10px]">
          <span className="font-mono text-cyanx">{call?.workflow ?? "pick a script"}</span>
          <span className={`chip px-1.5 py-0 text-[9px] ${call?.standalone ? "bg-cyan-500/15 text-cyanx" : "bg-white/5 text-slate-400"}`}>
            {call?.standalone ? "standalone" : call?.project ? call.project : "in-project"}
          </span>
        </div>
      ) : null}
      {kind === "loop" ? (
        <div className="mt-1 space-y-0.5 text-[10px]">
          <div className="truncate font-mono text-fuchsia-200/80">for each ({(data.each as string) || "input"})</div>
          <div className="truncate font-mono text-slate-500">
            → {data.filename ? (data.filename as string) : call?.workflow ? `call ${call.workflow}` : "pick a body"}
          </div>
        </div>
      ) : null}
      {kind === "fanout" ? (
        <div className="mt-1 truncate font-mono text-[10px] text-sky-200/80">→ dispatch ({(data.each as string) || "input"}) · parallel</div>
      ) : null}
      {sourceHandle}
    </div>
  );
}

export const nodeTypes = { mill: MillNode };
