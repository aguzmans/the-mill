import type { ExecPlan, PlanNode, CallTarget } from "@mill/core";
import { makeCtx, type Ctx, type RunEvent } from "./ctx";

export type NodeFn = (input: unknown, ctx: Ctx) => unknown | Promise<unknown>;
export type NodeStatus = "succeeded" | "failed" | "skipped";

export interface ExecuteDeps {
  input: unknown;
  /** All secrets the worker holds; per-node scrubbing happens in makeCtx. */
  secrets?: Record<string, string>;
  /** Resolve a jscode node to its default-exported function (dynamic import). */
  loadNode: (node: PlanNode) => Promise<NodeFn>;
  /** Invoke another script (callScript). The caller resolves + runs the target. */
  callScript: (call: CallTarget, input: unknown, ctx: Ctx) => Promise<unknown>;
  onEvent?: (e: RunEvent) => void;
  /** Node-boundary journal: outputs of nodes that already completed in a prior attempt.
   *  Present keys are skipped (their output reused) — retries don't re-do finished work. */
  journal?: Record<string, unknown>;
  /** Called when a node completes, so the caller can persist it to the journal (durability). */
  onNodeDone?: (key: string, output: unknown) => void;
  /** Originating HTTP request for webhook runs — exposed on every node's ctx.request. */
  request?: import("./ctx").RequestCtx;
  /** Cooperative cancellation — checked at each node boundary. Return true to stop the run
   *  gracefully (a `cancel` request from the API). Nodes already running finish first. */
  shouldCancel?: () => boolean | Promise<boolean>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RunResult {
  result: unknown;
  outputs: Record<string, unknown>;
  statuses: Record<string, NodeStatus>;
}

export class WorkflowError extends Error {
  constructor(public node: string, public override cause: unknown, public statuses: Record<string, NodeStatus> = {}) {
    super(`node '${node}' failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WorkflowError";
  }
}

/** Thrown when a run is cancelled at a node boundary (a `cancel` request). Carries the statuses
 *  so the run records which nodes finished before the stop. */
export class CancelledError extends Error {
  constructor(public node: string, public statuses: Record<string, NodeStatus> = {}) {
    super(`run cancelled at node '${node}'`);
    this.name = "CancelledError";
  }
}

function evalCondition(expr: string, input: unknown, ctx: Ctx): boolean {
  // The `if` condition is a JS boolean expression over the upstream output (`input`) + ctx.
  const fn = new Function("input", "ctx", `"use strict"; return (${expr});`);
  return Boolean(fn(input, ctx));
}

/**
 * Enforce a node's input/output schema — a JS boolean expression. The value is bound to
 * both `input` and `output` so an outputSchema can read `output.x` and an inputSchema `input.x`.
 * A falsy result (or a throwing expression) fails the node with a clear message.
 */
export function checkSchema(expr: string, value: unknown, which: "input" | "output", key: string): void {
  let ok: boolean;
  try {
    ok = Boolean(new Function("input", "output", `"use strict"; return (${expr});`)(value, value));
  } catch (e) {
    throw new Error(`${which} schema of '${key}' errored: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ok) throw new Error(`${which} schema violation on '${key}': ${expr}`);
}

/** Resolve a loop's iterable: a JS expression over the upstream output (`input`) + ctx. */
function resolveEach(expr: string | undefined, input: unknown, ctx: Ctx): unknown {
  if (!expr) return input; // no expression → iterate the upstream output directly
  const fn = new Function("input", "ctx", `"use strict"; return (${expr});`);
  return fn(input, ctx);
}

/**
 * Walk a compiled plan. Branch-aware: an `if` activates only its taken branch, and a
 * node runs only if a live edge reaches it (otherwise it's skipped). Fan-in nodes read
 * every live parent via ctx.inputs. Fails fast: a throwing node aborts the run.
 */
export async function executePlan(plan: ExecPlan, deps: ExecuteDeps): Promise<RunResult> {
  const outputs: Record<string, unknown> = {};
  const statuses: Record<string, NodeStatus> = {};
  // Track activated *edges* (a parent only feeds a child if its edge was taken),
  // so an `if`'s untaken branch never counts as an input to a downstream join.
  const activated = new Map<string, Set<string>>();
  const activate = (from: string, to: string) => {
    const s = activated.get(to) ?? new Set<string>();
    s.add(from);
    activated.set(to, s);
  };
  const state: Record<string, unknown> = {};
  let result: unknown = undefined;

  // Workflow-level input schema: validate the RUN input up front, attributed to the start node,
  // so a malformed payload fails cleanly at the boundary instead of deep inside a node.
  if (plan.inputSchema) {
    try { checkSchema(plan.inputSchema, deps.input, "input", plan.workflow); }
    catch (e) { throw new WorkflowError(plan.startKey, e, {}); }
  }

  for (const key of plan.order) {
    const node = plan.nodes[key];
    if (!node) continue;
    // Cooperative cancellation: stop cleanly at this node boundary if a cancel was requested.
    if (await deps.shouldCancel?.()) throw new CancelledError(key, statuses);
    const runnable = key === plan.startKey || (activated.get(key)?.size ?? 0) > 0;
    if (!runnable) {
      statuses[key] = "skipped";
      continue;
    }

    // Only parents whose edge was activated feed this node (all such parents succeeded).
    const liveParents = node.parents.filter((p) => activated.get(key)?.has(p));
    const inputsMap: Record<string, unknown> = {};
    for (const p of liveParents) inputsMap[p] = outputs[p];
    const primary = liveParents.length ? outputs[liveParents[0]] : deps.input;

    // Journal skip: if this node completed in a prior attempt, reuse its output — retries
    // never re-do finished work (node-boundary durability). Only for the executable kinds.
    if (deps.journal && key in deps.journal && (node.kind === "jscode" || node.kind === "callScript" || node.kind === "loop")) {
      const out = deps.journal[key];
      outputs[key] = out;
      statuses[key] = "succeeded";
      for (const c of node.children) activate(key, c.to);
      deps.onEvent?.({ type: "log", node: key, level: "debug", message: "skipped — journaled from a prior attempt" });
      deps.onEvent?.({ type: "node", node: key, status: "succeeded", ms: 0 });
      continue;
    }

    const ctx = makeCtx({ node: key, inputs: inputsMap, allSecrets: deps.secrets ?? {}, declared: node.secrets, state, onEvent: deps.onEvent, request: deps.request });
    deps.onEvent?.({ type: "node", node: key, status: "running" });
    const t0 = performance.now();
    const attempts = Math.max(1, node.retry?.maxAttempts ?? 1);

    try {
      if (node.inputSchema) checkSchema(node.inputSchema, primary, "input", key); // validate before running
      let out: unknown;
      for (let attempt = 1; ; attempt++) {
        try {
          switch (node.kind) {
            case "start":
              out = deps.input;
              break;
            case "jscode": {
              const fn = await deps.loadNode(node);
              out = await fn(primary, ctx);
              break;
            }
            case "callScript":
              out = await deps.callScript(node.call!, primary, ctx);
              break;
            case "loop": {
              // forEach: iterate the resolved array, run the body (a per-item jscode file OR a
              // per-item callScript) once per item, sequentially, collecting the results. The
              // shared ctx.state carries across iterations; ctx.state.index/item expose position.
              const arr = resolveEach(node.each, primary, ctx);
              if (!Array.isArray(arr)) throw new Error(`loop '${key}' expected an array to iterate (each: ${node.each ?? "input"}), got ${arr === null ? "null" : typeof arr}`);
              ctx.log.info(`loop over ${arr.length} item(s)`, { count: arr.length });
              const bodyFn = node.file ? await deps.loadNode(node) : null; // load once, reuse per item
              const results: unknown[] = [];
              for (let i = 0; i < arr.length; i++) {
                ctx.state.index = i;
                ctx.state.item = arr[i];
                results.push(bodyFn ? await bodyFn(arr[i], ctx) : await deps.callScript(node.call!, arr[i], ctx));
              }
              out = results;
              break;
            }
            case "fanout": {
              // Dynamic N-way router: `each` (over the upstream output) yields a list of targets
              // `{ ref|workflow, input? }`; call them all IN PARALLEL, collecting a per-target
              // { workflow, ok, result|error } so one failure never kills the batch.
              const targets = resolveEach(node.each, primary, ctx);
              if (!Array.isArray(targets)) throw new Error(`fanout '${key}' expected an array of targets (each: ${node.each ?? "input"}), got ${targets === null ? "null" : typeof targets}`);
              ctx.log.info(`fanout → ${targets.length} target(s)`, { count: targets.length });
              out = await Promise.all((targets as { ref?: string; workflow?: string; input?: unknown }[]).map(async (t) => {
                const ref = t.ref ?? (t.workflow ? `workflows/${t.workflow}` : "");
                const label = t.workflow ?? ref;
                if (!ref) return { workflow: label, ok: false, error: "target missing ref/workflow" };
                try { return { workflow: label, ok: true, result: await deps.callScript({ workflow: t.workflow ?? ref, ref }, t.input ?? primary, ctx) }; }
                catch (e) { return { workflow: label, ok: false, error: e instanceof Error ? e.message : String(e) }; }
              }));
              break;
            }
            case "if": {
              const taken = evalCondition(node.condition ?? "false", primary, ctx) ? "true" : "false";
              out = primary;
              for (const c of node.children) if (c.branch === taken) activate(key, c.to);
              break;
            }
            case "end":
              out = primary;
              result = primary;
              break;
          }
          if (node.outputSchema) checkSchema(node.outputSchema, out, "output", key); // validate the result
          break; // node succeeded
        } catch (e) {
          if (attempt >= attempts) throw e; // out of attempts — fail the node
          const base = node.retry?.backoffMs ?? 0;
          const wait = node.retry?.jitter === false ? base * attempt : Math.round(base * attempt * (0.5 + Math.random()));
          deps.onEvent?.({ type: "log", node: key, level: "warn", message: `attempt ${attempt}/${attempts} failed: ${e instanceof Error ? e.message : String(e)} — retrying in ${wait}ms` });
          await sleep(wait);
        }
      }
      outputs[key] = out;
      statuses[key] = "succeeded";
      // Non-if nodes activate all successors unconditionally; `if` already gated above.
      if (node.kind !== "if") for (const c of node.children) activate(key, c.to);
      deps.onNodeDone?.(key, out); // journal the completed node for durability across retries
      deps.onEvent?.({ type: "node", node: key, status: "succeeded", ms: Math.round(performance.now() - t0) });
    } catch (err) {
      statuses[key] = "failed";
      deps.onEvent?.({ type: "node", node: key, status: "failed", ms: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : String(err) });
      throw new WorkflowError(key, err, { ...statuses });
    }
  }

  return { result, outputs, statuses };
}
