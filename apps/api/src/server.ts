import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "hono/bun";
import Redis from "ioredis";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join, resolve } from "node:path";
import { MillQueue, SecretStore, validSecretName } from "@mill/queue";
import { computeStats, computeQueueView } from "./fleet";
import { runNode } from "@mill/executor";
import { createLogger } from "@mill/telemetry";

const log = createLogger("api");

const ENV_SECRETS: Record<string, string> = process.env.MILL_SECRETS ? JSON.parse(process.env.MILL_SECRETS) : {};
import { loadProject, listWorkflows, loadWorkflow, listProjects, collectDeps, validateNodeSources, packProject } from "@mill/projectfs";
import { buildPlan } from "@mill/compiler";
import { openRepo, reconcile, deletePaths, writePaths, diffToApply, type RepoState, type ReconcileStatus } from "@mill/gitops";
import { parseWorkflow } from "@mill/core";
import { stringify as yamlStringify } from "yaml";
import { TriggerEngine, type TriggerDef } from "./triggers";
import { exportProject } from "./export";

// The controller (ARCHITECTURE §3.2): indexes projects on disk, triggers jobs onto the
// queue, relays live logs. It is the only component that talks to git (working copy) —
// for the local stack the working copy is the mounted PROJECTS_DIR (a shared volume,
// the same role a PVC plays on EKS). Real git clone/reconcile lands next.

// If PROJECT_REPO is set, the controller owns a git working copy and reconciles it;
// otherwise it reads projects straight from PROJECTS_DIR (a mounted dir).
const PROJECT_REPO = process.env.PROJECT_REPO;
const PROJECT_BRANCH = process.env.PROJECT_BRANCH ?? "main";
const GIT_TOKEN = process.env.GIT_TOKEN; // GitHub PAT for private HTTPS repos
const WORKDIR = process.env.WORKDIR ?? "/app/workdir";
const RECONCILE_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 15_000);
let PROJECTS_DIR = PROJECT_REPO ? WORKDIR : (process.env.PROJECTS_DIR ?? "/projects");

const PORT = Number(process.env.PORT ?? 8080);
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const q = new MillQueue(redis);
const secretStore = new SecretStore(redis); // runtime secrets (Redis), injected into ctx.secrets

// Safety net: a controller must not die from a stray async error (e.g. a dropped redis
// pub/sub connection during SSE teardown). Log it (redacted) and keep serving.
const redact = (s: string) => s.replace(/github_pat_[A-Za-z0-9_]+/g, "<TOKEN>").replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
redis.on("error", (e) => console.error("redis error:", redact(String(e?.message ?? e))));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", redact(e instanceof Error ? e.stack ?? e.message : String(e))));
process.on("uncaughtException", (e) => console.error("uncaughtException:", redact(e instanceof Error ? e.stack ?? e.message : String(e))));

// Reaper: requeue in-flight jobs of workers whose heartbeat expired (crash recovery).
setInterval(() => {
  q.reapDead().then((n) => { if (n) console.log(`reaper: requeued ${n} orphaned job(s) from dead worker(s)`); }).catch(() => {});
}, 5000);

let repoState: RepoState | null = null;

/**
 * Why a workflow can't be dispatched right now (graph won't compile, or a node's .js won't
 * parse), or null if it's runnable. Guards every trigger path so a broken workflow is rejected
 * at the boundary with a clear message instead of enqueuing a job that fails at runtime.
 */
// Compile results are stable for a given synced revision — cache them so high-frequency crons
// and hot webhook endpoints don't re-transpile every node file on every trigger. Cleared on
// each reconcile (a new revision invalidates the working copy).
const compileCache = new Map<string, string | null>();
function runnableError(projectDir: string, workflow: string): string | null {
  const cacheKey = `${lastStatus?.syncedRevision ?? ""}:${projectDir}:${workflow}`;
  const hit = compileCache.get(cacheKey);
  if (hit !== undefined) return hit;
  let result: string | null;
  try {
    const { def, dir } = loadWorkflow(projectDir, workflow);
    buildPlan(def);
    const src = validateNodeSources(dir, def);
    result = src.length ? src.map((e) => `${e.node}: ${e.error}`).join("; ") : null;
  } catch (e) { result = e instanceof Error ? e.message : String(e); }
  compileCache.set(cacheKey, result);
  return result;
}

function enqueueJob(projectDir: string, workflow: string, input: unknown, trigger = "manual", request?: unknown): string {
  const jobId = "job_" + crypto.randomUUID().slice(0, 8);
  const projectId = projectDir.split("/").filter(Boolean).pop() ?? projectDir;
  const revision = lastStatus?.syncedRevision;
  // Carry the workflow's `exclusive` flag onto the job so the worker can dedicate a pod to it.
  let exclusive: boolean | undefined;
  try { exclusive = loadWorkflow(projectDir, workflow).def.exclusive; } catch { /* leave undefined */ }
  // Ship the project's code to the worker via Redis (keyed by revision) so the worker needs no
  // shared /app/workdir. q.enqueue publishes the bundle (write-once, NX) BEFORE queueing the job.
  let bundleKey: string | undefined;
  let bundleFiles: Record<string, string> | undefined;
  if (revision) {
    bundleKey = q.bundleKeyFor(projectId, revision);
    try { bundleFiles = packProject(projectDir); } catch (e) { console.error("packProject failed:", e); }
  }
  q.enqueue({ id: jobId, projectDir, workflow, input, revision, project: projectId, bundleKey, bundleFiles, trigger, runKey: `${projectId}/${workflow}`, request, exclusive })
    .catch((e) => console.error("enqueue failed:", e));
  q.metricInc(`triggered:${trigger}`).catch(() => {});
  return jobId;
}

