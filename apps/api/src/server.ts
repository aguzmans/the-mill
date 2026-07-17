import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "hono/bun";
import Redis from "ioredis";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MillQueue } from "@mill/queue";
import { computeStats, computeQueueView } from "./fleet";
import { runNode } from "@mill/executor";

const ENV_SECRETS: Record<string, string> = process.env.MILL_SECRETS ? JSON.parse(process.env.MILL_SECRETS) : {};
import { loadProject, listWorkflows, loadWorkflow, listProjects, collectDeps } from "@mill/projectfs";
import { buildPlan } from "@mill/compiler";
import { openRepo, reconcile, deletePaths, writePaths, type RepoState, type ReconcileStatus } from "@mill/gitops";
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

function enqueueJob(projectDir: string, workflow: string, input: unknown): string {
  const jobId = "job_" + crypto.randomUUID().slice(0, 8);
  q.enqueue({ id: jobId, projectDir, workflow, input, revision: lastStatus?.syncedRevision }).catch((e) => console.error("enqueue failed:", e));
  return jobId;
}

// Cron + webhook triggers, rebuilt from the reconciled workflows on every reconcile.
const triggerEngine = new TriggerEngine((t, input) => {
  const jobId = enqueueJob(join(PROJECTS_DIR, t.project), t.workflow, input);
  console.log(`trigger[${t.type}] ${t.project}/${t.workflow} → ${jobId}`);
});

function syncTriggers() {
  const triggers: TriggerDef[] = [];
  for (const pid of listProjects(PROJECTS_DIR)) {
    for (const wname of listWorkflows(join(PROJECTS_DIR, pid))) {
      try {
        const { def } = loadWorkflow(join(PROJECTS_DIR, pid), wname);
        for (const t of def.triggers) triggers.push({ project: pid, workflow: wname, type: t.type, schedule: t.schedule, path: t.path, concurrencyPolicy: t.concurrencyPolicy });
      } catch { /* skip invalid workflow */ }
    }
  }
  triggerEngine.sync(triggers);
}
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

async function doReconcile(): Promise<(ReconcileStatus & { at: number }) | null> {
  if (!repoState) return null;
  const s = await reconcile(repoState);
  lastStatus = { ...s, at: Date.now() };
  if (s.sync === "Synced") await installDeps().catch((e) => console.error("deps install error:", e));
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
  console.log(`reconciled: ${lastStatus?.sync}/${lastStatus?.health} @ ${lastStatus?.syncedRevision?.slice(0, 7)}`);
  setInterval(() => { doReconcile().catch((e) => console.error("reconcile error:", e)); }, RECONCILE_MS);
}
initRepo().catch((e) => console.error("repo init failed:", e));
if (!PROJECT_REPO) syncTriggers(); // dir mode: register triggers from the mounted projects

const app = new Hono();
const api = new Hono(); // all JSON endpoints live under /api so they never collide with SPA routes
app.use("*", cors());

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
    return c.json({ workflow: def.metadata.name, nodes, edges: def.edges, triggers: def.triggers, order: plan.order });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

api.post("/projects/:id/workflows/:wf/trigger", async (c) => {
  const { id, wf } = c.req.param();
  const dir = join(PROJECTS_DIR, id);
  if (!existsSync(join(dir, "workflows", wf, "workflow.yaml"))) return c.json({ error: "workflow not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const jobId = "job_" + crypto.randomUUID().slice(0, 8);
  await q.enqueue({ id: jobId, projectDir: dir, workflow: wf, input: body?.input ?? {}, revision: lastStatus?.syncedRevision });
  return c.json({ jobId });
});

// Test-run a single step in isolation with a caller-supplied input (no upstream nodes run).
// Runs in-process on the controller — a fast dev/test affordance, not the hot path.
api.post("/projects/:id/workflows/:wf/nodes/:key/test", async (c) => {
  const { id, wf, key } = c.req.param();
  const dir = join(PROJECTS_DIR, id);
  if (!existsSync(join(dir, "workflows", wf, "workflow.yaml"))) return c.json({ error: "workflow not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const secrets = { ...ENV_SECRETS, ...(body?.secrets ?? {}) };
  try {
    const r = await runNode(dir, wf, key, body?.input ?? {}, secrets, lastStatus?.syncedRevision);
    return c.json(r, r.status === "failed" && r.error?.startsWith("no node") ? 404 : 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

api.get("/jobs/:id", async (c) => {
  const job = await q.getJob(c.req.param("id"));
  if (!Object.keys(job).length) return c.json({ error: "not found" }, 404);
  return c.json({ ...job, result: job.result ? JSON.parse(job.result) : null });
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
  const s = await doReconcile();
  return s ? c.json(s) : c.json({ error: "no PROJECT_REPO configured — reading from a mounted dir" }, 400);
});

api.get("/triggers", (c) => c.json(triggerEngine.summary()));

// Delete a workflow (script) — removes it from git and reconciles.
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
    const s = await doReconcile();
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
    const s = await doReconcile();
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
    const s = await doReconcile();
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
app.post("/hooks/:project/:workflow", async (c) => {
  const { project, workflow } = c.req.param();
  const dir = join(PROJECTS_DIR, project);
  if (!existsSync(join(dir, "workflows", workflow, "workflow.yaml"))) return c.json({ error: "workflow not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const jobId = enqueueJob(dir, workflow, (body && body.input) ?? body ?? {});
  return c.json({ jobId, via: "webhook" });
});

// ── static UIs (built on the host, copied into the image) ────────────────────
// Registered last so API routes above always win. /console is the raw fallback console.
app.get("/console", (c) => c.html(consoleHtml));

const WEB_LIVE = resolve(import.meta.dir, "../../../web-live");
const WEB_PROTO = resolve(import.meta.dir, "../../../web-prototype");
const liveIndex = existsSync(join(WEB_LIVE, "index.html")) ? readFileSync(join(WEB_LIVE, "index.html"), "utf8") : null;
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

console.log(`mill-api on :${PORT} · projects=${PROJECTS_DIR} · redis=${process.env.REDIS_URL ?? "redis://localhost:6379"} · ui=${liveIndex ? "live+prototype" : "console"}`);
export default { port: PORT, fetch: app.fetch };
