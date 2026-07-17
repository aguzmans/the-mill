// Mock domain data for the Mill prototype.
// Shapes mirror docs/ARCHITECTURE.md so this evolves into the real app:
// a project is a git repo; a workflow is a DAG of typed nodes with GitOps sync/health.
//
// This is a *presentational* prototype: the data below is static and hand-authored
// to faithfully represent every feature in ARCHITECTURE.md / ROADMAP.md for a design
// review. Interactions are visual (modals/drawers/toasts), not a live backend.

export type SyncStatus = "Synced" | "OutOfSync";
export type Health = "Healthy" | "Progressing" | "Degraded";
export type NodeStatus = "idle" | "queued" | "running" | "succeeded" | "failed";
export type TriggerType = "cron" | "webhook" | "manual" | "event";
export type ConcurrencyPolicy = "Allow" | "Forbid" | "Replace";

/** The isolation ladder from ARCHITECTURE §6 — nsjail is the ON-by-default hot path. */
export type ExecutorTier = "nsjail" | "gvisor" | "firecracker" | "k8sjob";

/**
 * A workflow is a real program drawn as a flow graph. Each node is one of five
 * component kinds (more — loops etc. — come later; for now, loop inside a script):
 *  - start      — the program entry point; receives the run input.
 *  - jscode     — a step backed by its own .js file, loaded by the main program.
 *  - if         — a literal `if` in the main file; branches the flow (true/false).
 *  - callScript — invoke another script as a step (same project OR standalone/remote).
 *  - end        — the exit clause; the flow returns when no more work remains.
 */
export type NodeKind = "start" | "jscode" | "if" | "callScript" | "loop" | "end";

/** One clause of an `if` condition; clauses after the first carry a connector. */
export interface IfClause {
  connector?: "and" | "or"; // undefined on the first clause
  expr: string; // a JS boolean expression, e.g. "invoices.length > 0"
}

/** Compile clauses into the boolean expression the `if` node evaluates. */
export function compileCondition(clauses: IfClause[]): string {
  return clauses
    .map((c, i) => (i === 0 ? "" : c.connector === "or" ? " || " : " && ") + c.expr)
    .join("");
}

/** Palette metadata — drives the drag-and-drop component tray + inspector copy. */
export const NODE_KINDS: { kind: NodeKind; label: string; blurb: string }[] = [
  { kind: "start", label: "Start", blurb: "Program entry point — where the flow begins and receives its input. Links to the compiled program's entry." },
  { kind: "jscode", label: "JS Code", blurb: "A step backed by its own .js file, loaded by the main program. Write anything here — including a loop." },
  { kind: "if", label: "If", blurb: "A literal `if` in the main file — branches the flow on a condition into a true and a false path." },
  { kind: "callScript", label: "Call Script", blurb: "Invoke another script as a step. The target can live in this project or be a standalone/remote script." },
  { kind: "loop", label: "Loop", blurb: "forEach over an array (from the previous node) — runs a body per item and collects the results. The body is a JS Code file or a Call Script; iterations run in order and share ctx.state." },
  { kind: "end", label: "End", blurb: "Exit clause — the flow returns when no more execution is required." },
];

export interface Trigger {
  type: TriggerType;
  detail: string; // e.g. "0 2 * * *" or "/hooks/invoices"
  nextRun?: string; // human label, cron only
  enabled?: boolean;
  concurrencyPolicy?: ConcurrencyPolicy; // per k8s CronJob semantics
}

/** Per-node resource ceiling enforced by the Executor (ARCHITECTURE §6). */
export interface Limits {
  memMB: number;
  cpuMs: number;
  wallMs: number;
  network: "none" | "egress-allowlist" | "full";
}

/** Target of a callScript node — another workflow, in-project or standalone/remote. */
export interface CallTarget {
  workflow: string; // display name of the called script
  ref: string; // path/URL reference committed in git
  project?: string; // set when the call is to a script in a (possibly other) project
  standalone?: boolean; // true = a standalone/remote script, not a project workflow
}