// Cron + webhook triggers, rebuilt from the reconciled workflows on every reconcile.
const triggerEngine = new TriggerEngine(async (t, input) => {
  // Don't dispatch a broken workflow — a compile/parse error would just fail at runtime.
  const bad = runnableError(join(PROJECTS_DIR, t.project), t.workflow);
  if (bad) {
    q.metricInc("dispatch_skipped:compile_error").catch(() => {});
    log.warn("dispatch skipped — workflow won't compile", { project: t.project, workflow: t.workflow, error: bad });
    return;
  }
  // concurrencyPolicy enforcement — CRON only (k8s CronJob semantics). Webhook/manual/event
  // runs are intentional and always fire. Replace is best-effort: drop a still-queued prior
  // run; if one is already executing, let it finish and skip this one (degrades to Forbid).
  const policy = t.concurrencyPolicy;
  if (t.type === "cron" && policy && policy !== "Allow") {
    const active = await q.activeRuns(`${t.project}/${t.workflow}`).catch(() => []);
    const running = active.filter((a) => a.status === "running");
    if (policy === "Forbid" && active.length > 0) {
      q.metricInc("concurrency_skipped:Forbid").catch(() => {});
      log.info("concurrency: skipped run (Forbid — a run is already in progress)", { project: t.project, workflow: t.workflow, active: active.length });
      return;
    }
    if (policy === "Replace") {
      if (running.length > 0) {
        q.metricInc("concurrency_skipped:Replace").catch(() => {});
        log.info("concurrency: skipped run (Replace — a run is already executing)", { project: t.project, workflow: t.workflow });
        return;
      }
      const queued = active.filter((a) => a.status === "queued");
      for (const j of queued) await q.supersede(j.id).catch(() => {}); // drop pending; newest wins
      if (queued.length) { q.metricInc("concurrency_replaced:Replace", queued.length).catch(() => {}); log.info("concurrency: superseded queued run(s) (Replace)", { project: t.project, workflow: t.workflow, replaced: queued.length }); }
    }
  }
  const jobId = enqueueJob(join(PROJECTS_DIR, t.project), t.workflow, input, t.type);
  log.info("trigger", { type: t.type, project: t.project, workflow: t.workflow, job: jobId });
});

// ── Tokenized ingress: stable per-project (/p/:path) and per-workflow (/p/w/:wf/:path)
// URLs on the same host, rebuilt from the reconciled workflows. Bearer-token secured.
const INGRESS_TOKEN = process.env.MILL_INGRESS_TOKEN; // global fallback token
const wfRoutes = new Map<string, { project: string; workflow: string }>(); // key: `${workflow}/${path}`
const projRoutes = new Map<string, string>(); // key: path → project id
const projectTokens = new Map<string, string>(); // project id → its bearer token (per-project override)
const projWebhookWfs = new Map<string, string[]>(); // project id → workflows that OPT IN to an HTTP endpoint (declare a `webhook` trigger)
// Capability URLs: a webhook trigger with a long, unguessable `path` authenticates BY THE PATH
// (no Authorization header) — for header-less providers like Acuity/Twilio that can't send a
// bearer. Keyed `${workflow}/${path}`. Short/guessable paths do NOT qualify and still need the bearer.
const capabilityRoutes = new Set<string>();
const CAP_MIN_LEN = 24; // a path this long is treated as an unguessable credential

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
/** The bearer token that guards a project's /p endpoints: its own (via ingress.tokenEnv) or the global one. */
function tokenFor(projectId: string): string | undefined {
  return projectTokens.get(projectId) ?? INGRESS_TOKEN;
}
/** Returns an error Response if the request's bearer token doesn't match the project's, else null. */
function bearerGuard(c: { req: { header: (k: string) => string | undefined }; json: (o: unknown, s?: number) => Response }, projectId: string): Response | null {
  const token = tokenFor(projectId);
  if (!token) { q.metricInc("ingress_total:disabled").catch(() => {}); return c.json({ error: "ingress disabled for this project — set MILL_INGRESS_TOKEN or the project's ingress.tokenEnv" }, 503); }
  const m = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m || !safeEq(m[1], token)) {
    q.metricInc("ingress_total:unauthorized").catch(() => {});
    q.metricInc("ingress_auth_failures_total").catch(() => {}); // security alerting
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}

function syncTriggers() {
  const triggers: TriggerDef[] = [];
  wfRoutes.clear();
  projRoutes.clear();
  projectTokens.clear();
  projWebhookWfs.clear();
  capabilityRoutes.clear();
  for (const pid of listProjects(PROJECTS_DIR)) {
    try {
      const proj = loadProject(join(PROJECTS_DIR, pid));
      const env = proj.ingress?.tokenEnv;
      if (env && process.env[env]) projectTokens.set(pid, process.env[env]!); // per-project token via Secret/env ref
    } catch { /* invalid project.yaml — skip */ }
    const exposed: string[] = []; // workflows in this project that opt in to an HTTP endpoint
    for (const wname of listWorkflows(join(PROJECTS_DIR, pid))) {
      try {
        const { def } = loadWorkflow(join(PROJECTS_DIR, pid), wname);
        const hasWebhook = def.triggers.some((t) => t.type === "webhook");
        // An HTTP endpoint exists ONLY when a workflow opts in with a `webhook` trigger.
        // Manual/cron/event-only workflows run, but are NOT reachable over /p — nothing is
        // "exposed" until you configure it.
        if (hasWebhook) {
          exposed.push(wname);
          wfRoutes.set(`${wname}/${pid}`, { project: pid, workflow: wname }); // default: /p/w/<wf>/<project-id>
        }
        for (const t of def.triggers) {
          // effective policy: the trigger's own, else the workflow-level default.
          triggers.push({ project: pid, workflow: wname, type: t.type, schedule: t.schedule, path: t.path, concurrencyPolicy: t.concurrencyPolicy ?? def.concurrencyPolicy });
          if (t.type === "webhook" && t.path) {
            wfRoutes.set(`${wname}/${t.path}`, { project: pid, workflow: wname }); // custom path
            // A sufficiently long path is an unguessable credential → authenticates by itself.
            if (t.path.length >= CAP_MIN_LEN) capabilityRoutes.add(`${wname}/${t.path}`);
          }
        }
      } catch { /* skip invalid workflow */ }
    }
    if (exposed.length) {
      projWebhookWfs.set(pid, exposed);
      projRoutes.set(pid, pid); // project endpoint /p/<id> only when ≥1 workflow is exposed
    }
  }
  // Prune allow-empty guard: never let a suddenly-empty tree (broken clone, bad revision)
  // deregister every trigger — keep the last non-empty set until real triggers reappear.
  if (triggers.length === 0 && lastTriggerCount > 0) {
    console.warn("prune guard: 0 triggers resolved but previous set was non-empty — keeping existing triggers");
    return;
  }
  lastTriggerCount = triggers.length;
  triggerEngine.sync(triggers);
}
let lastTriggerCount = 0;
let lastStatus: (ReconcileStatus & { at: number }) | null = null;
let installedRev = "";

