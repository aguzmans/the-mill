import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  ReactFlow, Background, Controls, MarkerType, addEdge, useNodesState, useEdgesState,
  type ReactFlowInstance, type Connection, type Node, type Edge,
} from "@xyflow/react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Play, Save, Download, GitCommitHorizontal, Terminal, Boxes, Clock, Webhook, Hand, Zap,
  Copy, ShieldCheck, KeyRound, Cpu, History, RotateCcw, AreaChart, GitPullRequest, GitBranch, Flag, Split, Plus, Trash2, XCircle, AlertCircle, CheckCircle2,
} from "lucide-react";
import { findWorkflow, NODE_KINDS, compileCondition, type NodeStatus, type NodeKind, type WorkflowNode, type WorkflowEdge, type RunRecord, type Workflow, type IfClause } from "../lib/mock";
import { cronError, nextRuns, untilLabel, CRON_PRESETS } from "../lib/cron";
import { nodeTypes, KindIcon, kindAccent } from "../graph/MillNode";
import { resolvePosition, deoverlap } from "../graph/layout";
import { SyncBadge, HealthBadge, StatusPill } from "../components/Badges";
import { JsEditor } from "../components/JsEditor";
import { InfoTip, Tip } from "../components/InfoTip";
import { Modal, DiffRow, Spec, useToast, Toast } from "../components/Kit";
import { LIVE, triggerRun, streamEvents, getJob, getWorkflowGraph, saveWorkflow, testNode, getRuns, retryRun, cancelRun, getTimeline, getStatus, getFleet, getEndpoints, type LiveGraph, type NodeTestResult, type LiveRun } from "../lib/api";

const capW = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
type EditorProject = { id: string; name: string; branch: string; revision?: string; workflows?: Workflow[] };

/** Position live nodes top-to-bottom by graph depth (workflow.yaml has no positions). Depth
 *  runs DOWN the canvas; sibling nodes at the same depth spread across a row. */
function autoLayout(edges: { from: string; to: string }[], order: string[]): Record<string, { x: number; y: number }> {
  const depth: Record<string, number> = {};
  for (const key of order) {
    const parents = edges.filter((e) => e.to === key).map((e) => e.from);
    depth[key] = parents.length ? Math.max(...parents.map((p) => depth[p] ?? 0)) + 1 : 0;
  }
  const byDepth: Record<number, string[]> = {};
  for (const key of order) (byDepth[depth[key] ?? 0] ??= []).push(key);
  const pos: Record<string, { x: number; y: number }> = {};
  // ROW (vertical pitch between depths) exceeds node height so sequential steps never touch;
  // COL (horizontal pitch between siblings) exceeds node width. Sibling nodes at one depth are
  // centred against the widest row so branches read as a balanced top-down tree.
  const COL = 230, ROW = 130;
  const maxCols = Math.max(...Object.values(byDepth).map((n) => n.length));
  for (const key of order) {
    const d = depth[key] ?? 0;
    const row = byDepth[d];
    const colOffset = (maxCols - row.length) / 2; // centre this depth's nodes horizontally
    pos[key] = { x: (row.indexOf(key) + colOffset) * COL + 20, y: d * ROW + 20 };
  }
  return pos;
}

function liveToWorkflow(name: string, g: LiveGraph): Workflow {
  const pos = autoLayout(g.edges, g.order);
  const nodes = g.nodes.map((n: any) => ({ ...n, name: n.name || n.key, position: pos[n.key] ?? { x: 0, y: 0 } })) as WorkflowNode[];
  const triggers = (g.triggers ?? []).map((t: any) => ({ type: t.type, detail: t.schedule ?? t.path ?? "", concurrencyPolicy: t.concurrencyPolicy }));
  return {
    id: name, name: capW(name), description: "Live from the git working copy.",
    sync: "Synced", health: "Healthy", lastRun: "idle",
    triggers: triggers as Workflow["triggers"], nodes, edges: g.edges as WorkflowEdge[], runs: [],
    exclusive: g.exclusive ?? false,
    inputSchema: g.inputSchema ?? "",
  };
}

/** A brand-new workflow (from "New Workflow") that doesn't exist in git yet: a minimal
 *  start → step → end draft with the chosen first trigger. Save commits it and creates the files. */
