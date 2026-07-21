import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseProject, parseWorkflow, type WorkflowDef, type ProjectDef } from "@mill/core";

// Minimal read side of a project on disk (the in-memory index + watch come in M2).
// A project is a git repo: project.yaml + workflows/<name>/{workflow.yaml, nodes/*.js}.

export interface LoadedWorkflow {
  def: WorkflowDef;
  dir: string; // the workflow directory, for resolving node .js paths
}

function loadYaml(path: string): unknown {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  return parseYaml(readFileSync(path, "utf8"));
}

/** Project ids (folder names with a project.yaml) directly under `root`. */
export function listProjects(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "project.yaml")))
    .map((d) => d.name);
}

export function loadProject(projectDir: string): ProjectDef {
  const r = parseProject(loadYaml(join(projectDir, "project.yaml")));
  if (!r.ok) throw new Error(`invalid project.yaml:\n${r.issues.map((i) => `  - ${i.message}`).join("\n")}`);
  return r.value!;
}

export function listWorkflows(projectDir: string): string[] {
  const dir = join(projectDir, "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

export function loadWorkflow(projectDir: string, name: string): LoadedWorkflow {
  const dir = join(projectDir, "workflows", name);
  const r = parseWorkflow(loadYaml(join(dir, "workflow.yaml")));
  if (!r.ok) throw new Error(`invalid workflow '${name}':\n${r.issues.map((i) => `  - ${i.message}`).join("\n")}`);
  return { def: r.value!, dir };
}

/**
 * Parse every jscode/loop node's `.js` source for syntax errors (missing file counts too).
 * Catches a broken node BEFORE a job is dispatched — the graph compiling is not enough, the
 * node code must actually parse. Returns one entry per broken node ([] = all sources valid).
 */
export function validateNodeSources(dir: string, def: WorkflowDef): { node: string; error: string }[] {
  const errors: { node: string; error: string }[] = [];
  const transpiler = new Bun.Transpiler({ loader: "js" });
  for (const n of def.nodes) {
    const file = (n as { file?: string }).file;
    if (!file) continue; // only jscode / loop-with-file nodes have source
    const abs = join(dir, file);
    if (!existsSync(abs)) { errors.push({ node: n.key, error: `missing node file '${file}'` }); continue; }
    try { transpiler.transformSync(readFileSync(abs, "utf8")); }
    catch (e) { errors.push({ node: n.key, error: e instanceof Error ? e.message.split("\n")[0] : String(e) }); }
  }
  return errors;
}

/** Union of every node's declared npm `deps` across all workflows in a project. */
export function collectDeps(projectDir: string): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const name of listWorkflows(projectDir)) {
    try {
      const { def } = loadWorkflow(projectDir, name);
      for (const n of def.nodes) if (n.deps) Object.assign(deps, n.deps);
    } catch { /* a broken workflow is caught elsewhere; skip its deps */ }
  }
  return deps;
}

/**
 * Dynamically import a jscode node's default-exported function. `rev` (a git SHA) is
 * appended as a query so a new revision re-imports fresh — otherwise the module cache
 * would keep serving old code after a reconcile until the worker restarts.
 */
export async function loadNodeFn(workflowDir: string, file: string, rev?: string): Promise<(input: unknown, ctx: unknown) => unknown> {
  const spec = resolve(workflowDir, file) + (rev ? `?rev=${rev}` : "");
  const mod = await import(spec);
  const fn = mod.default;
  if (typeof fn !== "function") throw new Error(`node file '${file}' must default-export a function`);
  return fn;
}

// ── project bundles (ship code to workers via Redis — no shared filesystem) ──────
// A project is small text (project.yaml + workflows/**/{workflow.yaml,nodes/*.js}), so the
// controller packs the whole project into a flat { relPath: utf8 } map, publishes it to Redis
// keyed by revision, and a worker materializes it into its own ephemeral /tmp before running.
// This is the Windmill model (workers fetch code from the central store per job) with Redis as
// that store; it removes the controller↔worker shared /app/workdir entirely.
const BUNDLE_SKIP = new Set(["node_modules", ".git"]); // runtime cruft, never part of the source

/** Serialize a project directory to a flat { relPath: utf8-content } map. */
export function packProject(projectDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      if (BUNDLE_SKIP.has(d.name)) continue;
      const childAbs = join(abs, d.name);
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(childAbs, childRel);
      else if (d.isFile()) out[childRel] = readFileSync(childAbs, "utf8");
    }
  };
  walk(projectDir, "");
  return out;
}

/** Materialize a packed project map into `destProjectDir` (created if needed); returns it. */
export function unpackProject(files: Record<string, string>, destProjectDir: string): string {
  for (const [rel, content] of Object.entries(files)) {
    if (rel.includes("..") || rel.startsWith("/")) throw new Error(`illegal bundle path '${rel}'`);
    const abs = join(destProjectDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return destProjectDir;
}

/** Resolve a callScript ref (v1: "workflows/<name>" in the same project). */
export function resolveCallTarget(ref: string): string {
  if (ref.startsWith("workflows/")) return ref.slice("workflows/".length);
  if (ref.startsWith("std://")) throw new Error(`remote/standalone scripts are not supported in v1 (${ref})`);
  return ref;
}