/**
 * Install each project's declared npm deps (union of node `deps`) into its working copy,
 * so a node can `import` an external library and both in-process and isolated runs resolve
 * it. Runs only when the synced revision changes. node_modules + the generated package.json
 * are kept out of git via .git/info/exclude (see writeGitExclude).
 */
async function installDeps(force = false): Promise<void> {
  const rev = lastStatus?.syncedRevision ?? "";
  if (!force && rev && rev === installedRev) return; // only re-install on a new revision
  for (const id of listProjects(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, id);
    const deps = collectDeps(dir);
    if (!Object.keys(deps).length) continue;
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `mill-${id}`, private: true, type: "module", dependencies: deps }, null, 2));
    const proc = Bun.spawn(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode === 0) console.log(`deps: installed ${Object.keys(deps).length} package(s) for '${id}' (${Object.keys(deps).join(", ")})`);
    else console.error(`deps: install failed for '${id}':`, err.slice(0, 300));
  }
  installedRev = rev;
}

/** Keep runtime-installed deps out of git so Save/Delete commits never stage them. */
function writeGitExclude(repoDir: string): void {
  try {
    const p = join(repoDir, ".git", "info", "exclude");
    if (existsSync(join(repoDir, ".git"))) writeFileSync(p, "# added by Mill — never commit runtime-installed deps\nnode_modules/\n**/node_modules/\n*/package.json\n**/bun.lock\n**/bun.lockb\n");
  } catch { /* best-effort */ }
}

// Rolling reconcile-activity log (newest first) for the project page's activity feed.
const reconcileLog: { at: number; targetRevision: string; syncedRevision: string; sync: string; health: string; error?: string }[] = [];
let lastLoggedRev = "";

// Workspace autoSync gate (single-repo v1): when off, the reconciler validates new revisions
// but holds them (OutOfSync) until a manual Sync. A manual `POST /api/reconcile` always applies.
const AUTOSYNC = (process.env.MILL_AUTOSYNC ?? "true") !== "false";

async function doReconcile(opts: { force?: boolean } = {}): Promise<(ReconcileStatus & { at: number }) | null> {
  if (!repoState) return null;
  const s = await reconcile(repoState, { apply: opts.force ? true : AUTOSYNC }); // force = manual Sync applies now
  if (s.syncedRevision !== lastStatus?.syncedRevision) compileCache.clear(); // working copy changed
  lastStatus = { ...s, at: Date.now() };
  // Log an activity entry when something changed (new target, applied revision, or an error).
  const sig = `${s.targetRevision}|${s.syncedRevision}|${s.error ?? ""}`;
  if (sig !== lastLoggedRev) {
    reconcileLog.unshift({ at: Date.now(), targetRevision: s.targetRevision, syncedRevision: s.syncedRevision, sync: s.sync, health: s.health, error: s.error });
    if (reconcileLog.length > 50) reconcileLog.pop();
    lastLoggedRev = sig;
  }
  if (s.sync === "Synced") await installDeps().catch((e) => console.error("deps install error:", e));
  // Classify the pass for the reconcile_total counter (dashboards/alerts).
  const result = s.health === "Degraded" ? "degraded" : /held/.test(s.error ?? "") ? "held" : s.syncedRevision === s.targetRevision ? "applied" : "nochange";
  q.metricInc(`reconcile_total:${result}`).catch(() => {});
  syncTriggers(); // re-register cron/webhook triggers from the reconciled workflows
  return lastStatus;
}

async function initRepo() {
  if (!PROJECT_REPO) return;
  console.log(`cloning ${PROJECT_REPO} (branch ${PROJECT_BRANCH}${GIT_TOKEN ? ", token" : ""}) → ${WORKDIR}`);
  repoState = await openRepo(PROJECT_REPO, WORKDIR, PROJECT_BRANCH, GIT_TOKEN);
  PROJECTS_DIR = WORKDIR;
  writeGitExclude(WORKDIR); // so runtime-installed node_modules never get committed
  await doReconcile();
  log.info("reconciled", { sync: lastStatus?.sync, health: lastStatus?.health, rev: lastStatus?.syncedRevision?.slice(0, 7) });
  setInterval(() => { doReconcile().catch((e) => console.error("reconcile error:", e)); }, RECONCILE_MS);
}
initRepo().catch((e) => console.error("repo init failed:", e));
if (!PROJECT_REPO) syncTriggers(); // dir mode: register triggers from the mounted projects

