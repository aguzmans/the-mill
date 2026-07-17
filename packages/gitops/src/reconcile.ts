import { join } from "node:path";
import { listProjects, loadProject, listWorkflows, loadWorkflow } from "@mill/projectfs";
import { buildPlan } from "@mill/compiler";
import { Git } from "./git";

export type Health = "Healthy" | "Degraded";
export type Sync = "Synced" | "OutOfSync";

export interface WorkflowStatus { name: string; ok: boolean; error?: string }
export interface ProjectStatus { id: string; health: Health; workflows: WorkflowStatus[] }

export interface ReconcileStatus {
  targetRevision: string; // desired: origin/<branch> HEAD
  syncedRevision: string; // live: last-known-good actually checked out
  sync: Sync;
  health: Health;
  projects: ProjectStatus[];
  error?: string;
}

/** Repo the controller reconciles. syncedRevision advances only on a clean revision. */
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
        const { def } = loadWorkflow(dir, name);
        buildPlan(def);
        workflows.push({ name, ok: true });
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
 * One reconcile pass (level-triggered, idempotent):
 *   fetch → resolve origin/<branch> → validate that revision in a throwaway worktree →
 *   apply (checkout) ONLY if the whole tree compiles, else keep last-known-good.
 * Mutates state.syncedRevision when it advances.
 */
export async function reconcile(state: RepoState): Promise<ReconcileStatus> {
  try {
    await Git.fetch(state.dir);
    const target = await Git.revParse(state.dir, `origin/${state.branch}`);

    // Fetch/apply split: validate the candidate revision without disturbing the live copy.
    const candidate = `${state.dir}.candidate`;
    await Git.worktreeRemove(state.dir, candidate);
    await Git.worktreeAdd(state.dir, candidate, target);
    let v: { ok: boolean; projects: ProjectStatus[] };
    try {
      v = validateTree(candidate);
    } finally {
      await Git.worktreeRemove(state.dir, candidate);
    }

    if (v.ok) {
      await Git.checkoutDetach(state.dir, target); // advance the serving copy
      state.syncedRevision = target;
    }

    return {
      targetRevision: target,
      syncedRevision: state.syncedRevision,
      sync: v.ok && state.syncedRevision === target ? "Synced" : "OutOfSync",
      health: v.ok ? "Healthy" : "Degraded",
      projects: v.projects,
      error: v.ok ? undefined : `revision ${Git.short(target)} failed to validate — keeping last-known-good ${Git.short(state.syncedRevision)}`,
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

/** Clone (or open an existing) working copy and record the initial revision. */
export async function openRepo(url: string, dir: string, branch: string, token?: string): Promise<RepoState> {
  const { existsSync } = await import("node:fs");
  if (!existsSync(join(dir, ".git"))) {
    await Git.clone(url, dir, token);
  }
  let syncedRevision = "";
  try {
    syncedRevision = await Git.headSha(dir); // empty on a fresh/empty repo (no commits yet)
  } catch { /* empty repo — reconcile will report it until a project is pushed */ }
  return { dir, branch, syncedRevision };
}