function seedWorkflow(name: string, trigger: "manual" | "cron" | "webhook" | "event"): Workflow {
  return {
    id: name,
    name: capW(name),
    description: "New workflow (draft) — not yet committed. Build it, then Save to commit.",
    sync: "OutOfSync", health: "Healthy", lastRun: "idle",
    triggers: [{ type: trigger, detail: "" }],
    nodes: [
      { key: "start", kind: "start", name: "Start", position: { x: 160, y: 0 } },
      { key: "step", kind: "jscode", name: "Step", file: "nodes/step.js", position: { x: 160, y: 130 } },
      { key: "end", kind: "end", name: "End", position: { x: 160, y: 260 } },
    ],
    edges: [{ from: "start", to: "step" }, { from: "step", to: "end" }],
    runs: [],
    exclusive: false,
    inputSchema: "",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DND_MIME = "application/mill-node-kind";
type EditTrigger = { type: "manual" | "cron" | "webhook" | "event"; schedule?: string; path?: string; concurrencyPolicy?: "Allow" | "Forbid" | "Replace" };

function relTime(ms: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function toRunRecord(r: LiveRun): RunRecord {
  const st = (["queued", "running", "succeeded", "failed", "cancelled"].includes(r.status) ? r.status : "idle") as NodeStatus;
  return {
    id: r.id,
    status: st,
    trigger: ((r.trigger as RunRecord["trigger"]) || "manual"),
    revision: (r.revision || "").slice(0, 7) || "—",
    startedAt: relTime(Number(r.createdAt || 0)),
    durationMs: Number(r.ms || 0),
    nodeTimings: [],
    error: r.error ? { node: "", message: r.error } : undefined,
  };
}

const DEFAULT_JS = `export default async function step(input, ctx) {
  // input = upstream output · ctx = Mill SDK (ctx.log, ctx.secrets, …)
  return input;
}
`;

const DEFAULT_LOOP_BODY = `export default async function handle(item, ctx) {
  // Runs once per item. item = one element of the loop's array.
  // ctx.state.index = position · ctx.state carries across iterations.
  ctx.log.info("handling item " + ctx.state.index, { item });
  return item;
}
`;

const edgeStyle = (branch?: "true" | "false") => ({
  stroke: branch === "true" ? "#34d399" : branch === "false" ? "#fb7185" : "#6366f1",
});
const edgeMarker = (branch?: "true" | "false") => ({
  type: MarkerType.ArrowClosed,
  color: branch === "true" ? "#34d399" : branch === "false" ? "#fb7185" : "#6366f1",
});

export function WorkflowEditorPage() {
  const { projectId, workflowId } = useParams();
  const [searchParams] = useSearchParams();
  // A brand-new draft opened from "New Workflow": ?new=1&trigger=<type>. It doesn't exist in
  // git yet, so we seed a blank graph instead of fetching (which would 404).
  const isNew = LIVE && searchParams.get("new") === "1";
  const newTrigger = (["manual", "cron", "webhook", "event"].includes(searchParams.get("trigger") || "") ? searchParams.get("trigger") : "manual") as "manual" | "cron" | "webhook" | "event";
  // Live mode fetches the real graph from the controller; the mock catalogue is /prototype-only.
  const mock = LIVE ? { project: undefined, workflow: undefined } : findWorkflow(projectId, workflowId);
  const [live, setLive] = useState<{ project: EditorProject; workflow: Workflow } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLive(null); setErr(null);
    if ((mock.project && mock.workflow) || !LIVE || !projectId || !workflowId) return;
    const proj = { id: projectId, name: capW(projectId), branch: "main" };
    if (isNew) { setLive({ project: proj, workflow: seedWorkflow(workflowId, newTrigger) }); return; }
    setLoading(true);
    getWorkflowGraph(projectId, workflowId)
      .then((g) => setLive({ project: mock.project ?? proj, workflow: liveToWorkflow(workflowId, g) }))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, workflowId, isNew]);

  const project = (mock.project ?? live?.project) as EditorProject | undefined;
  const workflow = mock.workflow ?? live?.workflow;
  if (loading) return <div className="text-slate-400">Loading workflow…</div>;
  if (err) return <div className="text-rose-300">Failed to load workflow: {err}</div>;
  if (!project || !workflow) return <div className="text-slate-400">Workflow not found.</div>;
  return <EditorInner key={`${project.id}/${workflow.id}`} project={project} workflow={workflow} />;
}

function EditorInner({ project, workflow }: { project: EditorProject; workflow: Workflow }) {
  const navigate = useNavigate();
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [selected, setSelected] = useState<string | null>(workflow?.nodes[0]?.key ?? null);
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [runJobId, setRunJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [runResult, setRunResult] = useState<NodeStatus | null>(null);
  const [input, setInput] = useState('{ "since": "2026-07-01" }');
  const [showCommit, setShowCommit] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string | null>(workflow?.runs?.[0]?.id ?? null);
  const [liveRuns, setLiveRuns] = useState<RunRecord[]>([]);
  const [rf, setRf] = useState<ReactFlowInstance | null>(null);
  // Public webhook host (MILL_PUBLIC_WEBHOOK_URL) so the copied trigger URL points at the public
  // /p ingress, not the internal/SSO host the editor is browsed from. null → fall back to origin.
  const [publicBaseUrl, setPublicBaseUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!LIVE || !project?.id) return;
    getEndpoints(project.id).then((e) => setPublicBaseUrl(e.publicBaseUrl ?? null)).catch(() => {});
  }, [project?.id]);
  // Editable triggers (scheduling). Recover schedule/path from the loaded trigger detail.
  const [triggers, setTriggers] = useState<EditTrigger[]>(() =>
    (workflow.triggers ?? []).map((t) => ({
      type: t.type,
      schedule: t.type === "cron" ? (t.detail || "") : "",
      path: t.type === "webhook" ? (t.detail || "") : "",
      concurrencyPolicy: t.concurrencyPolicy,
    })),
  );
  const [exclusive, setExclusive] = useState<boolean>(workflow.exclusive ?? false);
  // The manual Run button is only meaningful when the workflow declares a `manual` trigger.
  // Webhook/cron/event-only jobs run via their endpoint/schedule — surface that instead.
  const hasManualTrigger = triggers.some((t) => t.type === "manual");
  // Block Save while any cron trigger's schedule is invalid — the reconciler would otherwise
  // silently drop it. Validated with the same engine (croner) the controller schedules with.
  const cronInvalid = triggers.some((t) => t.type === "cron" && cronError(t.schedule ?? "") !== null);
  const nonManualBy = triggers.find((t) => t.type === "webhook") ? "webhook — POST to its endpoint (Triggers panel)"
    : triggers.find((t) => t.type === "cron") ? `cron schedule (${triggers.find((t) => t.type === "cron")?.schedule || "…"})`
    : triggers.find((t) => t.type === "event") ? "an event" : "no trigger — add one";
  const [inputSchema, setInputSchema] = useState<string>(workflow.inputSchema ?? "");
  const dropCounter = useRef(0);
  const { toast, flash } = useToast();
  const logRef = useRef<HTMLDivElement>(null);

  const initialNodes = useMemo<Node[]>(() => {
    const src = workflow?.nodes ?? [];
    // Guarantee steps are separated: never render one node on top of another, whatever the
    // positions came from (hand-authored fixtures, auto-layout, or the workflow file).
    const spread = deoverlap(src.map((n) => ({ id: n.key, position: n.position, kind: n.kind })));
    return src.map((n) => ({
      id: n.key,
      type: "mill",
      position: spread[n.key] ?? n.position,
      data: { label: n.name, filename: n.file, nodeKey: n.key, kind: n.kind, condition: n.condition, call: n.call, each: n.each, deps: n.deps, inputSchema: n.inputSchema, outputSchema: n.outputSchema, connection: n.connection, query: n.query, params: n.params, paramsFrom: n.paramsFrom, mode: n.mode, transaction: n.transaction, timeoutMs: n.timeoutMs, status: "idle" as NodeStatus },
    }));
  }, [workflow]);
  const initialEdges = useMemo<Edge[]>(
    () =>
      (workflow?.edges ?? []).map((e) => ({
        id: `${e.from}-${e.to}-${e.branch ?? ""}`,
        source: e.from,
        target: e.to,
        sourceHandle: e.branch,
        animated: true,
        label: e.branch ?? e.depends,
        labelBgStyle: { fill: "#0f131b" },
        labelStyle: { fill: e.branch === "true" ? "#6ee7b7" : e.branch === "false" ? "#fda4af" : "#94a3b8", fontFamily: "JetBrains Mono, monospace", fontSize: 10 },
        style: edgeStyle(e.branch),
        markerEnd: edgeMarker(e.branch),
      })),
    [workflow],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, status: statuses[n.id] ?? "idle" } })));
  }, [statuses, setNodes]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  // Live Run history: poll recent runs for this workflow from the controller.
  useEffect(() => {
    if (!LIVE) return;
    let on = true;
    const load = () => getRuns(project.id, workflow.id)
      .then((r) => { if (on) setLiveRuns(r.runs.map(toRunRecord)); })
      .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { on = false; clearInterval(t); };
  }, [project.id, workflow.id]);

  const runs: RunRecord[] = LIVE ? liveRuns : (workflow.runs ?? []);
  useEffect(() => { if (LIVE && liveRuns.length && !liveRuns.some((r) => r.id === selectedRun)) setSelectedRun(liveRuns[0].id); }, [liveRuns, selectedRun]);

  // When a run is selected in live mode, fetch its per-node timeline for the Run detail spans.
  useEffect(() => {
    if (!LIVE || !selectedRun) return;
    let on = true;
    getTimeline(selectedRun).then((t) => {
      if (!on) return;
      const timings = t.nodeTimings.map((n) => ({ key: n.key, status: (n.status === "skipped" ? "idle" : n.status) as NodeStatus, ms: n.ms }));
      setLiveRuns((rs) => rs.map((r) => (r.id === selectedRun ? { ...r, nodeTimings: timings, error: t.error ?? r.error } : r)));
    }).catch(() => {});
    return () => { on = false; };
  }, [selectedRun]);

  const onConnect = useCallback(
    (c: Connection) => {
      const branch = (c.sourceHandle as "true" | "false" | undefined) || undefined;
      setEdges((eds) => addEdge({ ...c, animated: true, label: branch, style: edgeStyle(branch), markerEnd: edgeMarker(branch) } as Edge, eds));
      flash("Edge wired");
    },
    [setEdges, flash],
  );

  // Add a node from the palette (drag-drop with a screen point, or click with none),
  // always nudged to a non-overlapping spot so nodes never render on top of each other.
  const addNode = useCallback(
    (kind: NodeKind, screen?: { x: number; y: number }) => {
      const id = `${kind}-${++dropCounter.current}`;
      const label = NODE_KINDS.find((k) => k.kind === kind)?.label ?? kind;
      const data: Record<string, unknown> = { label, nodeKey: id, kind, status: "idle", isNew: true };
      if (kind === "if") { data.condition = "value === true"; data.conditions = [{ expr: "value === true" }]; }
      if (kind === "callScript") data.call = { workflow: "", ref: "", standalone: true };
      if (kind === "jscode") { data.code = DEFAULT_JS; data.filename = `nodes/${id}.js`; }
      if (kind === "loop") { data.each = "input"; data.code = DEFAULT_LOOP_BODY; data.filename = `nodes/${id}.js`; }
      if (kind === "sql") { data.connection = "DATABASE_URL"; data.query = "select * from your_table where id = $1"; data.params = ["input.id"]; data.mode = "single"; }
      setNodes((nds) => {
        const base = screen && rf ? rf.screenToFlowPosition(screen) : { x: nds.length ? Math.max(...nds.map((n) => n.position.x)) + 60 : 60, y: 80 };
        const at = resolvePosition(base, kind, nds as { position: { x: number; y: number }; data?: { kind?: NodeKind } }[]);
        return nds.concat({ id, type: "mill", position: at, data });
      });
      setSelected(id);
      flash(`Added ${label} node`);
    },
    [rf, setNodes, flash],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData(DND_MIME) as NodeKind;
      if (kind) addNode(kind, { x: e.clientX, y: e.clientY });
    },
    [addNode],
  );

  const applyCode = useCallback(
    (id: string, code: string) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, code } } : n)));
      flash("Applied to draft — Save to commit");
    },
    [setNodes, flash],
  );

  const setDeps = useCallback(
    (id: string, deps: Record<string, string>) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, deps } } : n)));
      flash("Updated dependencies (draft) — Save to commit + install");
    },
    [setNodes, flash],
  );

  const setCall = useCallback(
    (id: string, call: WorkflowNode["call"]) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, call } } : n)));
      flash("Call target updated (draft) — Save to commit");
    },
    [setNodes, flash],
  );

  const setSchema = useCallback(
    (id: string, which: "inputSchema" | "outputSchema", value: string) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, [which]: value || undefined } } : n)));
    },
    [setNodes],
  );

  const setSql = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    },
    [setNodes],
  );

  // Live: the other workflows in this project — the in-project call targets.
  const [callTargets, setCallTargets] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!LIVE) return;
    let on = true;
    getStatus().then((s) => {
      if (!on) return;
      const proj = s.projects?.find((p) => p.id === project.id);
      setCallTargets((proj?.workflows ?? []).map((w) => ({ id: w.name, name: capW(w.name) })).filter((w) => w.id !== workflow.id));
    }).catch(() => {});
    return () => { on = false; };
  }, [project.id, workflow.id]);

  const [saving, setSaving] = useState(false);
  const [commitMsg, setCommitMsg] = useState(`Update ${workflow.id}`);

  // Serialize the live graph → a workflow.yaml def + the node .js files (Save = commit).
  const serialize = useCallback(() => {
    const defNodes = nodes.map((rn) => {
      const d = rn.data as Record<string, unknown>;
      const kind = d.kind as NodeKind;
      const node: Record<string, unknown> = { key: rn.id, kind, name: (d.label as string) || rn.id };
      if (kind === "jscode") node.file = (d.filename as string) || `nodes/${rn.id}.js`;
      if (kind === "if") { if (d.condition) node.condition = d.condition; if (d.conditions) node.conditions = d.conditions; }
      if (kind === "callScript") node.call = d.call;
      if (kind === "loop") { node.each = (d.each as string) || "input"; if (d.filename) node.file = d.filename; else if (d.call) node.call = d.call; }
      if (kind === "sql") {
        node.connection = (d.connection as string) || "DATABASE_URL";
        node.query = (d.query as string) || "";
        node.mode = (d.mode as "single" | "each") || "single";
        if (d.paramsFrom) node.paramsFrom = d.paramsFrom as string;
        else node.params = (d.params as string[]) ?? [];
        if (node.mode === "each") { node.each = (d.each as string) || "input"; if (d.transaction) node.transaction = true; }
        if (d.timeoutMs) node.timeoutMs = Number(d.timeoutMs);
      }
      if (d.deps && Object.keys(d.deps as object).length) node.deps = d.deps; // external npm deps
      if (d.inputSchema) node.inputSchema = d.inputSchema; // enforced JS predicates
      if (d.outputSchema) node.outputSchema = d.outputSchema;
      return node;
    });
    const defEdges = edges.map((e) => {
      const edge: Record<string, unknown> = { from: e.source, to: e.target };
      if (e.sourceHandle) edge.branch = e.sourceHandle;
      return edge;
    });
    // Editable triggers → workflow.yaml (cron carries schedule; webhook may carry a custom path).
    const trig = triggers.map((t) => ({
      type: t.type,
      ...(t.type === "cron" && t.schedule ? { schedule: t.schedule } : {}),
      ...(t.type === "webhook" && t.path ? { path: t.path } : {}),
      ...(t.concurrencyPolicy ? { concurrencyPolicy: t.concurrencyPolicy } : {}),
    }));
    const def = {
      apiVersion: "mill/v1", kind: "Workflow", metadata: { name: workflow.id },
      triggers: trig.length ? trig : [{ type: "manual" }], nodes: defNodes, edges: defEdges,
      ...(exclusive ? { exclusive: true } : {}),
      ...(inputSchema.trim() ? { inputSchema: inputSchema.trim() } : {}),
    };
    const files: Record<string, string> = {};
    for (const rn of nodes) {
      const d = rn.data as Record<string, unknown>;
      const file = d.filename as string | undefined;
      if (file && (d.kind === "jscode" || d.kind === "loop")) files[file] = (d.code as string) ?? DEFAULT_JS;
    }
    return { def, files };
  }, [nodes, edges, workflow, triggers, exclusive, inputSchema]);

  const doSave = useCallback(async () => {
    if (cronInvalid) { flash("Can't save — a cron trigger has an invalid schedule"); return; }
    if (!LIVE) { setShowCommit(false); flash(`Committed to ${project.branch} · reconcile queued`); return; }
    setSaving(true);
    try {
      const { def, files } = serialize();
      await saveWorkflow(project.id, workflow.id, { message: commitMsg, workflow: def, files });
      setShowCommit(false);
      flash(`Saved · committed to ${project.branch} · reconciling`);
      // If this was a new draft (?new=1), drop the flag so a reload loads the committed workflow.
      navigate(`/projects/${project.id}/workflows/${workflow.id}`, { replace: true });
    } catch (e) {
      const issues = (e as { issues?: unknown[] }).issues;
      flash(`Save failed: ${e instanceof Error ? e.message : String(e)}${issues?.length ? ` (${issues.length} issue${issues.length === 1 ? "" : "s"})` : ""}`);
    } finally {
      setSaving(false);
    }
  }, [serialize, project, workflow, commitMsg, flash, cronInvalid]);

  const addLog = (line: string) => setLogs((l) => [...l, line]);
  // The node designated to fail on a Degraded run (the last failed run's offending node).
  const failNodeKey = runs.find((r) => r.status === "failed")?.error?.node;

  async function run() {
    if (running || !workflow) return;
    if (LIVE) return runLive();
    setRunning(true);
    setRunResult(null);
    setLogs([]);
    const seq = workflow.nodes;
    setStatuses(Object.fromEntries(seq.map((n) => [n.key, "queued" as NodeStatus])));
    addLog(`▶ run started · ${workflow.name} · revision ${project!.revision}`);
    addLog(`  input ${input.replace(/\s+/g, " ").trim()}`);
    for (const n of seq) {
      setStatuses((s) => ({ ...s, [n.key]: "running" }));
      addLog(runningLine(n));
      await sleep(280);
      if (workflow.health === "Degraded" && n.key === failNodeKey) {
        setStatuses((s) => ({ ...s, [n.key]: "failed" }));
        addLog(`[${n.key}] ✗ Error: SMTP connection refused (ECONNREFUSED)`);
        addLog(`✗ run failed at node "${n.key}"`);
        setRunResult("failed");
        setRunning(false);
        return;
      }
      setStatuses((s) => ({ ...s, [n.key]: "succeeded" }));
      addLog(doneLine(n));
    }
    addLog(`✓ run complete`);
    setRunResult("succeeded");
    setRunning(false);
  }

  // Live mode: trigger a real job on the controller and stream the worker's events.
  async function runLive() {
    if (!workflow || !project) return;
    setRunning(true);
    setRunResult(null);
    setLogs([]);
    const keys = workflow.nodes.map((n) => n.key);
    setStatuses(Object.fromEntries(keys.map((k) => [k, "queued" as NodeStatus])));
    let parsed: unknown = {};
    try { parsed = input.trim() ? JSON.parse(input) : {}; } catch { addLog("⚠ input is not valid JSON — using {}"); }
    addLog(`▶ triggering ${project.id}/${workflow.id} on the controller…`);
    let jobId: string;
    try {
      jobId = await triggerRun(project.id, workflow.id, parsed);
    } catch (e) {
      addLog(`✗ ${e instanceof Error ? e.message : String(e)} — this workflow may not exist in the backend yet (try billing/invoices or billing/dunning)`);
      setRunResult("failed");
      setRunning(false);
      return;
    }
    addLog(`  job ${jobId}`);
    setRunJobId(jobId);
    streamEvents(
      jobId,
      (e) => {
        if (e.type === "node" && e.node) {
          const st = (e.status === "skipped" ? "idle" : e.status) as NodeStatus;
          if (keys.includes(e.node)) setStatuses((s) => ({ ...s, [e.node!]: st }));
          addLog(`[${e.node}] ${e.status}${e.ms != null ? ` (${e.ms}ms)` : ""}${e.error ? ` — ${e.error}` : ""}`);
        } else if (e.type === "log" && e.node) {
          addLog(`   [${e.node}] ${e.level}: ${e.message}${e.fields ? " " + JSON.stringify(e.fields) : ""}`);
        }
      },
      async () => {
        try {
          const j = await getJob(jobId);
          setRunResult(j.status === "succeeded" ? "succeeded" : "failed");
          addLog(j.status === "succeeded" ? `✓ run complete · result ${JSON.stringify(j.result)}`
            : j.status === "cancelled" ? `⊘ run cancelled${j.error ? ` (${j.error})` : ""}`
            : `✗ run failed: ${j.error}`);
        } finally {
          setRunning(false);
          setRunJobId(null);
          setCancelling(false);
        }
      },
    );
  }

  const activeRun = runs.find((r) => r.id === selectedRun) ?? null;

  return (
    <div className="space-y-4" data-testid="workflow-editor">
      <Link to={`/projects/${project.id}`} className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200">
        <ArrowLeft className="h-4 w-4" /> {project.name}
      </Link>

      {/* header / toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-white">{workflow.name}</h1>
          <SyncBadge status={workflow.sync} />
          <HealthBadge health={workflow.health} />
          {workflow.concurrencyPolicy && (
            <span className="chip bg-white/5 font-mono text-slate-300" data-testid="concurrency-policy">
              concurrency: {workflow.concurrencyPolicy}
              <InfoTip text="Per-workflow overlap policy (borrowed from k8s CronJob): Allow runs concurrently · Forbid skips if one is running · Replace cancels the in-flight run." />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Tip text={(!LIVE || hasManualTrigger)
            ? "Run this workflow now with the input payload below. Nodes execute in isolated workers; status and logs stream live."
            : `Runs via ${nonManualBy}. Add a manual trigger to run it here with a test payload.`}>
            <span>
              <button className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed" data-testid="run-btn" onClick={run} disabled={running || (LIVE && !hasManualTrigger)}>
                <Play className="h-4 w-4" /> {running ? "Running…" : "Run"}
              </button>
            </span>
          </Tip>
          {running && runJobId && LIVE && (
            <Tip text="Politely stop the run: the current node finishes, then it stops at the next boundary and records as cancelled.">
              <button className="btn-ghost text-rose-300 hover:text-rose-200 disabled:opacity-60" data-testid="cancel-run-btn" disabled={cancelling}
                onClick={() => { setCancelling(true); cancelRun(runJobId).then(() => addLog("⊘ cancel requested…")).catch((e) => { addLog(`✗ cancel: ${e.message}`); setCancelling(false); }); }}>
                <XCircle className="h-4 w-4" /> {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            </Tip>
          )}
          <Tip text={cronInvalid ? "Fix the invalid cron schedule (Triggers panel) before saving." : "Save commits workflow.yaml + node .js back to the git repo. The reconciler then syncs running state."}>
            <span>
              <button className="btn-ghost disabled:opacity-40 disabled:cursor-not-allowed" data-testid="save-btn" onClick={() => setShowCommit(true)} disabled={cronInvalid}>
                <Save className="h-4 w-4" /> Save
              </button>
            </span>
          </Tip>
          <Tip text="Export this project as a standalone, runnable JS bundle (.tar.gz). A workflow can call its siblings, so the whole project is the unit; run.sh <workflow> runs a specific one.">
            <button className="btn-ghost" data-testid="export-workflow-btn" onClick={() => {
              if (LIVE) { flash("Building export bundle · index.js + package.json + run.sh"); window.location.href = `/api/projects/${project.id}/export`; }
              else flash("Building export bundle · index.js + package.json + run.sh");
            }}>
              <Download className="h-4 w-4" /> Export
            </button>
          </Tip>
        </div>
      </div>

      {/* component palette */}
      <Palette onAdd={addNode} />

      <ResizableSplit
        storageKey="mill.editor.split"
        left={
          /* graph */
          <div
            className="card relative h-full overflow-hidden"
            data-testid="graph-canvas"
            onDrop={onDrop}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
          >
            <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-1.5 text-xs text-slate-400">
              <Boxes className="h-3.5 w-3.5" /> Flow = the program
              <InfoTip text="This graph IS the program: start → steps → end. `if` compiles to a literal if in the main file; JS Code nodes are separate .js files it loads; Call Script runs another script as a step. Drag components from the palette; drag between handles to wire edges." />
              <Spec doc="ARCH §1" />
            </div>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onInit={setRf}
              nodeTypes={nodeTypes}
              onNodeClick={(_, n) => setSelected(n.id)}
              fitView
              // Wide graphs (7–8 nodes) need to zoom out past the default minZoom (0.5) to fit;
              // otherwise the rightmost node renders off-screen on load. Allow deeper zoom-out.
              minZoom={0.2}
              fitViewOptions={{ padding: 0.15, minZoom: 0.2 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#233" gap={18} />
              <Controls className="!bg-ink-800 !border-white/10" />
            </ReactFlow>
          </div>
        }
        right={
          /* node inspector */
          <div className="card flex h-full flex-col overflow-auto p-4" data-testid="node-panel">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white">Node</h2>
              <InfoTip text="The selected component's configuration. What shows depends on its kind (start / JS code / if / call script / end)." />
            </div>
            <NodeInspector
              key={selected ?? "none"}
              selected={selected}
              liveNodes={nodes}
              workflow={workflow}
              projectId={project.id}
              projectWorkflows={project.workflows ?? []}
              callTargets={callTargets}
              onEdit={flash}
              onApplyCode={applyCode}
              onSetDeps={setDeps}
              onSetCall={setCall}
              onSetSchema={setSchema}
              onSetSql={setSql}
            />
          </div>
        }
      />

      {/* run controls + logs */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-4" data-testid="run-panel">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">Run</h2>
            <InfoTip text="Per-node execution status for the latest run. Updates live over WebSocket (Redis pub/sub) in the real app." />
            {runResult && <span data-testid="run-result" data-status={runResult}><StatusPill status={runResult} /></span>}
          </div>
          {LIVE && !hasManualTrigger && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-[11px] text-slate-400" data-testid="run-trigger-note">
              <Webhook className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-400" />
              <span>This workflow runs via <span className="text-slate-200">{nonManualBy}</span> — it isn't run by hand. The input below is only used if you add a <span className="font-medium">manual</span> trigger.</span>
            </div>
          )}
          <label className="mt-3 block">
            <div className="mb-1 flex items-center gap-1.5 text-xs text-slate-400">
              <Hand className="h-3.5 w-3.5" /> Manual input (JSON)
              <InfoTip text="A manual trigger runs the workflow with this payload as the Start node's input. Cron/webhook triggers supply their own." />
            </div>
            <textarea
              data-testid="run-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              className="h-14 w-full resize-none rounded-lg border border-white/10 bg-ink-950/70 p-2 font-mono text-xs text-slate-200 outline-none focus:border-brand-500/60"
            />
          </label>
          <div className="mt-3 space-y-2">
            {workflow.nodes.map((n) => (
              <div key={n.key} className="flex items-center justify-between" data-testid={`node-status-${n.key}`}>
                <span className="flex items-center gap-1.5 text-sm text-slate-300">
                  <span className={kindAccent[n.kind].text}><KindIcon kind={n.kind} className="h-3 w-3" /></span>
                  {n.name}
                </span>
                <StatusPill status={statuses[n.key] ?? "idle"} />
              </div>
            ))}
          </div>
        </div>

        {/* logs */}
        <div className="card p-4 lg:col-span-2" data-testid="log-panel">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-white">Logs</h2>
            <InfoTip text="Live log stream (Redis pub/sub in the real app; durable history goes to Loki, queryable with LogQL)." />
          </div>
          <div ref={logRef} data-testid="log-console" className="mt-3 h-40 overflow-auto rounded-lg bg-ink-950/80 p-3 font-mono text-xs leading-5 text-slate-300">
            {logs.length === 0 ? (
              <span className="text-slate-600">No logs yet — press Run.</span>
            ) : (
              logs.map((l, i) => (
                <motion.div key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} data-testid="log-line" className={l.includes("✗") ? "text-rose-300" : l.includes("✓") ? "text-emerald-300" : ""}>
                  {l}
                </motion.div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* triggers + observability */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TriggersPanel triggers={triggers} setTriggers={setTriggers} exclusive={exclusive} setExclusive={setExclusive} inputSchema={inputSchema} setInputSchema={setInputSchema} workflow={workflow.id} projectId={project.id} publicBaseUrl={publicBaseUrl} onCopy={(url) => { navigator.clipboard?.writeText(url).catch(() => {}); flash("Webhook URL copied"); }} />
        <ObservabilityPanel onOpen={(dest) => flash(`Opening ${dest} …`)} />
      </div>

      {/* run history */}
      <div className="card p-4" data-testid="run-history">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <History className="h-4 w-4 text-slate-400" /> Run history
          <InfoTip text="Mill stores no DB — recent runs live in Redis (TTL); full history is in Loki/Tempo. A run is one trace; each node is a span." />
          <Spec doc="ARCH §8" />
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            {runs.length === 0 && <p className="text-xs text-slate-500" data-testid="no-runs">No runs yet — hit Run to execute this workflow.</p>}
            {runs.map((r) => (
              <button
                key={r.id}
                data-testid={`run-row-${r.id}`}
                onClick={() => setSelectedRun(r.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                  selectedRun === r.id ? "border-brand-500/40 bg-brand-500/10" : "border-white/5 bg-ink-950/40 hover:bg-white/5"
                }`}
              >
                <span className="flex items-center gap-2 text-xs">
                  <StatusPill status={r.status} />
                  <span className="font-mono text-slate-400">{r.id}</span>
                </span>
                <span className="flex items-center gap-2 text-[11px] text-slate-500">
                  <TriggerIcon type={r.trigger} /> {r.trigger} · @{r.revision} · {r.startedAt}
                </span>
              </button>
            ))}
          </div>
          {activeRun && <RunDetail run={activeRun} onRetry={async () => {
            if (!LIVE) { flash("Retry queued · journaling skips completed nodes"); return; }
            try { const { jobId } = await retryRun(activeRun.id); flash(`Retrying → ${jobId}`); setTimeout(() => getRuns(project.id, workflow.id).then((r) => setLiveRuns(r.runs.map(toRunRecord))).catch(() => {}), 800); }
            catch (e) { flash(`Retry failed: ${e instanceof Error ? e.message : String(e)}`); }
          }} />}
        </div>
      </div>

      {/* commit modal */}
      <Modal
        open={showCommit}
        onClose={() => setShowCommit(false)}
        testid="commit-modal"
        wide
        icon={<GitCommitHorizontal className="h-4 w-4 text-brand-400" />}
        title={<span className="flex items-center gap-2">Save = commit <Spec doc="ARCH §5" /></span>}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setShowCommit(false)}>Cancel</button>
            <button
              className="btn-primary"
              data-testid="commit-submit"
              onClick={doSave}
              disabled={saving || cronInvalid}
            >
              <GitCommitHorizontal className="h-4 w-4" /> {saving ? "Committing…" : "Commit"}
            </button>
          </>
        }
      >
        <p className="text-xs text-slate-400">
          There are no out-of-band live writes. Edits accumulate in an in-memory <strong>draft</strong>; saving commits
          to git, and the reconciler then syncs running state — so “what you see == what runs == what’s in git.”
        </p>
        <div className="mt-3 space-y-1.5">
          <DiffRow change="modified" path={`workflows/${workflow.id}/workflow.yaml`} summary="graph: added/rewired nodes (draft)" />
          <DiffRow change="modified" path={`workflows/${workflow.id}/nodes/${(workflow.nodes.find((n) => n.kind === "jscode")?.key) ?? "step"}.js`} summary="edited in the inspector (draft)" />
        </div>
        <label className="mt-4 block">
          <div className="mb-1 text-xs font-medium text-slate-300">Commit message</div>
          <input className="inp" value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)} data-testid="commit-message" />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-300">
          <label className="inline-flex items-center gap-2"><input type="radio" name="target" defaultChecked /> <GitBranch className="h-3.5 w-3.5" /> Commit to <span className="font-mono">{project.branch}</span> <span className="chip bg-emerald-500/10 px-1.5 py-0 text-[10px] text-emerald-300">v1</span></label>
          <label className="inline-flex items-center gap-2 opacity-60"><input type="radio" name="target" disabled /> <GitPullRequest className="h-3.5 w-3.5" /> Branch + PR (approval) <span className="chip bg-white/5 px-1.5 py-0 text-[10px] text-slate-400">later</span></label>
          <InfoTip text="v1 writes directly to the tracked branch on GitHub. Branch/PR + approval flows come later. Either way the write is a git commit — the GitOps substrate." />
        </div>
      </Modal>

      <Toast toast={toast} icon={<GitCommitHorizontal className="h-4 w-4 text-brand-400" />} />
    </div>
  );
}

// Log-line helpers make the simulated run read like the real program.
function runningLine(n: WorkflowNode): string {
  if (n.kind === "start") return `[${n.key}] ▶ entry`;
  if (n.kind === "if") return `[${n.key}] if (${n.condition ?? "…"}) → true`;
  if (n.kind === "callScript") return `[${n.key}] → call ${n.call?.workflow ?? "script"} (${n.call?.standalone ? "standalone" : "in-project"})`;
  if (n.kind === "loop") return `[${n.key}] ↻ for each (${n.each ?? "input"}) → ${n.file ? n.file : `call ${n.call?.workflow ?? "script"}`}`;
  if (n.kind === "end") return `[${n.key}] ■ return`;
  return `[${n.key}] running…`;
}
function doneLine(n: WorkflowNode): string {
  if (n.kind === "start" || n.kind === "end" || n.kind === "if") return `[${n.key}] ✓`;
  if (n.kind === "callScript") return `[${n.key}] ✓ returned`;
  if (n.kind === "loop") return `[${n.key}] ✓ looped`;
  return `[${n.key}] ✓ succeeded`;
}

// ── Resizable split — drag the middle gutter to size canvas vs. inspector ─────
function ResizableSplit({ left, right, storageKey }: { left: ReactNode; right: ReactNode; storageKey: string }) {
  const MIN = 0.25, MAX = 0.8, DEFAULT = 0.66;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [frac, setFrac] = useState<number>(() => {
    const saved = typeof localStorage !== "undefined" ? Number(localStorage.getItem(storageKey)) : NaN;
    return saved >= MIN && saved <= MAX ? saved : DEFAULT;
  });
  const [dragging, setDragging] = useState(false);

  const onDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: MouseEvent) => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      const f = Math.min(MAX, Math.max(MIN, (ev.clientX - box.left) / box.width));
      setFrac(f);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setFrac((f) => { try { localStorage.setItem(storageKey, String(f)); } catch { /* ignore */ } return f; });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [storageKey]);

  const reset = useCallback(() => { setFrac(DEFAULT); try { localStorage.setItem(storageKey, String(DEFAULT)); } catch { /* ignore */ } }, [storageKey]);

  return (
    <div ref={containerRef} className="flex flex-col gap-4 lg:h-[460px] lg:flex-row lg:gap-0" data-testid="editor-split">
      <div className="min-h-[320px] lg:min-h-0" style={{ flexBasis: `${frac * 100}%` }}>{left}</div>
      {/* gutter (lg only): drag to resize, double-click to reset */}
      <div
        role="separator"
        aria-orientation="vertical"
        data-testid="split-gutter"
        onMouseDown={onDown}
        onDoubleClick={reset}
        title="Drag to resize · double-click to reset"
        className={`group hidden shrink-0 cursor-col-resize items-center justify-center lg:flex ${dragging ? "" : ""}`}
        style={{ width: 16 }}
      >
        <div className={`h-16 w-1 rounded-full transition-colors ${dragging ? "bg-brand-400" : "bg-white/15 group-hover:bg-brand-400/70"}`} />
      </div>
      <div className="min-h-[280px] lg:min-h-0 lg:flex-1">{right}</div>
    </div>
  );
}

// ── Component palette — tools you drag or click onto the canvas ───────────────
function Palette({ onAdd }: { onAdd: (kind: NodeKind) => void }) {
  return (
    <div className="card flex flex-wrap items-center gap-2 p-3" data-testid="palette">
      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
        Components
        <InfoTip text="Drag a component onto the canvas, or click it to drop one in — new nodes never land on top of existing ones. Then drag between node handles to wire edges. Loop = forEach over an array (body per item). Call Script runs another script as a step." />
      </span>
      {NODE_KINDS.map((k) => (
        <Tip key={k.kind} text={`${k.blurb} — drag onto the canvas or click to add.`}>
          <button
            type="button"
            data-testid={`palette-${k.kind}`}
            draggable
            onDragStart={(e) => { e.dataTransfer.setData(DND_MIME, k.kind); e.dataTransfer.effectAllowed = "move"; }}
            onClick={() => onAdd(k.kind)}
            className={`chip cursor-grab select-none border active:cursor-grabbing ${kindAccent[k.kind].border} ${kindAccent[k.kind].bg} ${kindAccent[k.kind].text}`}
          >
            <KindIcon kind={k.kind} className="h-3.5 w-3.5" />
            {k.label}
          </button>
        </Tip>
      ))}
    </div>
  );
}

// ── Node inspector (kind-aware) ──────────────────────────────────────────────
type InspectorProps = {
  selected: string | null;
  liveNodes: { id: string; data: Record<string, unknown> }[];
  workflow: Workflow;
  projectId: string;
  projectWorkflows: Workflow[];
  callTargets: { id: string; name: string }[];
  onEdit: (msg: string) => void;
  onApplyCode: (id: string, code: string) => void;
  onSetDeps: (id: string, deps: Record<string, string>) => void;
  onSetCall: (id: string, call: WorkflowNode["call"]) => void;
  onSetSchema: (id: string, which: "inputSchema" | "outputSchema", value: string) => void;
  onSetSql: (id: string, patch: Record<string, unknown>) => void;
};

function NodeInspector({ selected, liveNodes, workflow, projectId, projectWorkflows, callTargets, onEdit, onApplyCode, onSetDeps, onSetCall, onSetSchema, onSetSql }: InspectorProps) {
  const [tab, setTab] = useState<JsTab>("code");
  if (!selected) return <p className="mt-3 text-sm text-slate-500">Select a node in the graph.</p>;
  const mock = workflow.nodes.find((n) => n.key === selected);
  const live = liveNodes.find((n) => n.id === selected);
  const liveData = (live?.data ?? {}) as Record<string, unknown>;
  const kind = (mock?.kind ?? (liveData.kind as NodeKind) ?? "jscode") as NodeKind;
  const name = mock?.name ?? (liveData.label as string) ?? selected;
  const isNew = !mock;
  const jsCode = (liveData.code as string) ?? mock?.code ?? DEFAULT_JS;
  const jsFile = mock?.file ?? (liveData.filename as string) ?? `nodes/${selected}.js`;

  return (
    <div className="mt-3 flex-1">
      <div className="flex items-center gap-2">
        <span className={`chip ${kindAccent[kind].bg} ${kindAccent[kind].text}`}><KindIcon kind={kind} className="h-3 w-3" /> {kindLabel(kind)}</span>
        <span className="text-sm font-medium text-white">{name}</span>
      </div>
      {isNew && <p className="mt-1 text-[11px] text-amber-300/80">New node (draft) — configure it, then Save to commit.</p>}

      <div className="mt-3">
        {kind === "start" && <StartPanel node={mock} />}
        {kind === "end" && <EndPanel node={mock} />}
        {kind === "if" && <IfPanel node={mock} onEdit={onEdit} />}
        {kind === "callScript" && <CallPanel node={mock} liveCall={liveData.call as WorkflowNode["call"]} workflow={workflow} projectWorkflows={projectWorkflows} callTargets={callTargets} onSetCall={(call) => onSetCall(selected, call)} onEdit={onEdit} />}
        {kind === "jscode" && <JsPanel node={mock} file={jsFile} code={jsCode} tab={tab} setTab={setTab} onApply={(c) => onApplyCode(selected, c)}
          inputSchema={(liveData.inputSchema as string) ?? mock?.inputSchema ?? ""} outputSchema={(liveData.outputSchema as string) ?? mock?.outputSchema ?? ""} onSetSchema={(w, v) => onSetSchema(selected, w, v)} />}
        {kind === "sql" && <SqlPanel data={{ ...(mock ?? {}), ...liveData }} onSet={(patch) => onSetSql(selected, patch)} />}
        {kind === "loop" && (
          <LoopPanel
            node={mock}
            each={mock?.each ?? (liveData.each as string) ?? "input"}
            call={(mock?.call ?? (liveData.call as WorkflowNode["call"]))}
            file={jsFile}
            code={jsCode}
            hasFile={!!(mock?.file ?? liveData.filename)}
            workflow={workflow}
            projectWorkflows={projectWorkflows}
            callTargets={callTargets}
            tab={tab}
            setTab={setTab}
            onApply={(c) => onApplyCode(selected, c)}
            onSetCall={(call) => onSetCall(selected, call)}
            onSetSchema={(w, v) => onSetSchema(selected, w, v)}
            onEdit={onEdit}
          />
        )}
      </div>

      {/* External npm dependencies for JS Code / loop-body nodes. Prefer live (edited) data
          over the static loaded definition so edits render immediately. */}
      {(kind === "jscode" || kind === "loop") && (
        <DepsEditor deps={((liveData.deps as Record<string, string>) ?? mock?.deps) ?? {}} onChange={(d) => onSetDeps(selected, d)} />
      )}

      {/* Test this step in isolation with a supplied input (live mode only). */}
      {LIVE && kind !== "start" && kind !== "end" && (
        <StepTester projectId={projectId} workflow={workflow.id} nodeKey={selected} kind={kind} each={mock?.each ?? (liveData.each as string)} />
      )}
    </div>
  );
}

function DepsEditor({ deps, onChange }: { deps: Record<string, string>; onChange: (d: Record<string, string>) => void }) {
  const [name, setName] = useState("");
  const [ver, setVer] = useState("");
  const entries = Object.entries(deps);
  const add = () => {
    const n = name.trim();
    if (!n) return;
    onChange({ ...deps, [n]: ver.trim() || "latest" });
    setName(""); setVer("");
  };
  const remove = (k: string) => { const d = { ...deps }; delete d[k]; onChange(d); };
  return (
    <div className="mt-4 border-t border-white/10 pt-3" data-testid="deps-editor">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-300">
        <Boxes className="h-3.5 w-3.5 text-brand-300" /> Dependencies
        <InfoTip text="External npm packages this node imports. On Save, the controller installs them into the project so in-process AND isolated runs resolve them — and they're written into the exported bundle's package.json too." />
      </div>
      {entries.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" data-testid="deps-list">
          {entries.map(([k, v]) => (
            <span key={k} className="chip inline-flex items-center gap-1 bg-white/5 font-mono text-[10px] text-slate-300">
              {k}@{v}
              <button type="button" data-testid={`dep-remove-${k}`} onClick={() => remove(k)} className="text-slate-500 hover:text-rose-300">×</button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-slate-500">none — standard library only.</p>
      )}
      <div className="mt-2 flex gap-1.5">
        <input data-testid="dep-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="package" spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-ink-950/70 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-brand-500/50" />
        <input data-testid="dep-version" value={ver} onChange={(e) => setVer(e.target.value)} placeholder="^1.0.0" spellCheck={false}
          className="w-24 rounded-md border border-white/10 bg-ink-950/70 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-brand-500/50" />
        <button type="button" data-testid="dep-add" onClick={add} className="rounded-md bg-brand-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-500">Add</button>
      </div>
    </div>
  );
}

function StepTester({ projectId, workflow, nodeKey, kind, each }: { projectId: string; workflow: string; nodeKey: string; kind: NodeKind; each?: string }) {
  // Seed a sensible sample input per kind so the tester is one click away from useful.
  const sample = kind === "loop" ? (each && each !== "input" ? `{ "${each.replace(/^input\./, "")}": [1, 2, 3] }` : "[1, 2, 3]") : "{}";
  const [input, setInput] = useState(sample);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NodeTestResult | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  const test = async () => {
    let parsed: unknown;
    try { parsed = input.trim() ? JSON.parse(input) : {}; setParseErr(null); }
    catch (e) { setParseErr(e instanceof Error ? e.message : "invalid JSON"); return; }
    setBusy(true);
    try { setResult(await testNode(projectId, workflow, nodeKey, parsed)); }
    catch (e) { setResult({ status: "failed", node: nodeKey, kind, error: e instanceof Error ? e.message : String(e), logs: [], ms: 0 }); }
    finally { setBusy(false); }
  };

  return (
    <div className="mt-4 border-t border-white/10 pt-3" data-testid="step-tester">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-300">
        <Play className="h-3.5 w-3.5 text-emerald-300" /> Test this step
        <InfoTip text="Runs ONLY this node with the input you provide (no upstream steps). For a loop, pass the array (or the object the each-expression reads). Great for checking a step's output shape before wiring it." />
      </div>
      <textarea
        data-testid="step-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        spellCheck={false}
        rows={3}
        className="w-full rounded-lg border border-white/10 bg-ink-950/70 p-2 font-mono text-[11px] text-slate-200 outline-none focus:border-emerald-500/50"
      />
      {parseErr && <p className="mt-1 text-[11px] text-rose-300">input JSON error: {parseErr}</p>}
      <button
        type="button"
        data-testid="step-run"
        onClick={test}
        disabled={busy}
        className="mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
      >
        <Play className="h-3 w-3" /> {busy ? "Running…" : "Run step"}
      </button>
      {result && (
        <div className="mt-2 space-y-1" data-testid="step-result" data-status={result.status}>
          <div className={`text-[11px] font-medium ${result.status === "succeeded" ? "text-emerald-300" : "text-rose-300"}`}>
            {result.status === "succeeded" ? `✓ ${result.kind} · ${result.ms}ms` : `✗ ${result.error}`}
          </div>
          {result.status === "succeeded" && (
            <pre className="max-h-40 overflow-auto rounded-lg border border-white/10 bg-ink-950/70 p-2 font-mono text-[11px] text-slate-200" data-testid="step-output">{JSON.stringify(result.output, null, 2)}</pre>
          )}
          {result.logs?.filter((e) => e.type === "log").length > 0 && (
            <div className="rounded-lg border border-white/5 bg-ink-950/40 p-2 font-mono text-[10px] text-slate-400">
              {result.logs.filter((e) => e.type === "log").map((e, i) => (
                <div key={i}>[{e.level}] {e.message}{e.fields ? " " + JSON.stringify(e.fields) : ""}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function kindLabel(k: NodeKind) {
  return NODE_KINDS.find((x) => x.kind === k)?.label ?? k;
}

function StartPanel({ node }: { node?: WorkflowNode }) {
  return (
    <div className="space-y-3 text-xs" data-testid="panel-start">
      <p className="text-slate-400">The program entry point. The run’s input arrives here and flows to the first step.</p>
      <SchemaBox label="run input" value={node?.inputSchema ?? "any"} tip="The manual/cron/webhook payload. Compiles to the parameter of the generated main function." />
      <Note icon={<Play className="h-3.5 w-3.5 text-emerald-300" />}>Links to the compiled program’s entry (<span className="font-mono">index.js</span>). Exactly one Start per workflow.</Note>
    </div>
  );
}

function EndPanel({ node }: { node?: WorkflowNode }) {
  return (
    <div className="space-y-3 text-xs" data-testid="panel-end">
      <p className="text-slate-400">The exit clause — reached when no more execution is required. The program returns here.</p>
      <SchemaBox label="returns" value={node?.outputSchema ?? "void"} tip="Whatever the main function returns to the caller / trigger result." />
      <Note icon={<Flag className="h-3.5 w-3.5 text-slate-300" />}>A flow can have multiple End nodes (e.g. one per branch of an if).</Note>
    </div>
  );
}

function IfPanel({ node, onEdit }: { node?: WorkflowNode; onEdit: (m: string) => void }) {
  const [clauses, setClauses] = useState<IfClause[]>(
    node?.conditions ?? (node?.condition ? [{ expr: node.condition }] : [{ expr: "value === true" }]),
  );
  const update = (next: IfClause[]) => { setClauses(next); onEdit("Condition updated (draft)"); };
  const setExpr = (i: number, v: string) => update(clauses.map((c, idx) => (idx === i ? { ...c, expr: v } : c)));
  const setConn = (i: number, v: "and" | "or") => update(clauses.map((c, idx) => (idx === i ? { ...c, connector: v } : c)));
  const add = () => update([...clauses, { connector: "and", expr: "true" }]);
  const remove = (i: number) => update(clauses.length > 1 ? clauses.filter((_, idx) => idx !== i) : clauses);
  const compiled = compileCondition(clauses);

  return (
    <div className="space-y-3 text-xs" data-testid="panel-if">
      <p className="text-slate-400">A literal <span className="font-mono">if</span> in the main file — build a multi-conditional test; the two output handles route the flow.</p>
      <div className="space-y-1.5" data-testid="if-builder">
        {clauses.map((c, i) => (
          <div key={i} className="flex items-center gap-1.5">
            {i === 0 ? (
              <span className="w-12 shrink-0 text-right font-mono text-[10px] text-slate-500">if</span>
            ) : (
              <select className="inp w-12 shrink-0 px-1 py-1 text-[10px]" value={c.connector ?? "and"} onChange={(e) => setConn(i, e.target.value as "and" | "or")} data-testid={`if-connector-${i}`}>
                <option value="and">and</option>
                <option value="or">or</option>
              </select>
            )}
            <input className="inp font-mono text-xs" value={c.expr} onChange={(e) => setExpr(i, e.target.value)} data-testid={i === 0 ? "if-condition" : `if-clause-${i}`} />
            <button type="button" onClick={() => remove(i)} disabled={clauses.length === 1} aria-label="remove clause" className="shrink-0 rounded p-1 text-slate-500 hover:text-rose-300 disabled:opacity-30">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={add} data-testid="if-add-condition" className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/5">
        <Plus className="h-3 w-3" /> Add condition
      </button>
      <div className="rounded-lg border border-amber-400/20 bg-amber-500/5 p-2" data-testid="if-preview">
        <div className="text-[10px] text-slate-500">compiles to a literal if</div>
        <code className="font-mono text-[11px] text-amber-200">if ({compiled || "…"}) {"{"} … {"}"}</code>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2 py-1.5 text-emerald-300"><span className="font-semibold">true</span> → then-branch</div>
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-2 py-1.5 text-rose-300"><span className="font-semibold">false</span> → else-branch</div>
      </div>
      <Note icon={<Split className="h-3.5 w-3.5 text-amber-300" />}>Need a loop? Not yet a node — write it inside a JS Code step for now.</Note>
    </div>
  );
}

function CallPanel({ node, liveCall, workflow, projectWorkflows, callTargets, onSetCall, onEdit }: { node?: WorkflowNode; liveCall?: WorkflowNode["call"]; workflow: Workflow; projectWorkflows: Workflow[]; callTargets: { id: string; name: string }[]; onSetCall: (call: WorkflowNode["call"]) => void; onEdit: (m: string) => void }) {
  const call = liveCall ?? node?.call; // prefer live (edited) data so a new selection renders immediately
  // In-project targets: the live list (other workflows in this project), or the mock siblings.
  const siblings = callTargets.length ? callTargets : projectWorkflows.filter((w) => w.id !== workflow.id).map((w) => ({ id: w.id, name: w.name }));
  const currentValue = call?.standalone ? "__standalone__" : call?.workflow ? call.workflow : "";
  const onChange = (v: string) => {
    if (v === "__standalone__") onSetCall({ workflow: "", ref: "", standalone: true });
    else if (v) onSetCall({ workflow: v, ref: `workflows/${v}` }); // in-project call
    onEdit("Call target updated (draft) — Save to commit");
  };
  return (
    <div className="space-y-3 text-xs" data-testid="panel-callscript">
      <p className="text-slate-400">Invoke another script as a step. It runs like any other node — its output becomes this step’s output.</p>
      <label className="block">
        <div className="mb-1 flex items-center gap-1.5 text-slate-400">Target script <InfoTip text="Pick a workflow in this project, or reference a standalone/remote script. This is how you compose scripts and pull in remote components." /></div>
        <select className="inp" value={currentValue} onChange={(e) => onChange(e.target.value)} data-testid="call-target">
          <option value="" disabled>Select a workflow…</option>
          <optgroup label="This project">
            {siblings.length ? siblings.map((w) => <option key={w.id} value={w.id}>{w.name}</option>) : <option value="" disabled>(no other workflows)</option>}
          </optgroup>
          <optgroup label="Other / remote">
            <option value="__standalone__">Standalone / remote script…</option>
          </optgroup>
        </select>
      </label>
      {call?.standalone && (
        <div className="space-y-2 rounded-lg border border-cyan-400/20 bg-cyan-500/[0.04] p-2" data-testid="standalone-fields">
          <label className="block">
            <div className="mb-1 text-[11px] text-slate-400">Bundle ref <InfoTip text="A Mill export bundle: an https:// URL to a .tgz, or std://<path>@<version> resolved against MILL_STD_REGISTRY. It's fetched, cached, and run (run.sh installs its deps)." /></div>
            <input data-testid="call-ref" className="inp font-mono text-[11px]" placeholder="std://acme/notify@v2  or  https://…/bundle.tgz" value={call.ref ?? ""}
              onChange={(e) => onSetCall({ workflow: call.workflow ?? "", ref: e.target.value, standalone: true })} />
          </label>
          <label className="block">
            <div className="mb-1 text-[11px] text-slate-400">Workflow in the bundle</div>
            <input data-testid="call-workflow" className="inp font-mono text-[11px]" placeholder="e.g. notify" value={call.workflow ?? ""}
              onChange={(e) => onSetCall({ workflow: e.target.value, ref: call.ref ?? "", standalone: true })} />
          </label>
        </div>
      )}
      {call && (call.workflow || call.standalone) && (
        <div className="rounded-lg border border-white/5 bg-ink-950/50 p-2" data-testid="call-summary">
          <div className="flex items-center gap-2">
            <span className="font-mono text-cyanx">{call.workflow || "(pick a workflow)"}</span>
            <span className={`chip px-1.5 py-0 text-[10px] ${call.standalone ? "bg-cyan-500/15 text-cyanx" : "bg-white/5 text-slate-400"}`}>
              {call.standalone ? "standalone / remote" : call.project ? `project: ${call.project}` : "in-project"}
            </span>
          </div>
          <div className="mt-1 font-mono text-[10px] text-slate-500">ref: {call.ref || "—"}</div>
        </div>
      )}
      <Note icon={<KindIcon kind="callScript" className="h-3.5 w-3.5 text-cyanx" />}>Same-project calls resolve inside the repo; standalone/remote calls fetch a versioned bundle by ref.</Note>
    </div>
  );
}

type JsTab = "code" | "schema" | "context" | "isolation";
function JsPanel({ node, file, code, tab, setTab, onApply, inputSchema, outputSchema, onSetSchema }: { node?: WorkflowNode; file: string; code: string; tab: JsTab; setTab: (t: JsTab) => void; onApply: (code: string) => void; inputSchema: string; outputSchema: string; onSetSchema: (which: "inputSchema" | "outputSchema", value: string) => void }) {
  return (
    <div>
      <div className="mt-1 flex flex-wrap gap-1" data-testid="inspector-tabs">
        {(["code", "schema", "context", "isolation"] as JsTab[]).map((t) => (
          <button key={t} data-testid={`tab-${t}`} data-active={tab === t} onClick={() => setTab(t)}
            className={`chip capitalize ${tab === t ? "bg-brand-500/20 text-brand-200" : "bg-white/5 text-slate-400 hover:text-slate-200"}`}>{t}</button>
        ))}
      </div>
      <div className="mt-3">
        {tab === "code" && (
          <div className="space-y-3">
            <JsEditor filename={file} value={code} onApply={onApply} />
            <p className="text-[11px] text-slate-500">External npm packages are managed in the <span className="text-slate-300">Dependencies</span> panel below.</p>
          </div>
        )}
        {tab === "schema" && (
          <div className="space-y-3 text-xs" data-testid="tab-panel-schema">
            <p className="text-[11px] text-slate-500">A JS boolean expression, <strong>enforced at runtime</strong>. Input checked before the node runs (over <span className="font-mono">input</span>); output after (over <span className="font-mono">output</span>). A falsy result fails the node. Leave blank to skip.</p>
            <SchemaEdit label="inputSchema" placeholder="e.g. Array.isArray(input.items)" value={inputSchema} onChange={(v) => onSetSchema("inputSchema", v)} />
            <SchemaEdit label="outputSchema" placeholder="e.g. typeof output.total === 'number'" value={outputSchema} onChange={(v) => onSetSchema("outputSchema", v)} />
            <div className="rounded-lg border border-white/5 bg-ink-950/40 p-2 text-slate-500"><span className="font-medium text-slate-400">Fan-in:</span> a node with multiple parents reads <span className="font-mono text-slate-300">ctx.inputs[nodeKey]</span>.</div>
          </div>
        )}
        {tab === "context" && (
          <div className="space-y-2 text-xs" data-testid="tab-panel-context">
            <p className="text-slate-500">The Mill SDK surface passed as <span className="font-mono text-slate-300">ctx</span> (autocompletes in the editor):</p>
            <CtxRow sym="ctx.log" desc="structured logging → Redis (live) + Loki (durable)" />
            <CtxRow sym="ctx.secrets" desc="injected by ref; scrubbed from logs; never in git" />
            <CtxRow sym="ctx.inputs" desc="upstream outputs by node key (fan-in)" />
            <CtxRow sym="ctx.state" desc="node-boundary journal (retries skip completed nodes)" />
            <CtxRow sym="ctx.http / ctx.db" desc="IO helpers" />
            {node?.secrets && node.secrets.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 flex items-center gap-1.5 text-slate-400"><KeyRound className="h-3.5 w-3.5" /> Secret refs used</div>
                <div className="flex flex-wrap gap-1.5" data-testid="node-secrets">
                  {node.secrets.map((s) => <span key={s} className="chip bg-amber-500/10 font-mono text-amber-200">{s}</span>)}
                </div>
              </div>
            )}
          </div>
        )}
        {tab === "isolation" && (
          <div className="space-y-3 text-xs" data-testid="tab-panel-isolation">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              <span className="font-mono text-slate-200">{exLabel(node?.executor ?? "container")}</span>
              <InfoTip text="OS-level isolation, ON by default (the hardened Docker container executor today). The compiler emits pure per-node functions so swapping executor rungs is a drop-in." />
            </div>
            {node?.limits && (
              <div className="grid grid-cols-2 gap-2">
                <LimitBox icon={<Cpu className="h-3.5 w-3.5" />} label="memory" value={`${node.limits.memMB} MB`} />
                <LimitBox icon={<Clock className="h-3.5 w-3.5" />} label="cpu" value={`${(node.limits.cpuMs / 1000).toFixed(0)}s`} />
                <LimitBox icon={<Clock className="h-3.5 w-3.5" />} label="wall clock" value={`${(node.limits.wallMs / 1000).toFixed(0)}s`} />
                <LimitBox icon={<Webhook className="h-3.5 w-3.5" />} label="network" value={node.limits.network} />
              </div>
            )}
            <p className="text-slate-500">Enforced per-job: a hungry child is killed, never the pod. Timeout taxonomy: schedule-to-start / start-to-close / heartbeat.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function LoopPanel({ node, each, call, file, code, hasFile, workflow, projectWorkflows, callTargets, tab, setTab, onApply, onSetCall, onSetSchema, onEdit }: {
  node?: WorkflowNode; each: string; call?: WorkflowNode["call"]; file: string; code: string; hasFile: boolean;
  workflow: Workflow; projectWorkflows: Workflow[]; callTargets: { id: string; name: string }[]; tab: JsTab; setTab: (t: JsTab) => void; onApply: (code: string) => void; onSetCall: (call: WorkflowNode["call"]) => void; onSetSchema: (which: "inputSchema" | "outputSchema", value: string) => void; onEdit: (m: string) => void;
}) {
  // A loop body is a per-item JS Code file (hasFile) OR a per-item Call Script.
  const isCall = !hasFile && !!call?.workflow;
  return (
    <div className="space-y-3" data-testid="panel-loop">
      <label className="block">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-300">
          Iterate <span className="font-normal text-slate-500">· each item of this array</span>
          <InfoTip text="A JS expression over `input` (the previous node's output) that yields an array. Omit to iterate the upstream output directly. e.g. input.urls" />
        </div>
        <input
          data-testid="loop-each"
          defaultValue={each}
          onBlur={(e) => onEdit(`each = ${e.target.value} (draft)`)}
          className="w-full rounded-lg border border-white/10 bg-ink-950/70 p-2 font-mono text-xs text-slate-200 outline-none focus:border-fuchsia-500/60"
        />
        <p className="mt-1 text-[11px] text-slate-500">Runs the body once per item, in order. <span className="font-mono">ctx.state.index</span> is the position; <span className="font-mono">ctx.state</span> carries across items.</p>
      </label>

      <div className="rounded-lg border border-white/10 bg-ink-950/40 p-2 text-[11px] text-slate-400">
        Body per item: <span className="font-mono text-fuchsia-200">{isCall ? `call ${call?.workflow}` : (file || "nodes/…js")}</span>
        <span className="ml-1 chip bg-white/5 px-1.5 py-0 text-[9px] text-slate-400">{isCall ? "Call Script" : "JS Code"}</span>
      </div>

      {isCall
        ? <CallPanel node={node} liveCall={call} workflow={workflow} projectWorkflows={projectWorkflows} callTargets={callTargets} onSetCall={onSetCall} onEdit={onEdit} />
        : <JsPanel node={node} file={file} code={code} tab={tab} setTab={setTab} onApply={onApply}
            inputSchema={node?.inputSchema ?? ""} outputSchema={node?.outputSchema ?? ""} onSetSchema={onSetSchema} />}
    </div>
  );
}

function Note({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <div className="flex items-start gap-2 rounded-lg border border-white/5 bg-ink-950/40 p-2 text-[11px] text-slate-400">{icon}<span>{children}</span></div>;
}
function exLabel(e: string) {
  return {
    "in-process": "InProcessExecutor", inprocess: "InProcessExecutor",
    container: "DockerExecutor (container)", docker: "DockerExecutor (container)",
    nsjail: "NsjailProcessExecutor", gvisor: "GvisorExecutor", firecracker: "FirecrackerExecutor", k8sjob: "K8sJobExecutor",
  }[e] ?? e;
}
function SchemaBox({ label, value, tip }: { label: string; value: string; tip: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-slate-400">{label} <InfoTip text={tip} /></div>
      <pre className="overflow-x-auto rounded-lg border border-white/5 bg-ink-950/60 p-2 font-mono text-[11px] text-slate-300">{value}</pre>
    </div>
  );
}
function SchemaEdit({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <div className="mb-1 font-mono text-[11px] text-slate-400">{label}</div>
      <input
        data-testid={`schema-${label}`}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-ink-950/70 p-2 font-mono text-[11px] text-slate-200 outline-none focus:border-brand-500/50"
      />
    </label>
  );
}
function CtxRow({ sym, desc }: { sym: string; desc: string }) {
  return <div className="flex items-baseline gap-2"><span className="font-mono text-slate-200">{sym}</span><span className="text-slate-500">— {desc}</span></div>;
}
function LimitBox({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-ink-950/50 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-slate-500">{icon}{label}</div>
      <div className="mt-0.5 font-mono text-slate-200">{value}</div>
    </div>
  );
}

// ── Triggers panel ───────────────────────────────────────────────────────────
function TriggerIcon({ type }: { type: string }) {
  return type === "cron" ? <Clock className="h-3.5 w-3.5" /> : type === "webhook" ? <Webhook className="h-3.5 w-3.5" /> : type === "event" ? <Zap className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />;
}

// SQL node inspector (v1: postgres). Edit the connection secret, the $1..$n query, how params
// bind (per-placeholder expressions or a whole-item passthrough), and single vs per-item mode.
function SqlPanel({ data, onSet }: { data: Record<string, unknown>; onSet: (patch: Record<string, unknown>) => void }) {
  const connection = (data.connection as string) ?? "DATABASE_URL";
  const query = (data.query as string) ?? "";
  const mode = ((data.mode as string) ?? "single") as "single" | "each";
  const params = (data.params as string[]) ?? [];
  const paramsFrom = (data.paramsFrom as string) ?? "";
  const usePF = !!paramsFrom;
  const each = (data.each as string) ?? "input";
  const transaction = !!data.transaction;
  const timeoutMs = data.timeoutMs as number | undefined;
  const lbl = "mb-1 block text-xs font-medium text-slate-300";

  return (
    <div className="space-y-3 text-xs" data-testid="sql-panel">
      <div>
        <label className={lbl}>Connection <InfoTip text="A secret ref holding a postgres:// URL. Resolves through global → project → workflow scopes (Secrets page). Auto-declared, so the node sees it in ctx.secrets." /></label>
        <input className="inp !py-1 w-full font-mono text-[11px]" data-testid="sql-connection" value={connection} onChange={(e) => onSet({ connection: e.target.value })} placeholder="DATABASE_URL" spellCheck={false} />
      </div>

      <div>
        <label className={lbl}>Query <InfoTip text="Use $1..$n placeholders — values are bound server-side (never string-interpolated). An array-valued param binds as a Postgres array, e.g. WHERE id = ANY($1)." /></label>
        <textarea className="inp w-full font-mono text-[11px] leading-relaxed" data-testid="sql-query" rows={5} value={query} onChange={(e) => onSet({ query: e.target.value })} placeholder="select id, email from users where org_id = $1" spellCheck={false} />
      </div>

      <div>
        <label className={lbl}>Run mode</label>
        <select className="inp !w-auto !py-1 text-xs" data-testid="sql-mode" value={mode} onChange={(e) => onSet({ mode: e.target.value })}>
          <option value="single">single — one query</option>
          <option value="each">for each item</option>
        </select>
      </div>

      {mode === "each" && (
        <div className="space-y-2 rounded-lg border border-white/5 bg-ink-950/40 p-2">
          <div>
            <label className={lbl}>Iterate (array expression) <InfoTip text="A JS expression over `input`/`ctx` yielding the array to loop. Each element is `item` (with `index`) in the param expressions below." /></label>
            <input className="inp !py-1 w-full font-mono text-[11px]" data-testid="sql-each" value={each} onChange={(e) => onSet({ each: e.target.value })} placeholder="input.rows" spellCheck={false} />
          </div>
          <label className="flex items-center gap-2 text-[11px] text-slate-300">
            <input type="checkbox" data-testid="sql-transaction" checked={transaction} onChange={(e) => onSet({ transaction: e.target.checked })} />
            Wrap the batch in one transaction (all-or-nothing)
          </label>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between">
          <label className={lbl}>Parameters ($1..$n)</label>
          <label className="flex items-center gap-1.5 text-[10px] text-slate-400">
            <input type="checkbox" data-testid="sql-usepf" checked={usePF}
              onChange={(e) => onSet(e.target.checked ? { paramsFrom: mode === "each" ? "item" : "input", params: undefined } : { paramsFrom: undefined, params: params.length ? params : [""] })} />
            whole item/array as params
          </label>
        </div>
        {usePF ? (
          <>
            <input className="inp !py-1 w-full font-mono text-[11px]" data-testid="sql-paramsfrom" value={paramsFrom} onChange={(e) => onSet({ paramsFrom: e.target.value })} placeholder="item" spellCheck={false} />
            <p className="mt-1 text-[10px] text-slate-500">The expression must yield the whole ordered array [$1, $2, …].</p>
          </>
        ) : (
          <div className="space-y-1" data-testid="sql-params">
            {params.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="w-6 shrink-0 font-mono text-[10px] text-indigo-300">${i + 1}</span>
                <input className="inp !py-1 flex-1 font-mono text-[11px]" data-testid={`sql-param-${i}`} value={p} onChange={(e) => onSet({ params: params.map((x, j) => (j === i ? e.target.value : x)) })} placeholder={mode === "each" ? "item.col" : "input.x"} spellCheck={false} />
                <button type="button" className="rounded p-1 text-slate-500 hover:text-rose-300" data-testid={`sql-param-rm-${i}`} onClick={() => onSet({ params: params.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            <button type="button" className="btn-ghost text-[11px]" data-testid="sql-param-add" onClick={() => onSet({ params: [...params, ""] })}><Plus className="h-3.5 w-3.5" /> add param</button>
          </div>
        )}
      </div>

      <div>
        <label className={lbl}>Statement timeout (ms, optional)</label>
        <input className="inp !py-1 !w-32 font-mono text-[11px]" data-testid="sql-timeout" type="number" min={0} value={timeoutMs ?? ""} onChange={(e) => onSet({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })} placeholder="30000" />
      </div>

      <p className="rounded-lg border border-white/5 bg-ink-950/40 px-2 py-1.5 text-[10px] text-slate-500">
        Output to the next step: <span className="font-mono text-slate-400">{mode === "each" ? "{ results: [{ item, rows, rowCount }], rowCount }" : "{ rows, rowCount, command, fields }"}</span>
      </p>
    </div>
  );
}

// Cron sub-editor: quick-pick presets, live validation, and a preview of the next N fire times
// (croner — the same engine the controller schedules with, so this preview == reality on Save).
function CronEditor({ value, onChange, index }: { value: string; onChange: (v: string) => void; index: number }) {
  const [showAll, setShowAll] = useState(false);
  const err = cronError(value);
  const runs = err ? [] : nextRuns(value, showAll ? 10 : 5);
  // Render in UTC to match the controller's schedule exactly (see nextRuns). A user in another
  // timezone thus sees the true fire time, not a locally-shifted one.
  const fmt = (d: Date) => d.toLocaleString(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <div className="mt-2 space-y-1.5 pl-6" data-testid={`cron-editor-${index}`}>
      <div className="flex flex-wrap gap-1">
        {CRON_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            title={p.value}
            onClick={() => onChange(p.value)}
            className={`chip text-[10px] ${value.trim() === p.value ? "bg-brand-500/20 text-brand-200" : "bg-white/5 text-slate-400 hover:text-slate-200"}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {err ? (
        <div className="flex items-start gap-1.5 text-[11px] text-rose-300" data-testid={`cron-error-${index}`}>
          <AlertCircle className="mt-px h-3 w-3 shrink-0" />
          <span>{err}</span>
        </div>
      ) : (
        <div data-testid={`cron-preview-${index}`}>
          <div className="flex items-center gap-1.5 text-[10px] text-emerald-300/90">
            <CheckCircle2 className="h-3 w-3" />
            <span>Next {runs.length} run{runs.length === 1 ? "" : "s"} · times in UTC (the controller's timezone)</span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {runs.map((d, k) => (
              <li key={k} className="flex items-center gap-2 font-mono text-[11px] text-slate-300">
                <Clock className="h-3 w-3 shrink-0 text-slate-500" />
                <span className="tabular-nums">{fmt(d)} UTC</span>
                <span className="text-slate-500">· {untilLabel(d)}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="mt-1 text-[10px] text-brand-300 hover:text-brand-200" onClick={() => setShowAll((s) => !s)} data-testid={`cron-toggle-${index}`}>
            {showAll ? "show next 5" : "show next 10"}
          </button>
        </div>
      )}
    </div>
  );
}

function TriggersPanel({ triggers, setTriggers, exclusive, setExclusive, inputSchema, setInputSchema, workflow, projectId, publicBaseUrl, onCopy }: { triggers: EditTrigger[]; setTriggers: (t: EditTrigger[]) => void; exclusive: boolean; setExclusive: (v: boolean) => void; inputSchema: string; setInputSchema: (v: string) => void; workflow: string; projectId: string; publicBaseUrl?: string | null; onCopy: (url: string) => void }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const base = publicBaseUrl || origin; // public /p ingress host if configured, else this origin
  // A webhook trigger's URL: a long custom path is a capability URL (public, no bearer); a short
  // or empty path falls back to the default project path (bearer required).
  const urlFor = (t: EditTrigger) => `${base}/p/w/${workflow}/${(t.path && t.path.length > 0) ? t.path : projectId}`;
  const isPublic = (t: EditTrigger) => !!t.path && t.path.length >= 24;
  const update = (i: number, patch: Partial<EditTrigger>) => setTriggers(triggers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const remove = (i: number) => setTriggers(triggers.filter((_, j) => j !== i));
  const add = () => setTriggers([...triggers, { type: "manual" }]);
  return (
    <div className="card p-4" data-testid="triggers-panel">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        Triggers <InfoTip text="How runs start. Change a trigger's type, add a cron schedule, or a webhook path. Save commits it to workflow.yaml and the reconciler registers it (a cron then fires on schedule)." /> <Spec doc="ARCH §8" />
      </h2>
      <div className="mt-3 space-y-2" data-testid="triggers-list">
        {triggers.map((t, i) => (
          <div key={i} className="rounded-lg border border-white/5 bg-ink-950/40 p-2 text-xs" data-testid={`trigger-${i}`}>
            <div className="flex items-center gap-2">
              <TriggerIcon type={t.type} />
              <select className="inp !w-auto !py-1 text-xs" data-testid={`trigger-type-${i}`} value={t.type} onChange={(e) => update(i, { type: e.target.value as EditTrigger["type"] })}>
                <option value="manual">manual</option>
                <option value="cron">cron</option>
                <option value="webhook">webhook</option>
                <option value="event">event</option>
              </select>
              {t.type === "cron" && (
                <>
                  <input className={`inp !py-1 flex-1 font-mono text-[11px] ${cronError(t.schedule ?? "") ? "!border-rose-500/60 focus:!border-rose-500" : (t.schedule ?? "").trim() ? "!border-emerald-500/40" : ""}`} data-testid={`trigger-schedule-${i}`} placeholder="* * * * *  (e.g. 0 9 * * 1-5)" value={t.schedule ?? ""} onChange={(e) => update(i, { schedule: e.target.value })} spellCheck={false} />
                  <InfoTip text="Standard cron (min hour dom mon dow), or a 6-field with seconds. e.g. '*/30 * * * * *' = every 30s. Fires in the controller's timezone (UTC on staging)." />
                </>
              )}
              {t.type === "webhook" && (
                <input className="inp !py-1 flex-1 font-mono text-[11px]" data-testid={`trigger-path-${i}`} placeholder="custom path (optional)" value={t.path ?? ""} onChange={(e) => update(i, { path: e.target.value })} />
              )}
              <button type="button" className="rounded p-1 text-slate-500 hover:text-rose-300" data-testid={`trigger-remove-${i}`} onClick={() => remove(i)} title="Remove trigger"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
            {t.type === "cron" && <CronEditor value={t.schedule ?? ""} onChange={(v) => update(i, { schedule: v })} index={i} />}
            {t.type === "webhook" && (
              <div className="mt-1.5 flex items-center gap-2 pl-6">
                <span className={`chip shrink-0 ${isPublic(t) ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-500/15 text-slate-400"}`}>{isPublic(t) ? "no token" : "bearer"}</span>
                <span className="truncate font-mono text-[10px] text-slate-500">{urlFor(t)}</span>
                <button className="chip shrink-0 bg-white/5 text-slate-400 hover:text-slate-200" onClick={() => onCopy(urlFor(t))} data-testid="copy-webhook"><Copy className="h-3 w-3" /> copy URL</button>
              </div>
            )}
          </div>
        ))}
        <button type="button" className="btn-ghost text-xs" data-testid="add-trigger" onClick={add}><Plus className="h-3.5 w-3.5" /> Add trigger</button>
        <p className="text-[11px] text-slate-500">Changes commit on <strong>Save</strong>; the reconciler then (de)registers cron/webhook triggers.</p>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-white/5 pt-3 text-xs" data-testid="exclusive-toggle">
        <input type="checkbox" className="mt-0.5" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} data-testid="exclusive-checkbox" />
        <span>
          <span className="font-medium text-slate-200">Run exclusively</span>
          <InfoTip text="The worker/pod that picks up this run takes NO other jobs until it finishes — the whole pod is dedicated to it. Best for heavy or CPU/memory-hungry runs. With queue-depth autoscaling, an exclusive job pulls up a fresh pod that dedicates itself." />
          <span className="block text-[11px] text-slate-500">Dedicate a whole worker pod to each run (no co-tenant jobs).</span>
        </span>
      </label>
      <div className="mt-3 border-t border-white/5 pt-3" data-testid="input-schema-field">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-200">
          Run input schema
          <InfoTip text="A JS boolean expression over `input`, validated against the whole run payload BEFORE the first node runs — rejects malformed webhook/manual/cron inputs at the boundary. Leave blank to accept any input. e.g. typeof input.email === 'string' && Array.isArray(input.items)" />
        </div>
        <input
          className="inp !py-1 w-full font-mono text-[11px]"
          data-testid="input-schema-input"
          placeholder="(optional) e.g. typeof input.id === 'number'"
          value={inputSchema}
          onChange={(e) => setInputSchema(e.target.value)}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

// ── Observability panel ──────────────────────────────────────────────────────
function ObservabilityPanel({ onOpen }: { onOpen: (dest: string) => void }) {
  const [m, setM] = useState<import("../lib/api").FleetData | null>(null);
  useEffect(() => {
    if (!LIVE) return;
    let on = true;
    const load = () => getFleet().then((d) => { if (on) setM(d); }).catch(() => {});
    load(); const t = setInterval(load, 5000);
    return () => { on = false; clearInterval(t); };
  }, []);
  const stat = (label: string, value: string) => (
    <div className="rounded-lg border border-white/5 bg-ink-950/40 p-2">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-slate-200">{value}</div>
    </div>
  );
  return (
    <div className="card p-4" data-testid="observability-panel">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        <AreaChart className="h-4 w-4 text-slate-400" /> Observability
        {LIVE && m && <span className="chip bg-emerald-500/15 text-[10px] text-emerald-300">live metrics</span>}
        <InfoTip text="Live metrics come from GET /api/metrics (Prometheus format). Logs are structured JSON (Loki-ready). In production Alloy scrapes /metrics + tails logs → Prometheus/Loki/Tempo, visualized in Grafana." />
        <Spec doc="ARCH §3.6" />
      </h2>
      {LIVE && m ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="obs-metrics">
          {stat("queue depth", String(m.queueDepth))}
          {stat("throughput/min", String(m.stats.throughputPerMin))}
          {stat("p50 / p95", `${m.stats.p50Ms} / ${m.stats.p95Ms}ms`)}
          {stat("success", `${m.stats.successRatePct}%`)}
          {stat("completed/hr", String(m.stats.completedLastHour))}
          {stat("workers", String(m.workers.length))}
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
          {["queue depth", "job rate", "p95 duration", "workers", "sync rate"].map((x) => <span key={x} className="chip bg-white/5 text-slate-400">{x}</span>)}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <a className="btn-ghost text-xs" href="/api/metrics" target="_blank" rel="noreferrer" data-testid="open-metrics">Raw /metrics</a>
        {["Grafana", "Loki logs", "Tempo trace"].map((d) => (
          <button key={d} className="btn-ghost text-xs" onClick={() => onOpen(d)} data-testid={`open-${d.split(" ")[0].toLowerCase()}`}>{d}</button>
        ))}
      </div>
    </div>
  );
}
function SpanBar({ label, w, ml }: { label: string; w: string; ml: string }) {
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-16 shrink-0 font-mono text-slate-500">{label}</span>
      <div className="relative h-3 flex-1 rounded bg-white/5">
        <div className="absolute h-3 rounded bg-brand-500/60" style={{ width: w, marginLeft: ml }} />
      </div>
    </div>
  );
}

// ── Run detail + retry ───────────────────────────────────────────────────────
function RunDetail({ run, onRetry }: { run: RunRecord; onRetry: (node: string) => void }) {
  const max = Math.max(1, ...run.nodeTimings.map((t) => t.ms));
  return (
    <div className="rounded-lg border border-white/5 bg-ink-950/40 p-3" data-testid="run-detail">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-2"><StatusPill status={run.status} /><span className="font-mono text-slate-400">{run.id}</span></span>
        <div className="flex items-center gap-2">
          <span className="text-slate-500">{run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}</span>
          <button className="btn-ghost !py-1 text-xs" data-testid="rerun-btn" onClick={() => onRetry(run.error?.node ?? "")}>
            <RotateCcw className="h-3.5 w-3.5" /> Re-run
          </button>
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        {run.nodeTimings.map((t) => (
          <div key={t.key} className="flex items-center gap-2 text-[11px]">
            <span className="w-20 shrink-0 font-mono text-slate-400">{t.key}</span>
            <div className="relative h-3 flex-1 rounded bg-white/5">
              <div className={`h-3 rounded ${t.status === "failed" ? "bg-rose-500/60" : t.status === "running" ? "bg-sky-500/60" : t.status === "idle" ? "bg-white/10" : "bg-emerald-500/50"}`} style={{ width: `${Math.max(6, (t.ms / max) * 100)}%` }} />
            </div>
            <span className="w-10 shrink-0 text-right font-mono text-slate-600">{t.ms ? `${t.ms}ms` : "—"}</span>
          </div>
        ))}
      </div>
      {run.error && (
        <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/[0.06] p-2 text-xs" data-testid="failure-inspection">
          <div className="font-medium text-rose-200">Failed at node “{run.error.node}”</div>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-rose-200/70">{run.error.message}</pre>
          <div className="mt-2 flex items-center gap-2">
            <button className="btn-ghost text-xs" data-testid="retry-btn" onClick={() => onRetry(run.error!.node)}>
              <RotateCcw className="h-3.5 w-3.5" /> Retry from “{run.error.node}”
            </button>
            <InfoTip text="Two retry tiers: per-node backoff+jitter+condition, and a run-level retry that survives worker death. Node-boundary journaling means retries skip already-completed nodes." />
          </div>
        </div>
      )}
    </div>
  );
}