const app = new Hono();
const api = new Hono(); // all JSON endpoints live under /api so they never collide with SPA routes
// CORS: same-origin by default (the UI is served by this controller, so it needs no CORS).
// Cross-origin browser access is denied unless explicitly allowlisted via MILL_CORS_ORIGINS
// (comma-separated). Server-to-server callers (webhooks/REST) are unaffected — CORS is a
// browser control. Removes the "Access-Control-Allow-Origin: *" foot-gun on the control plane.
const CORS_ORIGINS = (process.env.MILL_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
app.use("*", cors({ origin: (origin) => (CORS_ORIGINS.includes(origin) ? origin : "") }));

// App-level admin token (defense-in-depth if Ingress SSO is misconfigured). When set, every
// /api/* route requires `Authorization: Bearer <MILL_ADMIN_TOKEN>` EXCEPT the infra endpoints
// /api/health (liveness probe) and /api/metrics (Prometheus scrape — send it a bearer_token).
// NOTE: enabling this locks the browser UI too — use it for headless/API deployments, or leave
// it unset and terminate auth (SSO) at the Ingress.
const ADMIN_TOKEN = process.env.MILL_ADMIN_TOKEN;
const ADMIN_OPEN = new Set(["/api/health", "/api/metrics"]);
api.use("*", async (c, next) => {
  if (!ADMIN_TOKEN) return next();
  const url = new URL(c.req.url);
  if (ADMIN_OPEN.has(url.pathname)) return next();
  // Bearer header for normal fetch(); `?access_token=` for EventSource (SSE can't set headers).
  const m = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  const supplied = m ? m[1] : (url.searchParams.get("access_token") ?? "");
  if (!supplied || !safeEq(supplied, ADMIN_TOKEN)) return c.json({ error: "unauthorized (admin token required)" }, 401);
  return next();
});

const projectDirs = (): string[] => listProjects(PROJECTS_DIR);

const consoleHtml = readFileSync(resolve(import.meta.dir, "console.html"), "utf8");

api.get("/health", (c) => c.json({ ok: true, projectsDir: PROJECTS_DIR }));

api.get("/projects", (c) => {
  const out = projectDirs().map((id) => {
    const dir = join(PROJECTS_DIR, id);
    const p = loadProject(dir);
    return { id, name: p.metadata.name, sync: p.sync, workflows: listWorkflows(dir) };
  });
  return c.json(out);
});

const readFileSafe = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

api.get("/projects/:id/workflows/:wf", (c) => {
  const { id, wf } = c.req.param();
  try {
    const { def, dir } = loadWorkflow(join(PROJECTS_DIR, id), wf);
    const plan = buildPlan(def);
    // Include node code so the editor can render + inspect a workflow it doesn't have mocked.
    const nodes = def.nodes.map((n) => (n.kind === "jscode" && n.file ? { ...n, code: readFileSafe(join(dir, n.file)) } : n));
    return c.json({ workflow: def.metadata.name, nodes, edges: def.edges, triggers: def.triggers, order: plan.order, exclusive: def.exclusive ?? false, inputSchema: def.inputSchema ?? "" });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

api.post("/projects/:id/workflows/:wf/trigger", async (c) => {
  const { id, wf } = c.req.param();
  const dir = join(PROJECTS_DIR, id);
  if (!existsSync(join(dir, "workflows", wf, "workflow.yaml"))) return c.json({ error: "workflow not found" }, 404);
  const badWf = runnableError(dir, wf);
  if (badWf) return c.json({ error: `workflow '${wf}' won't compile: ${badWf}` }, 422);
  // A non-empty but malformed JSON body is a caller error — reject it instead of silently
  // running with empty input (an empty body is fine and defaults to {}).
  const text = await c.req.text();
  let body: { input?: unknown } = {};
  if (text.trim()) { try { body = JSON.parse(text); } catch { return c.json({ error: "invalid JSON body" }, 400); } }
  const jobId = enqueueJob(dir, wf, body?.input ?? {}, "manual");
  return c.json({ jobId });
});

// Test-run a single step in isolation with a caller-supplied input (no upstream nodes run).
// Runs in-process on the controller — a fast dev/test affordance, not the hot path.
api.post("/projects/:id/workflows/:wf/nodes/:key/test", async (c) => {
  const { id, wf, key } = c.req.param();
  const dir = join(PROJECTS_DIR, id);
  if (!existsSync(join(dir, "workflows", wf, "workflow.yaml"))) return c.json({ error: "workflow not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  // Precedence: process env / k8s Secrets < Redis store (UI-managed) < ad-hoc test overrides.
  const secrets = { ...ENV_SECRETS, ...(await secretStore.all().catch(() => ({}))), ...(body?.secrets ?? {}) };
  try {
    const r = await runNode(dir, wf, key, body?.input ?? {}, secrets, lastStatus?.syncedRevision);
    return c.json(r, r.status === "failed" && r.error?.startsWith("no node") ? 404 : 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// ── Secrets (runtime, Redis-backed) ──────────────────────────────────────────
// Values are injected into ctx.secrets at run time (a node sees only the refs it declares).
// Write-only from the UI: names are listed, values are NEVER returned. Admin-guarded by the
// /api/* middleware when MILL_ADMIN_TOKEN is set.
api.get("/secrets", async (c) => {
  return c.json({ names: await secretStore.names(), encryptedAtRest: secretStore.encryptedAtRest() });
});
api.put("/secrets/:name", async (c) => {
  const name = c.req.param("name");
  if (!validSecretName(name)) return c.json({ error: `invalid secret name '${name}' — letters, digits, underscore` }, 400);
  const body = await c.req.json().catch(() => ({}));
  const value = body?.value;
  if (typeof value !== "string" || value.length === 0) return c.json({ error: "body must be { value: <non-empty string> }" }, 400);
  await secretStore.set(name, value);
  return c.json({ saved: name, encryptedAtRest: secretStore.encryptedAtRest() });
});
api.delete("/secrets/:name", async (c) => {
  const removed = await secretStore.remove(c.req.param("name"));
  return c.json({ removed: removed > 0 ? c.req.param("name") : null });
});

api.get("/jobs/:id", async (c) => {
  const job = await q.getJob(c.req.param("id"));
  if (!Object.keys(job).length) return c.json({ error: "not found" }, 404);
  return c.json({ ...job, result: job.result ? JSON.parse(job.result) : null });
});

// Per-node timeline for a run (from its recorded events) — powers the Run detail spans.
api.get("/jobs/:id/timeline", async (c) => {
  const events = await q.getEvents(c.req.param("id"));
  const byNode = new Map<string, { key: string; status: string; ms: number }>();
  let error: { node: string; message: string } | undefined;
  for (const e of events as { type?: string; node?: string; status?: string; ms?: number; error?: string }[]) {
    if (e.type !== "node" || !e.node) continue;
    byNode.set(e.node, { key: e.node, status: e.status ?? "idle", ms: e.ms ?? 0 });
    if (e.status === "failed") error = { node: e.node, message: e.error ?? "failed" };
  }
  return c.json({ nodeTimings: [...byNode.values()], error });
});

// Retry a run: re-enqueue the same workflow with the same input (a fresh run).
api.post("/jobs/:id/retry", async (c) => {
  const job = await q.getJob(c.req.param("id"));
  if (!Object.keys(job).length) return c.json({ error: "job not found" }, 404);
  let input: unknown = {};
  try { input = job.input ? JSON.parse(job.input) : {}; } catch { /* default {} */ }
  const projectId = (job.project || "").split("/").filter(Boolean).pop() ?? "";
  const jobId = enqueueJob(job.project, job.workflow, input, "manual");
  q.metricInc("retries_total").catch(() => {});
  return c.json({ jobId, retriedFrom: c.req.param("id"), project: projectId, workflow: job.workflow });
});

// Live per-node status + logs (Server-Sent Events). Replays history, then streams.
api.get("/jobs/:id/events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    for (const e of await q.getEvents(id)) await stream.writeSSE({ data: JSON.stringify(e) });
    const job = await q.getJob(id);
    if (job.status === "succeeded" || job.status === "failed") {
      await stream.writeSSE({ event: "done", data: job.status });
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      let unsub: (() => Promise<void>) | undefined;
      const finish = async () => {
        if (done) return; // idempotent: timeout + done-event can both fire
        done = true;
        try { await unsub?.(); } catch { /* cleanup best-effort */ }
        resolve();
      };
      unsub = q.subscribe(id, (e) => {
        stream.writeSSE({ data: JSON.stringify(e) })
          .then(() => { if (e.type === "done") finish(); })
          .catch(() => finish()); // client gone / stream closed → tear down
      });
      setTimeout(() => { finish().catch(() => {}); }, 120_000); // safety cap
    });
  });
});

api.get("/workers", async (c) => c.json({ workers: await q.workers(), queueDepth: await q.queueDepth() }));

// Prometheus metrics — monotonic counters + histograms (from Redis) and live gauges. The
// counters/histograms let your monitoring compute rates + real quantiles; see docs/RUNNING.md.
api.get("/metrics", async (c) => {
  const now = Date.now();
  const [workers, queueDepth, counters, oldestCreatedAt] = await Promise.all([q.workers(), q.queueDepth(), q.metricAll(), q.oldestQueuedCreatedAt()]);
  const inFlight = workers.reduce((n, w) => n + (w.inFlight ?? 0), 0);
  const capacity = workers.reduce((n, w) => n + (w.concMax ?? 0), 0); // total concurrent slots
  const num = (v: string | undefined) => Number(v ?? 0);
  const lines: string[] = [];
  const help = (name: string, h: string, type: string) => lines.push(`# HELP ${name} ${h}`, `# TYPE ${name} ${type}`);
  const g = (name: string, h: string, value: number) => { help(name, h, "gauge"); lines.push(`${name} ${value}`); };

  // ── gauges (current state) ──
  g("mill_workers", "Workers currently registered", workers.length);
  // One series per heartbeating pod, so you can see EXACTLY which workers are registered — a
  // Deployment with N replicas should show N series here. Fewer ⇒ pods not registering (e.g.
  // colliding worker ids, or a pod that can't reach Redis). host is the pod name.
  if (workers.length) {
    help("mill_worker_info", "Registered worker (1 per heartbeating pod)", "gauge");
    for (const w of workers) lines.push(`mill_worker_info{worker_id="${w.id}",host="${w.host}",executor="${w.executor ?? "in-process"}"} 1`);
  }
  g("mill_workers_inflight", "Jobs executing across the fleet", inFlight);
  g("mill_worker_capacity", "Total concurrent job slots across the fleet (Σ concMax)", capacity);
  g("mill_worker_saturation_ratio", "Fleet busy fraction: inflight / capacity (0..1)", capacity > 0 ? inFlight / capacity : 0);
  g("mill_queue_depth", "Jobs waiting in the queue", queueDepth);
  g("mill_queue_oldest_wait_seconds", "Age of the head-of-line queued job", oldestCreatedAt ? Math.max(0, (now - oldestCreatedAt) / 1000) : 0);
  g("mill_reconcile_synced", "1 if the repo is Synced", lastStatus?.sync === "Synced" ? 1 : 0);
  g("mill_reconcile_healthy", "1 if the repo is Healthy", lastStatus?.health === "Healthy" ? 1 : 0);
  g("mill_reconcile_age_seconds", "Seconds since the last reconcile pass", lastStatus ? Math.max(0, (now - lastStatus.at) / 1000) : 0);

  // ── counters (grouped from the Redis metrics hash) ──
  const byPrefix = (prefix: string) => Object.entries(counters).filter(([k]) => k.startsWith(prefix));
  const counterFamily = (metric: string, help_: string, prefix: string, label: string, keyToLabel: (k: string) => string) => {
    const rows = byPrefix(prefix);
    if (!rows.length) return;
    help(metric, help_, "counter");
    for (const [k, v] of rows) lines.push(`${metric}{${label}="${keyToLabel(k)}"} ${num(v)}`);
  };
  counterFamily("mill_jobs_total", "Jobs finished by status", "jobs_total:", "status", (k) => k.slice("jobs_total:".length));
  // Failures bucketed by cause — e.g. reason="workflow_not_found" ⇒ workers can't see /app/workdir.
  counterFamily("mill_jobs_failed_total", "Failed jobs by reason", "jobs_failed_reason:", "reason", (k) => k.slice("jobs_failed_reason:".length));
  // jobs_wf:<workflow>:<status> → two labels (workflow, status) for flexible querying.
  const wfRows = byPrefix("jobs_wf:");
  if (wfRows.length) {
    help("mill_jobs_by_workflow_total", "Jobs finished by workflow + status", "counter");
    for (const [k, v] of wfRows) {
      const rest = k.slice("jobs_wf:".length); const i = rest.lastIndexOf(":");
      lines.push(`mill_jobs_by_workflow_total{workflow="${rest.slice(0, i)}",status="${rest.slice(i + 1)}"} ${num(v)}`);
    }
  }
  counterFamily("mill_triggered_total", "Jobs enqueued by trigger type", "triggered:", "trigger", (k) => k.slice("triggered:".length));
  counterFamily("mill_reconcile_total", "Reconcile passes by result", "reconcile_total:", "result", (k) => k.slice("reconcile_total:".length));
  counterFamily("mill_ingress_total", "Ingress requests by outcome", "ingress_total:", "outcome", (k) => k.slice("ingress_total:".length));
  counterFamily("mill_concurrency_skipped_total", "Cron runs skipped by concurrencyPolicy", "concurrency_skipped:", "policy", (k) => k.slice("concurrency_skipped:".length));
  counterFamily("mill_concurrency_replaced_total", "Queued runs superseded by Replace policy", "concurrency_replaced:", "policy", (k) => k.slice("concurrency_replaced:".length));
  counterFamily("mill_dispatch_skipped_total", "Triggers skipped because the workflow won't compile", "dispatch_skipped:", "reason", (k) => k.slice("dispatch_skipped:".length));
  if (counters["retries_total"]) { help("mill_retries_total", "Run-level retries", "counter"); lines.push(`mill_retries_total ${num(counters["retries_total"])}`); }
  if (counters["ingress_auth_failures_total"]) { help("mill_ingress_auth_failures_total", "Ingress bearer auth failures", "counter"); lines.push(`mill_ingress_auth_failures_total ${num(counters["ingress_auth_failures_total"])}`); }

  // ── histograms (cumulative buckets + _sum + _count → real p50/p95/p99 in Prometheus) ──
  const histogram = (metric: string, h: string, name: string) => {
    if (!counters[`${name}_count`]) return;
    help(metric, h, "histogram");
    for (const le of [...MillQueue.BUCKETS.map(String), "+Inf"]) lines.push(`${metric}_bucket{le="${le}"} ${num(counters[`${name}_bucket:${le}`])}`);
    lines.push(`${metric}_sum ${num(counters[`${name}_sum`])}`, `${metric}_count ${num(counters[`${name}_count`])}`);
  };
  histogram("mill_job_duration_seconds", "Job execution duration", "job_duration_seconds");
  histogram("mill_job_wait_seconds", "Schedule→start wait", "job_wait_seconds");

  return c.text(lines.join("\n") + "\n", 200, { "content-type": "text/plain; version=0.0.4" });
});

// Fleet view: live workers (enriched), queue breakdown, and rolling execution stats.
api.get("/fleet", async (c) => {
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const [workers, queueDepth, window, queued, oldestCreatedAt] = await Promise.all([
    q.workers(),
    q.queueDepth(),
    q.completedWindow(hourAgo),
    q.queuedSpecs(),
    q.oldestQueuedCreatedAt(),
  ]);
  return c.json({
    workers,
    queueDepth,
    stats: computeStats(window, now),
    queue: computeQueueView(queued, queueDepth, oldestCreatedAt, now),
    now,
  });
});

// GitOps: current sync/health for the reconciled repo, and a manual reconcile trigger.
api.get("/status", (c) => c.json(lastStatus ?? { pending: true, repo: PROJECT_REPO ?? null, source: PROJECT_REPO ? "git" : "dir" }));
api.post("/reconcile", async (c) => {
  const s = await doReconcile({ force: true }); // a manual Sync always applies everything, regardless of autoSync
  return s ? c.json(s) : c.json({ error: "no PROJECT_REPO configured — reading from a mounted dir" }, 400);
});

// Manual Sync (applies the pending revision). v1 is single-repo, so this applies the whole
// workspace; per-project selective apply is a documented follow-up (needs an assembled live dir).
api.post("/projects/:id/sync", async (c) => {
  const s = await doReconcile({ force: true });
  return s ? c.json(s) : c.json({ error: "no PROJECT_REPO configured" }, 400);
});

api.get("/triggers", (c) => c.json(triggerEngine.summary()));

// Recent runs for a workflow (newest first) — powers the editor's Run history.
api.get("/projects/:id/workflows/:wf/runs", async (c) => {
  const { id, wf } = c.req.param();
  const runs = await q.recentRuns(`${id}/${wf}`, 20);
  return c.json({ runs });
});

// Reconcile activity feed (newest first) for the project page.
api.get("/reconcile-events", (c) => c.json({ events: reconcileLog }));

// Tokenized ingress URLs for a project + its workflows (for the UI to show/copy).
api.get("/projects/:id/endpoints", (c) => {
  const { id } = c.req.param();
  if (!existsSync(join(PROJECTS_DIR, id, "project.yaml"))) return c.json({ error: "project not found" }, 404);
  // Only workflows that opt in with a `webhook` trigger have an HTTP endpoint. A project with
  // none exposes nothing — the UI shows a "no endpoints, add a webhook trigger" hint instead.
  const exposed = projWebhookWfs.get(id) ?? [];
  const workflows = exposed.map((w) => {
    const custom: string[] = [];
    try { const { def } = loadWorkflow(join(PROJECTS_DIR, id), w); for (const t of def.triggers) if (t.type === "webhook" && t.path) custom.push(`/p/w/${w}/${t.path}`); } catch { /* skip */ }
    return { workflow: w, path: `/p/w/${w}/${id}`, customPaths: custom };
  });
  return c.json({
    project: id,
    projectPath: workflows.length ? `/p/${id}` : null, // null → nothing exposed yet
    workflows,
    ingressEnabled: !!tokenFor(id), // a bearer token is configured (global or per-project)
    authRequired: !!tokenFor(id),
    perProjectToken: projectTokens.has(id),
  });
});

// What a Sync would apply: the name-status diff between the live and target revisions.
api.get("/projects/:id/diff", async (c) => {
  const { id } = c.req.param();
  if (!repoState || !lastStatus) return c.json({ diff: [], synced: true });
  const diff = await diffToApply(repoState, lastStatus.targetRevision, id).catch(() => []);
  return c.json({
    diff,
    synced: lastStatus.sync === "Synced",
    targetRevision: lastStatus.targetRevision,
    syncedRevision: lastStatus.syncedRevision,
  });
});

// Delete a workflow (script) — removes it from git and reconciles.
// Register a new project: write <id>/project.yaml, commit, reconcile. v1 is single-repo,
// folder-per-project, so a "new project" is a new folder in the tracked repo.
api.post("/projects", async (c) => {
  if (!repoState) return c.json({ error: "creating a project requires a git-backed workspace (PROJECT_REPO)" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(id)) return c.json({ error: "project id must be 2–40 chars: lowercase letters, digits, hyphens" }, 400);
  if (existsSync(join(PROJECTS_DIR, id, "project.yaml"))) return c.json({ error: `project '${id}' already exists` }, 409);
  const yaml = yamlStringify({
    apiVersion: "mill/v1", kind: "Project", metadata: { name: id },
    sync: { autoSync: body.autoSync ?? true, selfHeal: body.selfHeal ?? true, prune: body.prune ?? false },
  });
  try {
    await writePaths(repoState, [{ path: `${id}/project.yaml`, content: yaml }], `create project ${id}`);
    const s = await doReconcile({ force: true });
    return c.json({ created: id, status: s });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Author/edit a workflow: Save = commit. Serializes workflow.yaml + node .js files, but
// validates the whole workflow FIRST (Zod + build) so the editor gets a 400 with issues
// instead of pushing a broken commit. Then writes + pushes + reconciles.
api.post("/projects/:id/workflows/:wf", async (c) => {
  const { id, wf } = c.req.param();
  if (!repoState) return c.json({ error: "save requires a git-backed workspace (PROJECT_REPO)" }, 400);
  let payload: { message?: string; workflow?: unknown; files?: Record<string, string> };
  try { payload = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const def = payload.workflow;
  const files = payload.files ?? {};

  // Validate the workflow definition before writing anything.
  const parsed = parseWorkflow(def);
  if (!parsed.ok) return c.json({ error: "workflow is invalid", issues: parsed.issues }, 400);

  // Every jscode/loop file referenced by a node must be provided (or already on disk is fine,
  // but for a Save we require the current contents so the commit is self-consistent).
  const base = `${id}/workflows/${wf}`;
  const writes: { path: string; content: string }[] = [
    { path: `${base}/workflow.yaml`, content: yamlStringify(def) },
  ];
  for (const [rel, content] of Object.entries(files)) {
    if (rel.includes("..")) return c.json({ error: `illegal file path '${rel}'` }, 400);
    writes.push({ path: `${base}/${rel}`, content });
  }

  try {
    await writePaths(repoState, writes, payload.message?.trim() || `save workflow ${id}/${wf}`);
    const s = await doReconcile({ force: true });
    return c.json({ saved: `${id}/${wf}`, files: writes.map((w) => w.path), status: s });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

api.delete("/projects/:id/workflows/:wf", async (c) => {
  const { id, wf } = c.req.param();
  if (!repoState) return c.json({ error: "delete requires a git-backed workspace (PROJECT_REPO)" }, 400);
  try {
    await deletePaths(repoState, [`${id}/workflows/${wf}`], `delete workflow ${id}/${wf}`);
    const s = await doReconcile({ force: true });
    return c.json({ deleted: `${id}/${wf}`, status: s });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Delete an entire project.
api.delete("/projects/:id", async (c) => {
  const { id } = c.req.param();
  if (!repoState) return c.json({ error: "delete requires a git-backed workspace (PROJECT_REPO)" }, 400);
  try {
    await deletePaths(repoState, [id], `delete project ${id}`);
    const s = await doReconcile({ force: true });
    return c.json({ deleted: id, status: s });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Export a project as a standalone, runnable bundle (.tar.gz) — ARCHITECTURE §7.
api.get("/projects/:id/export", async (c) => {
  try {
    const { tgz, name } = await exportProject(join(PROJECTS_DIR, c.req.param("id")));
    return new Response(tgz, {
      headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}.tar.gz"` },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.route("/api", api);

// Webhook trigger: an external POST kicks off a run (input = request body).
// Git push webhook → reconcile IMMEDIATELY (instead of waiting for the ~15s poll). Point your
// GitHub/GitLab repo webhook here. If MILL_GIT_WEBHOOK_SECRET is set, the GitHub HMAC
// (X-Hub-Signature-256 over the raw body) is verified.
app.post("/git/webhook", async (c) => {
  const raw = await c.req.text().catch(() => "");
  const secret = process.env.MILL_GIT_WEBHOOK_SECRET;
  if (secret) {
    const sig = c.req.header("x-hub-signature-256") ?? "";
    const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    if (!safeEq(sig, expected)) { q.metricInc("git_webhook:unauthorized").catch(() => {}); return c.json({ error: "invalid signature" }, 401); }
  }
  if (!repoState) return c.json({ error: "no PROJECT_REPO configured" }, 400);
  q.metricInc("git_webhook:ok").catch(() => {});
  const s = await doReconcile(); // honors MILL_AUTOSYNC (auto-applies or holds as configured)
  log.info("git webhook → reconcile", { sync: s?.sync, rev: s?.syncedRevision?.slice(0, 7) });
  return c.json({ reconciled: true, sync: s?.sync, syncedRevision: s?.syncedRevision, targetRevision: s?.targetRevision });
});

app.post("/hooks/:project/:workflow", async (c) => {
  const { project, workflow } = c.req.param();
  const dir = join(PROJECTS_DIR, project);
  if (!existsSync(join(dir, "workflows", workflow, "workflow.yaml"))) return c.json({ error: "workflow not found" }, 404);
  const badHook = runnableError(dir, workflow);
  if (badHook) return c.json({ error: `workflow '${workflow}' won't compile: ${badHook}` }, 422);
  const body = await c.req.json().catch(() => ({}));
  const jobId = enqueueJob(dir, workflow, (body && body.input) ?? body ?? {}, "webhook");
  return c.json({ jobId, via: "webhook" });
});

// ── Tokenized ingress (REST/HTTP) ────────────────────────────────────────────
// Trigger a workflow from an external request: GET → query params as input; other methods
// → JSON body (`{input}` or the whole body). `?wait=1` runs synchronously and returns the
// result (bounded); otherwise returns `{ jobId }` immediately (webhook-style).
async function ingressTrigger(c: Parameters<Parameters<typeof app.all>[1]>[0], project: string, workflow: string): Promise<Response> {
  const dir = join(PROJECTS_DIR, project);
  if (!existsSync(join(dir, "workflows", workflow, "workflow.yaml"))) return c.json({ error: "workflow not found" }, 404);
  const badWf = runnableError(dir, workflow);
  if (badWf) return c.json({ error: `workflow '${workflow}' won't compile: ${badWf}` }, 422);
  const url = new URL(c.req.url);
  const method = c.req.method;
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const query = Object.fromEntries(url.searchParams.entries());
  const contentType = (headers["content-type"] ?? "").toLowerCase();

  // Capture the RAW body (so JS can parse ANY format + verify HMAC signatures), plus a
  // best-effort parsed `input` for convenience. Real webhooks: JSON (Stripe/GitHub),
  // form-urlencoded (Acuity/Twilio), XML, or anything else.
  let raw = "";
  let input: unknown = {};
  if (method === "GET") {
    input = query;
  } else {
    raw = await c.req.text().catch(() => "");
    if (contentType.includes("json")) {
      try { const b = JSON.parse(raw); input = (b && typeof b === "object" && "input" in b) ? b.input : b; } catch { input = {}; }
    } else if (contentType.includes("form-urlencoded")) {
      input = Object.fromEntries(new URLSearchParams(raw));
    } else {
      try { input = raw ? JSON.parse(raw) : {}; } catch { input = raw ? { raw } : {}; } // best-effort JSON, else raw text
    }
  }
  const request = { method, contentType, headers, query, raw }; // → ctx.request in the workflow
  const jobId = enqueueJob(dir, workflow, input, "webhook", request);
  q.metricInc("ingress_total:ok").catch(() => {});
  const wait = url.searchParams.get("wait");
  if (wait === "1" || wait === "true") {
    for (let i = 0; i < 150; i++) { // up to ~30s
      await Bun.sleep(200);
      const j = await q.getJob(jobId);
      if (j.status === "succeeded" || j.status === "failed") {
        return c.json({ jobId, status: j.status, result: j.result ? JSON.parse(j.result) : null, error: j.error || undefined }, j.status === "failed" ? 500 : 200);
      }
    }
    return c.json({ jobId, status: "running", poll: `/api/jobs/${jobId}` }, 202);
  }
  return c.json({ jobId, status: "queued" }, 202);
}

// Per-workflow endpoint: the-mill.example.com/p/w/<workflow>/<path>  (path = project id, or a custom webhook token)
app.all("/p/w/:workflow/:path", async (c) => {
  const { workflow, path } = c.req.param();
  const route = wfRoutes.get(`${workflow}/${path}`);
  if (!route) return c.json({ error: `no workflow endpoint '/p/w/${workflow}/${path}'` }, 404);
  // Capability URL: the unguessable path IS the credential — no Authorization header required
  // (this is how header-less providers like Acuity reach us). Otherwise require the bearer.
  if (!capabilityRoutes.has(`${workflow}/${path}`)) {
    const bad = bearerGuard(c, route.project); if (bad) return bad; // per-project token
  }
  return ingressTrigger(c, route.project, route.workflow);
});

// Per-project endpoint: GET lists exposed workflow URLs; POST triggers the sole/only workflow.
app.get("/p/:path", (c) => {
  const project = projRoutes.get(c.req.param("path"));
  if (!project) return c.json({ error: "no such project endpoint" }, 404);
  const bad = bearerGuard(c, project); if (bad) return bad;
  const origin = new URL(c.req.url).origin;
  const workflows = (projWebhookWfs.get(project) ?? []).map((w) => ({ workflow: w, url: `${origin}/p/w/${w}/${project}` }));
  return c.json({ project, url: `${origin}/p/${project}`, workflows });
});
app.post("/p/:path", async (c) => {
  const project = projRoutes.get(c.req.param("path"));
  if (!project) return c.json({ error: "no such project endpoint" }, 404);
  const bad = bearerGuard(c, project); if (bad) return bad;
  const wfs = projWebhookWfs.get(project) ?? []; // only webhook-exposed workflows
  if (wfs.length === 1) return ingressTrigger(c, project, wfs[0]);
  return c.json({ error: "project exposes multiple workflows — POST to /p/w/<workflow>/" + project, workflows: wfs }, 400);
});

// ── static UIs (built on the host, copied into the image) ────────────────────
// Registered last so API routes above always win. /console is the raw fallback console.
app.get("/console", (c) => c.html(consoleHtml));

const WEB_LIVE = resolve(import.meta.dir, "../../../web-live");
const WEB_PROTO = resolve(import.meta.dir, "../../../web-prototype");
const liveIndex = existsSync(join(WEB_LIVE, "index.html")) ? readFileSync(join(WEB_LIVE, "index.html"), "utf8") : null;

// In-app developer guide (self-contained HTML, bundled from apps/web/public). Served at /help.
const helpHtml = existsSync(join(WEB_LIVE, "developer-guide.html")) ? readFileSync(join(WEB_LIVE, "developer-guide.html"), "utf8") : null;
app.get("/help", (c) => (helpHtml ? c.html(helpHtml) : c.json({ error: "developer guide not built" }, 404)));
const protoIndex = existsSync(join(WEB_PROTO, "index.html")) ? readFileSync(join(WEB_PROTO, "index.html"), "utf8") : null;

if (protoIndex) {
  // Mock prototype under /prototype (its assets were built with base=/prototype/).
  app.use("/prototype/*", serveStatic({ root: "./web-prototype", rewriteRequestPath: (p) => p.replace(/^\/prototype/, "") || "/" }));
  app.get("/prototype", (c) => c.html(protoIndex));
  app.get("/prototype/*", (c) => c.html(protoIndex)); // SPA fallback
}
if (liveIndex) {
  // Live UI at the root (assets at /assets/*), wired to this controller.
  app.use("/assets/*", serveStatic({ root: "./web-live" }));
  app.get("/favicon.svg", serveStatic({ path: "./web-live/favicon.svg" }));
  app.get("/", (c) => c.html(liveIndex));
  app.get("*", (c) => c.html(liveIndex)); // SPA fallback for /workspace, /projects/… , /fleet, …
} else {
  app.get("/", (c) => c.html(consoleHtml)); // UI not built (dev) → raw console
}

log.info("mill-api listening", { port: PORT, projects: PROJECTS_DIR, redis: process.env.REDIS_URL ?? "redis://localhost:6379", ui: liveIndex ? "live+prototype" : "console" });
export default { port: PORT, fetch: app.fetch };
