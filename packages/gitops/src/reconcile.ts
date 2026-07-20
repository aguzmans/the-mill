import { join } from "node:path";
import { listProjects, loadProject, listWorkflows, loadWorkflow, validateNodeSources } from "@mill/projectfs";
import { buildPlan } from "@mill/compiler";
import { Git } from "./git";

export type Health = "Healthy" | "Degraded";
export type Sync = "Synced" | "OutOfSync";

export interface WorkflowStatus { name: string; ok: boolean; error?: string }
export interface ProjectStatus {
  id: string;
  health: Health;
  workflows: WorkflowStatus[];
  sync?: Sync; // per-project: Synced if this project is applied to target, else OutOfSync (held)
  appliedRevision?: string; // the revision this project's live state is at
  autoSync?: boolean; // this project's declared sync.autoSync
}

export interface ReconcileStatus {
  targetRevision: string; // desired: origin/<branch> HEAD
  syncedRevision: string; // live: overall (= target only when every project is applied)
  sync: Sync;
  health: Health;
  projects: ProjectStatus[];
  error?: string;
}

/** Repo the controller reconciles. syncedRevision advances only on a clean, applied revision. */
export interface RepoState {
  dir: string; // working copy
  branch: string;
  syncedRevision: string;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Validate every project + workflow in a tree (folder-per-project). */
export function validateTree(root: string): { ok: boolean; projects: ProjectStatus[] } {
  const projects: ProjectStatus[] = [];
  let ok = true;
  for (const id of listProjects(root)) {
    const dir = join(root, id);
    try {
      loadProject(dir);
    } catch (e) {
      ok = false;
      projects.push({ id, health: "Degraded", workflows: [{ name: "project.yaml", ok: false, error: msg(e) }] });
      continue;
    }
    const workflows: WorkflowStatus[] = [];
    for (const name of listWorkflows(dir)) {
      try {
        const { def, dir: wfDir } = loadWorkflow(dir, name);
        buildPlan(def); // structural (graph) validity — a failure blocks applying the revision
        // Node source must actually parse. A broken .js marks the workflow Degraded and blocks
        // its dispatch, but does NOT block the repo apply (healthy workflows keep serving).
        const src = validateNodeSources(wfDir, def);
        if (src.length) workflows.push({ name, ok: false, error: src.map((e) => `${e.node}: ${e.error}`).join("; ") });
        else workflows.push({ name, ok: true });
      } catch (e) {
        ok = false;
        workflows.push({ name, ok: false, error: msg(e) });
      }
    }
    projects.push({ id, health: workflows.every((w) => w.ok) ? "Healthy" : "Degraded", workflows });
  }
  return { ok, projects };
}

/**
 * One reconcile pass (level-triggered, idempotent): fetch → validate the target in a throwaway
 * worktree → apply (checkout) ONLY if it compiles AND `opts.apply` is on. When apply is off
 * (autoSync disabled) a validated new revision is HELD (OutOfSync) until a manual Sync.
 */
export async function reconcile(state: RepoState, opts: { apply?: boolean } = {}): Promise<ReconcileStatus> {
  const apply = opts.apply !== false; // default: auto-apply
  try {
    await Git.fetch(state.dir);
    const target = await Git.revParse(state.dir, `origin/${state.branch}`);

    const candidate = `${state.dir}.candidate`;
    await Git.worktreeRemove(state.dir, candidate);
    await Git.worktreeAdd(state.dir, candidate, target);
    let v: { ok: boolean; projects: ProjectStatus[] };
    try { v = validateTree(candidate); } finally { await Git.worktreeRemove(state.dir, candidate); }

    const pending = v.ok && !apply && state.syncedRevision !== target;
    if (v.ok && apply) {
      await Git.checkoutDetach(state.dir, target); // advance the serving copy
      state.syncedRevision = target;
    }

    return {
      targetRevision: target,
      syncedRevision: state.syncedRevision,
      sync: v.ok && state.syncedRevision === target ? "Synced" : "OutOfSync",
      // Health reflects per-workflow status (incl. broken node source), independent of the
      // apply gate (`v.ok`, structural) — a repo can be Synced yet Degraded on one workflow.
      health: v.projects.every((p) => p.health === "Healthy") ? "Healthy" : "Degraded",
      projects: v.projects,
      error: !v.ok
        ? `revision ${Git.short(target)} failed to validate — keeping last-known-good ${Git.short(state.syncedRevision)}`
        : pending
          ? `new revision ${Git.short(target)} validated but held — autoSync is off; click Sync to apply`
          : undefined,
    };
  } catch (e) {
    return {
      targetRevision: state.syncedRevision,
      syncedRevision: state.syncedRevision,
      sync: "OutOfSync",
      health: "Degraded",
      projects: [],
      error: msg(e),
    };
  }
}

/**
 * A UI write: remove paths from the tracked branch and push (Save/Delete → a git commit).
 * Works on the branch tip (not the reconciler's detached HEAD); the next reconcile adopts it.
 */
export async function deletePaths(state: RepoState, relPaths: string[], message: string): Promise<void> {
  const { rmSync, existsSync } = await import("node:fs");
  await Git.fetch(state.dir);
  await Git.checkoutBranch(state.dir, state.branch);
  let removed = 0;
  for (const p of relPaths) {
    const abs = join(state.dir, p);
    if (existsSync(abs)) { rmSync(abs, { recursive: true, force: true }); removed++; }
  }
  if (removed === 0) throw new Error("nothing to delete");
  await Git.add(state.dir);
  await Git.commit(state.dir, message);
  await Git.push(state.dir, state.branch);
}

/**
 * A UI authoring write: create/update files on the tracked branch and push (Save → commit).
 * Writes are relative to the repo root; parent dirs are created. The next reconcile adopts
 * the new revision (validate-before-apply still guards a broken commit).
 */
export async function writePaths(state: RepoState, files: { path: string; content: string }[], message: string): Promise<void> {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  if (!files.length) throw new Error("nothing to write");
  await Git.fetch(state.dir);
  await Git.checkoutBranch(state.dir, state.branch);
  for (const f of files) {
    if (f.path.includes("..")) throw new Error(`illegal path '${f.path}'`); // no escaping the repo
    const abs = join(state.dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  await Git.add(state.dir);
  await Git.commit(state.dir, message);
  await Git.push(state.dir, state.branch);
}

export interface DiffEntry { change: "added" | "modified" | "deleted" | "renamed"; path: string }

/** What a Sync would apply: name-status diff between the live (synced) and target revisions. */
export async function diffToApply(state: RepoState, target: string, subpath?: string): Promise<DiffEntry[]> {
  if (!state.syncedRevision || !target || state.syncedRevision === target) return [];
  const raw = await Git.diffNameStatus(state.dir, state.syncedRevision, target, subpath).catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => {
    const [status, ...rest] = line.split("\t");
    const c = status[0];
    const change = c === "A" ? "added" : c === "D" ? "deleted" : c === "R" ? "renamed" : "modified";
    return { change, path: rest[rest.length - 1] };
  });
}

/** Clone (or open an existing) working copy and record the initial revision. */
export async function openRepo(url: string, dir: string, branch: string, token?: string): Promise<RepoState> {
  const { existsSync, mkdirSync, readdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    // `git clone` needs an empty target; a mounted PVC often isn't (it has `lost+found`).
    // Clone into a truly-empty dir, otherwise init the repo in place.
    if (readdirSync(dir).length === 0) await Git.clone(url, dir, token);
    else await Git.initFetchCheckout(url, dir, branch, token);
  }
  let syncedRevision = "";
  try {
    syncedRevision = await Git.headSha(dir); // empty on a fresh/empty repo (no commits yet)
  } catch { /* empty repo — reconcile will report it until a project is pushed */ }
  return { dir, branch, syncedRevision };
}