export interface WorkflowNode {
  key: string;
  kind: NodeKind;
  name: string;
  position: { x: number; y: number };
  // jscode only:
  file?: string;
  code?: string;
  deps?: Record<string, string>;
  inputSchema?: string;
  outputSchema?: string;
  secrets?: string[]; // secret *refs* only — values never in git (§10)
  limits?: Limits;
  executor?: ExecutorTier;
  // if only:
  condition?: string; // compiled display string
  conditions?: IfClause[]; // the multi-conditional clauses (source of truth)
  // callScript only:
  call?: CallTarget;
  // loop only: JS expression selecting the array to iterate (body is `file` or `call`).
  each?: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** For edges leaving an `if` node: which branch this edge is. */
  branch?: "true" | "false";
  /** Argo-style status expression; absent = plain predecessor edge (§10). */
  depends?: string;
}

/** One past execution — Mill keeps no DB; this is the Redis `recent:` + Loki view. */
export interface RunRecord {
  id: string;
  status: NodeStatus; // succeeded | failed | running
  trigger: TriggerType;
  revision: string;
  startedAt: string; // relative label, e.g. "2h ago"
  durationMs: number;
  nodeTimings: { key: string; status: NodeStatus; ms: number }[];
  error?: { node: string; message: string };
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  sync: SyncStatus;
  health: Health;
  lastRun: NodeStatus;
  triggers: Trigger[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  concurrencyPolicy?: ConcurrencyPolicy;
  activeRevision?: string; // the reconciled version actually dispatching
  runs?: RunRecord[];
}

/** A single event in the reconcile loop (ARCHITECTURE §5). */
export interface ReconcileEvent {
  time: string; // relative label
  kind: "webhook" | "poll" | "fetch" | "compile" | "apply" | "coalesce" | "backoff" | "error";
  detail: string;
  revision?: string;
}

/** A changed file in the desired-vs-live diff the reconciler would apply. */
export interface DiffEntry {
  path: string;
  change: "added" | "modified" | "removed";
  summary: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  repo: string; // git remote
  branch: string;
  revision: string; // short sha of the branch HEAD (desired)
  syncedRevision: string; // short sha currently applied/running (live)
  behindBy: number; // commits desired is ahead of live
  sync: SyncStatus;
  health: Health;
  autoSync: boolean;
  selfHeal: boolean;
  prune: boolean;
  credentialRef: string; // k8s Secret name (never a value)
  workflows: Workflow[];
  diff?: DiffEntry[]; // what a Sync would apply
  reconcile?: ReconcileEvent[]; // recent reconcile activity
  badCommit?: { revision: string; error: string }; // last-known-good story
}

/** A job currently executing on a worker (what its slots are doing right now). */
export interface RunningJob {
  id: string;
  workflow: string;
  project: string;
  node: string; // the node currently executing
  elapsedMs: number;
  memMB: number;
}

export interface Worker {
  id: string;
  host: string;
  status: "online" | "draining";
  inFlight: number;
  concMin: number; // always accepts at least this many (forward progress)
  concMax: number; // hard ceiling on simultaneous jobs
  paused: boolean; // stopped pulling: live memory/CPU over the pause threshold
  memMB: number;
  memMaxMB: number;
  executor: ExecutorTier;
  heartbeatAgeS: number; // seconds since last heartbeat
  leaseTtlS: number; // registry TTL; expiry ⇒ requeue in-flight jobs
  jobs: RunningJob[]; // a sample of what's in flight (may be fewer than inFlight)
}

// ── Node code samples (jscode nodes) ─────────────────────────────────────────

const fetchCode = `export default async function fetch(input, ctx) {
  ctx.log.info("fetching invoices", { since: input.since });
  const res = await globalThis.fetch(\`\${ctx.secrets.API_URL}/invoices?since=\${input.since}\`);
  if (!res.ok) throw new Error(\`upstream \${res.status}\`);
  return await res.json(); // -> the 'if' node tests this, then transform consumes it
}`;

const transformCode = `export default async function transform(input, ctx) {
  // 'input' is the output of the upstream node (see ctx.inputs for fan-in).
  return input
    .filter((inv) => inv.status === "open")
    .map((inv) => ({ id: inv.id, total: inv.lines.reduce((s, l) => s + l.amount, 0) }));
}`;

const loadCode = `export default async function load(input, ctx) {
  ctx.log.info("loading", { count: input.length });
  for (const row of input) {
    await ctx.db.upsert("invoice_totals", row);
  }
  return { loaded: input.length };
}`;

const pullCode = `export default async function pull(input, ctx) {
  const res = await globalThis.fetch(\`\${ctx.secrets.PSP_URL}/settlements?since=\${input.since}\`);
  return await res.json();
}`;

const matchCode = `export default async function match(payments, ctx) {
  const flagged = payments.filter((p) => !p.invoiceId);
  ctx.log.warn("unmatched payments", { count: flagged.length });
  return { matched: payments.length - flagged.length, flagged: flagged.length };
}`;

const queryCode = `export default async function query(input, ctx) {
  const rows = await ctx.db.query("select * from invoices where overdue = true");
  return rows;
}`;

const sendCode = `export default async function send(overdue, ctx) {
  const smtp = ctx.secrets.SMTP_URL;               // <- bad commit points this at a dead host
  for (const inv of overdue) await ctx.email.send(smtp, inv.customer, "reminder", inv);
  return { sent: overdue.length };
}`;

const defaultLimits: Limits = { memMB: 512, cpuMs: 30_000, wallMs: 60_000, network: "egress-allowlist" };

// ── Billing workflows — real programs drawn as flows ─────────────────────────

const invoices: Workflow = {
  id: "invoices",
  name: "Nightly Invoices",
  description: "Fetch open invoices, and if any are open, compute totals, load them, and ping Slack.",
  sync: "Synced",
  health: "Healthy",
  lastRun: "succeeded",
  concurrencyPolicy: "Forbid",
  activeRevision: "a1b2c3d",
  triggers: [
    { type: "cron", detail: "0 2 * * *", nextRun: "in 6h 12m", enabled: true, concurrencyPolicy: "Forbid" },
    { type: "webhook", detail: "/hooks/invoices", enabled: true },
    { type: "manual", detail: "", enabled: true },
  ],
  nodes: [
    { key: "start", kind: "start", name: "Start", position: { x: 0, y: 150 }, inputSchema: "{ since: string /* ISO date */ }" },
    {
      key: "fetch", kind: "jscode", name: "Fetch Invoices", file: "nodes/fetch.js", code: fetchCode,
      deps: { "node-fetch": "^3" }, position: { x: 170, y: 150 },
      inputSchema: "{ since: string }",
      outputSchema: "Array<{ id, status, lines: {amount}[] }>",
      secrets: ["API_URL", "API_TOKEN"],
      limits: { memMB: 256, cpuMs: 15_000, wallMs: 30_000, network: "egress-allowlist" },
      executor: "nsjail",
    },
    {
      key: "gate", kind: "if", name: "Any open invoices?", position: { x: 360, y: 150 },
      conditions: [{ expr: "invoices.length > 0" }, { connector: "or", expr: "input.force === true" }],
      condition: "invoices.length > 0 || input.force === true",
    },
    {
      key: "transform", kind: "jscode", name: "Compute Totals", file: "nodes/transform.js", code: transformCode,
      position: { x: 545, y: 40 },
      inputSchema: "Array<{ id, status, lines: {amount}[] }>",
      outputSchema: "Array<{ id, total: number }>",
      limits: defaultLimits, executor: "nsjail",
    },
    {
      key: "load", kind: "jscode", name: "Load Warehouse", file: "nodes/load.js", code: loadCode,
      position: { x: 725, y: 40 },
      inputSchema: "Array<{ id, total: number }>",
      outputSchema: "{ loaded: number }",
      secrets: ["WAREHOUSE_DSN"],
      limits: { memMB: 1024, cpuMs: 45_000, wallMs: 90_000, network: "egress-allowlist" },
      executor: "gvisor",
    },
    {
      key: "notify", kind: "callScript", name: "Notify Slack", position: { x: 905, y: 40 },
      call: { workflow: "Post to Slack", ref: "std://acme/notify-slack@v2", standalone: true },
    },
    { key: "end", kind: "end", name: "End", position: { x: 725, y: 270 }, outputSchema: "{ loaded: number } | null" },
  ],
  edges: [
    { from: "start", to: "fetch" },
    { from: "fetch", to: "gate" },
    { from: "gate", to: "transform", branch: "true" },
    { from: "gate", to: "end", branch: "false" },
    { from: "transform", to: "load" },
    { from: "load", to: "notify" },
    { from: "notify", to: "end" },
  ],
  runs: [
    {
      id: "job_8f21", status: "succeeded", trigger: "cron", revision: "a1b2c3d", startedAt: "2h ago", durationMs: 4200,
      nodeTimings: [
        { key: "fetch", status: "succeeded", ms: 1800 },
        { key: "transform", status: "succeeded", ms: 400 },
        { key: "load", status: "succeeded", ms: 2000 },
      ],
    },
    {
      id: "job_8e07", status: "succeeded", trigger: "manual", revision: "a1b2c3d", startedAt: "yesterday", durationMs: 3900,
      nodeTimings: [
        { key: "fetch", status: "succeeded", ms: 1600 },
        { key: "transform", status: "succeeded", ms: 380 },
        { key: "load", status: "succeeded", ms: 1920 },
      ],
    },
    {
      id: "job_8d55", status: "failed", trigger: "cron", revision: "9f0aa12", startedAt: "2d ago", durationMs: 2100,
      nodeTimings: [
        { key: "fetch", status: "succeeded", ms: 1700 },
        { key: "transform", status: "failed", ms: 400 },
        { key: "load", status: "idle", ms: 0 },
      ],
      error: { node: "transform", message: "TypeError: Cannot read properties of undefined (reading 'reduce')" },
    },
  ],
};

const reconcile: Workflow = {
  id: "reconcile",
  name: "Payment Reconcile",
  description: "Match settled payments against invoices; if any are unmatched, kick off dunning.",
  sync: "OutOfSync",
  health: "Progressing",
  lastRun: "running",
  concurrencyPolicy: "Replace",
  activeRevision: "a1b2c3d",
  triggers: [{ type: "cron", detail: "*/15 * * * *", nextRun: "in 4m", enabled: true, concurrencyPolicy: "Replace" }],
  nodes: [
    { key: "start", kind: "start", name: "Start", position: { x: 0, y: 130 }, inputSchema: "{ since: string }" },
    {
      key: "pull", kind: "jscode", name: "Pull Payments", file: "nodes/pull.js", code: pullCode, position: { x: 170, y: 130 },
      inputSchema: "{ since: string }", outputSchema: "Array<Payment>", secrets: ["PSP_URL", "PSP_KEY"],
      limits: defaultLimits, executor: "nsjail",
    },
    {
      key: "match", kind: "jscode", name: "Match", file: "nodes/match.js", code: matchCode, position: { x: 350, y: 130 },
      inputSchema: "Array<Payment>", outputSchema: "{ matched: number, flagged: number }",
      limits: defaultLimits, executor: "nsjail",
    },
    {
      key: "decide", kind: "if", name: "Any unmatched?", position: { x: 535, y: 130 },
      conditions: [{ expr: "result.flagged > 0" }, { connector: "and", expr: "ctx.now.getDate() <= 5" }],
      condition: "result.flagged > 0 && ctx.now.getDate() <= 5",
    },
    {
      key: "dun", kind: "callScript", name: "Run Dunning", position: { x: 720, y: 40 },
      call: { workflow: "Dunning Emails", ref: "workflows/dunning", project: "billing", standalone: false },
    },
    { key: "end", kind: "end", name: "End", position: { x: 720, y: 240 } },
  ],
  edges: [
    { from: "start", to: "pull" },
    { from: "pull", to: "match" },
    { from: "match", to: "decide" },
    { from: "decide", to: "dun", branch: "true" },
    { from: "decide", to: "end", branch: "false" },
    { from: "dun", to: "end" },
  ],
  runs: [
    {
      id: "job_9a10", status: "running", trigger: "cron", revision: "a1b2c3d", startedAt: "just now", durationMs: 0,
      nodeTimings: [
        { key: "pull", status: "succeeded", ms: 900 },
        { key: "match", status: "running", ms: 0 },
      ],
    },
  ],
};

const dunning: Workflow = {
  id: "dunning",
  name: "Dunning Emails",
  description: "Email reminders for overdue invoices. Callable as a step by Payment Reconcile. Failing on a bad commit.",
  sync: "OutOfSync",
  health: "Degraded",
  lastRun: "failed",
  concurrencyPolicy: "Allow",
  activeRevision: "77c0ffe", // last-known-good still dispatching
  triggers: [
    { type: "cron", detail: "0 9 * * 1", nextRun: "held (Degraded)", enabled: true, concurrencyPolicy: "Allow" },
    { type: "event", detail: "called by reconcile", enabled: true },
  ],
  nodes: [
    { key: "start", kind: "start", name: "Start", position: { x: 0, y: 130 }, inputSchema: "{}" },
    {
      key: "query", kind: "jscode", name: "Query Overdue", file: "nodes/query.js", code: queryCode, position: { x: 170, y: 130 },
      inputSchema: "{}", outputSchema: "Array<Invoice>", secrets: ["WAREHOUSE_DSN"],
      limits: defaultLimits, executor: "nsjail",
    },
    { key: "gate", kind: "if", name: "Anything overdue?", position: { x: 355, y: 130 }, condition: "overdue.length > 0" },
    {
      key: "send", kind: "jscode", name: "Send Email", file: "nodes/send.js", code: sendCode, position: { x: 540, y: 40 },
      inputSchema: "Array<Invoice>", outputSchema: "{ sent: number }", secrets: ["SMTP_URL"],
      limits: defaultLimits, executor: "nsjail",
    },
    { key: "end", kind: "end", name: "End", position: { x: 540, y: 240 } },
  ],
  edges: [
    { from: "start", to: "query" },
    { from: "query", to: "gate" },
    { from: "gate", to: "send", branch: "true" },
    { from: "gate", to: "end", branch: "false" },
    { from: "send", to: "end" },
  ],
  runs: [
    {
      id: "job_7b02", status: "failed", trigger: "cron", revision: "a1b2c3d", startedAt: "1h ago", durationMs: 1500,
      nodeTimings: [
        { key: "query", status: "succeeded", ms: 700 },
        { key: "send", status: "failed", ms: 800 },
      ],
      error: { node: "send", message: "Error: SMTP connection refused (ECONNREFUSED smtp.acme.io:587)" },
    },
  ],
};

export const projects: Project[] = [
  {
    id: "billing",
    name: "Billing",
    description: "Revenue and invoicing workflows.",
    repo: "git@github.com:acme/mill-billing.git",
    branch: "main",
    revision: "a1b2c3d",
    syncedRevision: "9f0aa12",
    behindBy: 3,
    sync: "OutOfSync",
    health: "Degraded",
    autoSync: true,
    selfHeal: true,
    prune: false,
    credentialRef: "mill-billing-deploy-key",
    workflows: [invoices, reconcile, dunning],
    diff: [
      { path: "workflows/invoices/nodes/transform.js", change: "modified", summary: "guard empty lines[] before reduce" },
      { path: "workflows/reconcile/workflow.yaml", change: "modified", summary: "cron */15 → */10; add concurrencyPolicy: Replace" },
      { path: "workflows/dunning/nodes/send.js", change: "modified", summary: "switch SMTP host (introduces the failing commit)" },
      { path: "workflows/refunds/", change: "added", summary: "new workflow: start → if → 2 js → end, manual trigger" },
    ],
    reconcile: [
      { time: "just now", kind: "poll", detail: "authoritative poll (3m + jitter) — re-deriving delta from scratch" },
      { time: "2m ago", kind: "webhook", detail: "push event on main", revision: "a1b2c3d" },
      { time: "2m ago", kind: "coalesce", detail: "webhook + poll landed together → one reconcile" },
      { time: "2m ago", kind: "fetch", detail: "fetched main@a1b2c3d; validating 4 workflows (Zod)" },
      { time: "2m ago", kind: "compile", detail: "compiled 3 ok; dunning → SHA-keyed artifact built" },
      { time: "2m ago", kind: "error", detail: "dunning runtime health: SMTP unreachable → keep last-known-good 77c0ffe" },
      { time: "2m ago", kind: "backoff", detail: "dunning requeued with exponential backoff (not hot-looping)" },
    ],
    badCommit: {
      revision: "a1b2c3d",
      error: "dunning: node 'send' fails health (SMTP ECONNREFUSED). Marked Degraded; 77c0ffe stays live.",
    },
  },
  {
    id: "growth",
    name: "Growth",
    description: "Lifecycle and analytics automations.",
    repo: "git@github.com:acme/mill-growth.git",
    branch: "main",
    revision: "9f8e7d6",
    syncedRevision: "9f8e7d6",
    behindBy: 0,
    sync: "Synced",
    health: "Healthy",
    autoSync: false,
    selfHeal: true,
    prune: false,
    credentialRef: "mill-growth-deploy-key",
    workflows: [
      {
        ...invoices,
        id: "onboarding",
        name: "Onboarding Drip",
        description: "Welcome-series emails for new signups.",
        sync: "Synced",
        health: "Healthy",
        lastRun: "succeeded",
      },
    ],
    diff: [],
    reconcile: [
      { time: "1m ago", kind: "poll", detail: "poll — no drift; running == 9f8e7d6", revision: "9f8e7d6" },
      { time: "1h ago", kind: "apply", detail: "manual Sync applied 9f8e7d6; triggers reconciled", revision: "9f8e7d6" },
    ],
  },
];

export const workspace = {
  name: "Acme",
  rootRepo: "git@github.com:acme/mill-config.git",
  projects,
};

export const workers: Worker[] = [
  {
    id: "w-7f3a", host: "mill-worker-7f3a", status: "online", inFlight: 12, concMin: 1, concMax: 32, paused: false, memMB: 540, memMaxMB: 1024, executor: "nsjail", heartbeatAgeS: 2, leaseTtlS: 15,
    jobs: [
      { id: "job_a1c9", workflow: "Nightly Invoices", project: "billing", node: "Load Warehouse", elapsedMs: 2100, memMB: 96 },
      { id: "job_a2f0", workflow: "Payment Reconcile", project: "billing", node: "Match", elapsedMs: 800, memMB: 64 },
      { id: "job_a3b7", workflow: "Onboarding Drip", project: "growth", node: "Fetch Invoices", elapsedMs: 1400, memMB: 72 },
    ],
  },
  // Only 6 in-flight but its jobs turned heavy → memory 89% > 85% → paused (won't pull more).
  {
    id: "w-2b91", host: "mill-worker-2b91", status: "online", inFlight: 6, concMin: 1, concMax: 64, paused: true, memMB: 910, memMaxMB: 1024, executor: "nsjail", heartbeatAgeS: 1, leaseTtlS: 15,
    jobs: [
      { id: "job_b0d2", workflow: "Nightly Invoices", project: "billing", node: "Load Warehouse", elapsedMs: 12300, memMB: 512 },
      { id: "job_b1a4", workflow: "Payment Reconcile", project: "billing", node: "Pull Payments", elapsedMs: 8100, memMB: 210 },
    ],
  },
  {
    id: "w-c04d", host: "mill-worker-c04d", status: "draining", inFlight: 1, concMin: 1, concMax: 8, paused: false, memMB: 220, memMaxMB: 1024, executor: "gvisor", heartbeatAgeS: 4, leaseTtlS: 15,
    jobs: [
      { id: "job_c7e1", workflow: "Dunning Emails", project: "billing", node: "Query Overdue", elapsedMs: 600, memMB: 48 },
    ],
  },
];

export const queueDepth = 12;

/** Pending-queue detail for the Fleet view. */
export const queue = {
  depth: queueDepth,
  oldestWaitMs: 5400, // schedule-to-start wait of the head-of-line job
  byWorkflow: [
    { workflow: "Nightly Invoices", count: 5 },
    { workflow: "Payment Reconcile", count: 4 },
    { workflow: "Onboarding Drip", count: 3 },
  ],
};

/** Fleet-wide execution stats (derived from Prometheus in the real app). */
export const fleetStats = {
  throughputPerMin: 47, // jobs completed / minute across the fleet
  completedLastHour: 2810,
  p50Ms: 1200,
  p95Ms: 4800,
  successRatePct: 98.6,
  avgWaitMs: 320, // avg schedule-to-start latency
  nodesPerSec: 22, // node-executions / second
  // last ~12 minutes of throughput (jobs/min) for a sparkline
  throughputTrend: [30, 42, 38, 51, 47, 55, 49, 41, 52, 60, 53, 47],
};

/** Files a project/workflow export (.tar.gz) contains — ARCHITECTURE §7. */
export const exportBundle = [
  { path: "index.js", note: "compiler-generated entrypoint — the main file: start, the if branches, calls, end" },
  { path: "workflows/**/workflow.yaml", note: "the graph: nodes (typed), edges, triggers" },
  { path: "workflows/**/nodes/*.js", note: "your jscode nodes, verbatim" },
  { path: "package.json", note: "union of all node deps" },
  { path: "bun.lockb", note: "pinned lockfile for reproducible installs" },
  { path: "run.sh", note: "`bun install && bun run index.js`" },
  { path: "README.md", note: "how to run it standalone" },
  { path: "index.browser.js", note: "browser-target variant (nodes free of server-only APIs)" },
];

/** The isolation ladder for the Executor seam — ARCHITECTURE §6. */
export const isolationLadder: {
  tier: ExecutorTier;
  name: string;
  trust: string;
  coldStart: string;
  boundary: string;
  status: "default" | "next" | "later" | "optin";
  note: string;
}[] = [
  { tier: "nsjail", name: "NsjailProcessExecutor", trust: "internal-trusted", coldStart: "~ms", boundary: "userns + seccomp-bpf + cgroups", status: "default", note: "ON by default — the warm-pool hot path (what Windmill ships for hardened workers)." },
  { tier: "gvisor", name: "GvisorExecutor", trust: "semi-trusted", coldStart: "sub-VM", boundary: "user-space kernel (runsc)", status: "next", note: "Syscall interception at container density." },
  { tier: "firecracker", name: "FirecrackerExecutor", trust: "untrusted", coldStart: "~125ms", boundary: "hardware KVM microVM", status: "later", note: "<5 MiB/VM; the hardest multi-tenant tier." },
  { tier: "k8sjob", name: "K8sJobExecutor", trust: "heavy / opt-in", coldStart: "seconds", boundary: "pod-per-run (gVisor/Kata RuntimeClass)", status: "optin", note: "Per-workflow choice for heavy/long jobs — never the default hot path." },
];

export function findProject(id?: string) {
  return projects.find((p) => p.id === id);
}
export function findWorkflow(projectId?: string, workflowId?: string) {
  const p = findProject(projectId);
  return { project: p, workflow: p?.workflows.find((w) => w.id === workflowId) };
}

/** Count nodes by kind — used to show "what's inside" a workflow at a glance. */
export function nodeKindCounts(w: Workflow): { kind: NodeKind; count: number }[] {
  const order: NodeKind[] = ["start", "jscode", "if", "callScript", "end"];
  return order
    .map((kind) => ({ kind, count: w.nodes.filter((n) => n.kind === kind).length }))
    .filter((x) => x.count > 0);
}
