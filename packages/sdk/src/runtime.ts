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
}

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

function evalCondition(expr: string, input: unknown, ctx: Ctx): boolean {
  // The `if` condition is a JS boolean expression over the upstream output (`input`) + ctx.
  const fn = new Function("input", "ctx", `"use strict"; return (${expr});`);
  return Boolean(fn(input, ctx));
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

  for (const key of plan.order) {
    const node = plan.nodes[key];
    if (!node) continue;
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

    const ctx = makeCtx({ node: key, inputs: inputsMap, allSecrets: deps.secrets ?? {}, declared: node.secrets, state, onEvent: deps.onEvent });
    deps.onEvent?.({ type: "node", node: key, status: "running" });
    const t0 = performance.now();

    try {
      let out: unknown;
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
      outputs[key] = out;
      statuses[key] = "succeeded";
      // Non-if nodes activate all successors unconditionally; `if` already gated above.
      if (node.kind !== "if") for (const c of node.children) activate(key, c.to);
      deps.onEvent?.({ type: "node", node: key, status: "succeeded", ms: Math.round(performance.now() - t0) });
    } catch (err) {
      statuses[key] = "failed";
      deps.onEvent?.({ type: "node", node: key, status: "failed", ms: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : String(err) });
      throw new WorkflowError(key, err, { ...statuses });
    }
  }

  return { result, outputs, statuses };
}
