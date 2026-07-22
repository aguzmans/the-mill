import { buildPlan } from "@mill/compiler";
import { executePlan, makeCtx, checkSchema, WorkflowError, CancelledError, type RunEvent, type Ctx, type NodeFn } from "@mill/sdk";
import { loadWorkflow, loadNodeFn, resolveCallTarget } from "@mill/projectfs";
import type { CallTarget, Limits, PlanNode } from "@mill/core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Remote / standalone callScript ───────────────────────────────────────────
// A `std://…@ver` or `http(s)://…` ref points at a Mill export bundle (index.js + run.sh +
// package.json). We fetch + cache it, then `run.sh` installs its deps and runs the target
// workflow — the export format IS the remote-package format. (Runs at the same trust as a
// local node; untrusted remote code needs the microVM isolation tier.)
const REMOTE_CACHE = process.env.MILL_REMOTE_CACHE ?? join(tmpdir(), "mill-remote");

export function resolveRemoteUrl(ref: string): string {
  if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
  // std://<path>@<version> → <registry>/<path>@<version>.tgz
  const registry = process.env.MILL_STD_REGISTRY;
  if (!registry) throw new Error(`std:// ref needs MILL_STD_REGISTRY set (${ref})`);
  return `${registry.replace(/\/$/, "")}/${ref.slice("std://".length)}.tgz`;
}
const cacheKey = (url: string) => { let h = 5381; for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0; return "b" + (h >>> 0).toString(36); };

async function runRemoteBundle(ref: string, workflow: string, input: unknown): Promise<unknown> {
  const url = resolveRemoteUrl(ref);
  const dir = join(REMOTE_CACHE, cacheKey(url));
  if (!existsSync(join(dir, "index.js"))) {
    mkdirSync(dir, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`remote bundle ${url} → HTTP ${res.status}`);
    writeFileSync(join(dir, "bundle.tgz"), new Uint8Array(await res.arrayBuffer()));
    await Bun.spawn(["tar", "-xzf", "bundle.tgz"], { cwd: dir }).exited;
    if (!existsSync(join(dir, "index.js"))) throw new Error(`remote bundle ${url} is not a Mill export (no index.js)`);
  }
  const proc = Bun.spawn(["bash", join(dir, "run.sh"), workflow || "", JSON.stringify(input ?? {})], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`remote callScript '${ref}' failed: ${(err.trim() || out.trim()).slice(0, 300)}`);
  const last = out.trim().split("\n").pop() ?? "";
  try { return JSON.parse(last); } catch { return last; }
}
export const isRemoteRef = (ref: string) => ref.startsWith("std://") || ref.startsWith("http://") || ref.startsWith("https://");

export interface Job {
  projectDir: string;
  workflow: string;
  input: unknown;
  /** All secrets the worker holds (flat); each node sees only its declared refs. */
  secrets?: Record<string, string>;
  /** Git revision — cache-busts node imports so a reconciled change takes effect. */
  revision?: string;
  limits?: Partial<Limits>;
  /** Originating HTTP request (webhook runs) — surfaced on ctx.request. */
  request?: import("@mill/sdk").RequestCtx;
}

export interface ExecResult {
  status: "succeeded" | "failed" | "cancelled";
  result?: unknown;
  error?: string;
  events: RunEvent[];
  statuses?: Record<string, string>;
  ms: number;
}

/** The isolation seam (ARCHITECTURE §6): swap InProcess → Subprocess → nsjail → microVM. */
export interface Executor {
  execute(job: Job): Promise<ExecResult>;
}

/** Durability hooks for the top-level run: a journal of already-completed nodes (skipped on
 *  a retry) and a callback to persist each node as it finishes. */
export interface RunHooks {
  journal?: Record<string, unknown>;
  onNodeDone?: (key: string, output: unknown) => void;
  request?: import("@mill/sdk").RequestCtx;
  shouldCancel?: () => boolean | Promise<boolean>;
}

/** Load → compile → execute a workflow in-process, recursing for callScript. */
export async function runWorkflow(job: Job, onEvent?: (e: RunEvent) => void, hooks?: RunHooks): Promise<ExecResult> {
  const events: RunEvent[] = [];
  const sink = (e: RunEvent) => { events.push(e); onEvent?.(e); };
  const t0 = performance.now();
  try {
    const { result, statuses } = await runOne(job.projectDir, job.workflow, job.input, job.secrets ?? {}, sink, job.revision, { ...hooks, request: job.request });
    return { status: "succeeded", result, statuses, events, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    if (err instanceof CancelledError) {
      return { status: "cancelled", error: err.message, statuses: err.statuses, events, ms: Math.round(performance.now() - t0) };
    }
    const statuses = err instanceof WorkflowError ? err.statuses : undefined;
    return { status: "failed", error: err instanceof Error ? err.message : String(err), statuses, events, ms: Math.round(performance.now() - t0) };
  }
}

async function runOne(
  projectDir: string,
  name: string,
  input: unknown,
  secrets: Record<string, string>,
  sink: (e: RunEvent) => void,
  revision?: string,
  hooks?: RunHooks, // only the top-level plan journals; sub-workflows (callScript) run fresh
): Promise<{ result: unknown; statuses: Record<string, string> }> {
  const { def, dir } = loadWorkflow(projectDir, name);
  const plan = buildPlan(def);
  const r = await executePlan(plan, {
    input,
    secrets,
    loadNode: (node: PlanNode) => loadNodeFn(dir, node.file!, revision) as Promise<NodeFn>,
    callScript: async (call: CallTarget, cin: unknown, _ctx: Ctx) => {
      if (isRemoteRef(call.ref)) return runRemoteBundle(call.ref, call.workflow, cin); // standalone/remote bundle
      const target = resolveCallTarget(call.ref);
      const sub = await runOne(projectDir, target, cin, secrets, sink, revision);
      return sub.result;
    },
    onEvent: sink,
    journal: hooks?.journal,
    onNodeDone: hooks?.onNodeDone,
    request: hooks?.request, // ctx.request on the top-level workflow's nodes
    shouldCancel: hooks?.shouldCancel, // cooperative cancel at each node boundary
  });
  return { result: r.result, statuses: r.statuses };
}

export interface NodeRunResult {
  status: "succeeded" | "failed";
  node: string;
  kind: string;
  output?: unknown;
  error?: string;
  logs: RunEvent[];
  ms: number;
}

/**
 * Run ONE node in isolation with a caller-supplied input — the "test this step" primitive.
 * Loads + compiles the workflow (so the node's file/call/each are resolved exactly as in a
 * real run), then executes just that node's logic against `input`. No upstream nodes run.
 */
export async function runNode(
  projectDir: string,
  workflow: string,
  nodeKey: string,
  input: unknown,
  secrets: Record<string, string> = {},
  revision?: string,
): Promise<NodeRunResult> {
  const logs: RunEvent[] = [];
  const sink = (e: RunEvent) => logs.push(e);
  const t0 = performance.now();
  const { def, dir } = loadWorkflow(projectDir, workflow);
  const plan = buildPlan(def);
  const node = plan.nodes[nodeKey];
  if (!node) {
    return { status: "failed", node: nodeKey, kind: "?", error: `no node '${nodeKey}' in workflow '${workflow}'`, logs, ms: 0 };
  }
  const state: Record<string, unknown> = {};
  const ctx = makeCtx({ node: nodeKey, inputs: {}, allSecrets: secrets, declared: node.secrets, state, onEvent: sink });
  const evalExpr = (expr: string) => new Function("input", "ctx", `"use strict"; return (${expr});`)(input, ctx);
  try {
    if (node.inputSchema) checkSchema(node.inputSchema, input, "input", nodeKey); // enforce the declared input schema
    let output: unknown;
    switch (node.kind) {
      case "start":
      case "end":
        output = input; // pass-through nodes
        break;
      case "jscode": {
        const fn = (await loadNodeFn(dir, node.file!, revision)) as NodeFn;
        output = await fn(input, ctx);
        break;
      }
      case "callScript": {
        if (isRemoteRef(node.call!.ref)) { output = await runRemoteBundle(node.call!.ref, node.call!.workflow, input); break; }
        const target = resolveCallTarget(node.call!.ref);
        const sub = await runOne(projectDir, target, input, secrets, sink, revision);
        output = sub.result;
        break;
      }
      case "if": {
        const taken = Boolean(evalExpr(node.condition ?? "false")) ? "true" : "false";
        output = { branch: taken, value: input }; // show which edge the tester's input would take
        break;
      }
      case "loop": {
        const arr = node.each ? evalExpr(node.each) : input;
        if (!Array.isArray(arr)) throw new Error(`loop '${nodeKey}' expected an array (each: ${node.each ?? "input"}), got ${arr === null ? "null" : typeof arr}`);
        const bodyFn = node.file ? ((await loadNodeFn(dir, node.file, revision)) as NodeFn) : null;
        const results: unknown[] = [];
        for (let i = 0; i < arr.length; i++) {
          state.index = i;
          state.item = arr[i];
          results.push(bodyFn ? await bodyFn(arr[i], ctx) : (isRemoteRef(node.call!.ref) ? await runRemoteBundle(node.call!.ref, node.call!.workflow, arr[i]) : (await runOne(projectDir, resolveCallTarget(node.call!.ref), arr[i], secrets, sink, revision)).result));
        }
        output = results;
        break;
      }
      case "fanout": {
        const targets = node.each ? evalExpr(node.each) : input;
        if (!Array.isArray(targets)) throw new Error(`fanout '${nodeKey}' expected an array of targets (each: ${node.each ?? "input"})`);
        output = await Promise.all((targets as { ref?: string; workflow?: string; input?: unknown }[]).map(async (t) => {
          const ref = t.ref ?? (t.workflow ? `workflows/${t.workflow}` : "");
          const label = t.workflow ?? ref;
          if (!ref) return { workflow: label, ok: false, error: "target missing ref/workflow" };
          try {
            const r = isRemoteRef(ref) ? await runRemoteBundle(ref, t.workflow ?? "", t.input ?? input) : (await runOne(projectDir, resolveCallTarget(ref), t.input ?? input, secrets, sink, revision)).result;
            return { workflow: label, ok: true, result: r };
          } catch (e) { return { workflow: label, ok: false, error: e instanceof Error ? e.message : String(e) }; }
        }));
        break;
      }
    }
    if (node.outputSchema) checkSchema(node.outputSchema, output, "output", nodeKey); // enforce the declared output schema
    return { status: "succeeded", node: nodeKey, kind: node.kind, output, logs, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { status: "failed", node: nodeKey, kind: node.kind, error: err instanceof Error ? err.message : String(err), logs, ms: Math.round(performance.now() - t0) };
  }
}

/** Runs the workflow in this process. Fast; no isolation (dev/CLI + tests). */
export class InProcessExecutor implements Executor {
  execute(job: Job): Promise<ExecResult> {
    return runWorkflow(job);
  }
}

/**
 * Runs the workflow in a separate Bun process via the CLI, enforcing a wall-clock cap
 * (kill on timeout). This is the OS-level boundary the nsjail wrapper will harden on the
 * host (userns/seccomp/cgroups + memory caps); the seam is identical.
 */
export class SubprocessExecutor implements Executor {
  constructor(private cliEntry: string, private defaultWallMs = 60_000) {}

  async execute(job: Job): Promise<ExecResult> {
    const wallMs = job.limits?.wallMs ?? this.defaultWallMs;
    const t0 = performance.now();
    const proc = Bun.spawn(
      ["bun", this.cliEntry, "run", job.projectDir, job.workflow, "--input", JSON.stringify(job.input ?? null), "--json"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, MILL_SECRETS: JSON.stringify(job.secrets ?? {}), ...(job.request ? { MILL_REQUEST: JSON.stringify(job.request) } : {}) } },
    );
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, wallMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    const ms = Math.round(performance.now() - t0);

    if (timedOut) return { status: "failed", error: `wall-clock timeout after ${wallMs}ms`, events: [], ms };
    const line = out.trim().split("\n").filter(Boolean).at(-1);
    try {
      const parsed = JSON.parse(line ?? "");
      return { ...parsed, ms } as ExecResult;
    } catch {
      return { status: "failed", error: `worker produced no result: ${(err || out).trim().slice(0, 400)}`, events: [], ms };
    }
  }
}

/**
 * The isolation rung (ARCHITECTURE §6): run each job in its own hardened container —
 * separate PID/net/mount/user namespaces + cgroup memory/cpu/pids caps + dropped
 * capabilities + read-only rootfs + no-new-privileges, and no network unless the job
 * asks for it. This is real OS-level isolation (the nsjail/microVM rungs swap in behind
 * the same seam). The reconciled working copy is mounted read-only; results come back
 * as the CLI's --json output.
 */
export class DockerExecutor implements Executor {
  constructor(private opts: { image: string; workdirVolume?: string; cliPath?: string; defaultWallMs?: number }) {}

  async execute(job: Job): Promise<ExecResult> {
    const t0 = performance.now();
    const mem = job.limits?.memMB ?? 512;
    const wallMs = job.limits?.wallMs ?? this.opts.defaultWallMs ?? 60_000;
    const network = job.limits?.network === "none" ? "none" : "bridge";
    const cli = this.opts.cliPath ?? "/app/apps/cli/src/mill.ts";
    const name = "mill-run-" + crypto.randomUUID().slice(0, 8);

    const args = [
      "run", "--rm", "--name", name,
      "--memory", `${mem}m`, "--memory-swap", `${mem}m`,
      "--cpus", "1", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--tmpfs", "/tmp:size=64m",
      "--network", network,
      "-e", `MILL_SECRETS=${JSON.stringify(job.secrets ?? {})}`,
    ];
    if (job.request) args.push("-e", `MILL_REQUEST=${JSON.stringify(job.request)}`);
    if (this.opts.workdirVolume) args.push("-v", `${this.opts.workdirVolume}:/app/workdir:ro`);
    args.push(this.opts.image, "bun", cli, "run", job.projectDir, job.workflow, "--input", JSON.stringify(job.input ?? {}), "--json");

    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; Bun.spawn(["docker", "rm", "-f", name]); }, wallMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    clearTimeout(timer);
    const ms = Math.round(performance.now() - t0);

    if (timedOut) return { status: "failed", error: `wall-clock timeout after ${wallMs}ms (container killed)`, events: [], ms };
    const line = out.trim().split("\n").filter(Boolean).at(-1);
    try {
      return { ...(JSON.parse(line ?? "") as ExecResult), ms };
    } catch {
      // Non-zero without JSON usually means the sandbox killed it (OOM=137, etc.).
      const reason = code === 137 ? "killed (out of memory / limit exceeded)" : (err || out).trim().slice(0, 300);
      return { status: "failed", error: `isolated run failed [exit ${code}]: ${reason}`, events: [], ms };
    }
  }
}
