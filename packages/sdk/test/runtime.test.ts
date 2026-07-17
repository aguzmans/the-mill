import { test, expect, describe } from "bun:test";
import type { ExecPlan, PlanNode, NodeKind } from "@mill/core";
import { executePlan, makeCtx, WorkflowError, type NodeFn } from "../src";

const n = (key: string, kind: NodeKind, extra: Partial<PlanNode> = {}): PlanNode => ({
  key, kind, name: key, parents: [], children: [], ...extra,
});

// start → a → if(input.n > 0) → true:b→end | false:end
function branchingPlan(): ExecPlan {
  return {
    workflow: "t", startKey: "start", order: ["start", "a", "g", "b", "end"],
    nodes: {
      start: n("start", "start", { children: [{ to: "a" }] }),
      a: n("a", "jscode", { file: "a.js", parents: ["start"], children: [{ to: "g" }] }),
      g: n("g", "if", { condition: "input.n > 0", parents: ["a"], children: [{ to: "b", branch: "true" }, { to: "end", branch: "false" }] }),
      b: n("b", "jscode", { file: "b.js", parents: ["g"], children: [{ to: "end" }] }),
      end: n("end", "end", { parents: ["g", "b"] }),
    },
  };
}

const fns: Record<string, NodeFn> = {
  a: (input: any) => ({ n: input.n }),
  b: (input: any) => ({ doubled: input.n * 2 }),
};
const loadNode = async (node: PlanNode) => fns[node.key];
const noCall = async () => { throw new Error("no callScript"); };

describe("executePlan — branching", () => {
  test("takes the true branch and skips the false-only node", async () => {
    const r = await executePlan(branchingPlan(), { input: { n: 5 }, loadNode, callScript: noCall });
    expect(r.result).toEqual({ doubled: 10 });
    expect(r.statuses.b).toBe("succeeded");
    expect(r.statuses.end).toBe("succeeded");
  });

  test("takes the false branch and skips b", async () => {
    const r = await executePlan(branchingPlan(), { input: { n: 0 }, loadNode, callScript: noCall });
    expect(r.statuses.b).toBe("skipped");
    expect(r.result).toEqual({ n: 0 }); // end receives the if's pass-through
  });
});

describe("executePlan — fan-in", () => {
  test("a multi-parent node reads every live parent via ctx.inputs", async () => {
    const plan: ExecPlan = {
      workflow: "fan", startKey: "start", order: ["start", "a", "b", "c", "end"],
      nodes: {
        start: n("start", "start", { children: [{ to: "a" }, { to: "b" }] }),
        a: n("a", "jscode", { file: "a.js", parents: ["start"], children: [{ to: "c" }] }),
        b: n("b", "jscode", { file: "b.js", parents: ["start"], children: [{ to: "c" }] }),
        c: n("c", "jscode", { file: "c.js", parents: ["a", "b"], children: [{ to: "end" }] }),
        end: n("end", "end", { parents: ["c"] }),
      },
    };
    const merge: Record<string, NodeFn> = {
      a: () => "A",
      b: () => "B",
      c: (_input, ctx) => ctx.inputs,
    };
    const r = await executePlan(plan, { input: null, loadNode: async (nd) => merge[nd.key], callScript: noCall });
    expect(r.result).toEqual({ a: "A", b: "B" });
  });
});

describe("executePlan — callScript & failures", () => {
  test("invokes callScript and returns its output", async () => {
    const plan: ExecPlan = {
      workflow: "call", startKey: "start", order: ["start", "x", "end"],
      nodes: {
        start: n("start", "start", { children: [{ to: "x" }] }),
        x: n("x", "callScript", { call: { workflow: "sub", ref: "workflows/sub" }, parents: ["start"], children: [{ to: "end" }] }),
        end: n("end", "end", { parents: ["x"] }),
      },
    };
    const r = await executePlan(plan, {
      input: { v: 1 },
      loadNode: async () => { throw new Error("n/a"); },
      callScript: async (_call, input: any) => ({ echoed: input.v }),
    });
    expect(r.result).toEqual({ echoed: 1 });
  });

  test("a throwing node aborts the run with a WorkflowError naming the node", async () => {
    const boom: Record<string, NodeFn> = { a: () => { throw new Error("kaboom"); }, b: () => 0 };
    await expect(
      executePlan(branchingPlan(), { input: { n: 1 }, loadNode: async (nd) => boom[nd.key], callScript: noCall }),
    ).rejects.toMatchObject({ name: "WorkflowError", node: "a" });
  });
});

describe("executePlan — loop (forEach)", () => {
  // start → src(jscode → array) → loop(body per item) → end
  const loopPlan = (loopExtra: Partial<PlanNode>): ExecPlan => ({
    workflow: "loop", startKey: "start", order: ["start", "src", "lp", "end"],
    nodes: {
      start: n("start", "start", { children: [{ to: "src" }] }),
      src: n("src", "jscode", { file: "src.js", parents: ["start"], children: [{ to: "lp" }] }),
      lp: n("lp", "loop", { parents: ["src"], children: [{ to: "end" }], ...loopExtra }),
      end: n("end", "end", { parents: ["lp"] }),
    },
  });

  test("jscode body: runs once per item and collects results, in order", async () => {
    const fns2: Record<string, NodeFn> = {
      src: () => ({ items: [1, 2, 3] }),
      body: (item: any, ctx) => ({ item, index: ctx.state.index, doubled: item * 2 }),
    };
    const r = await executePlan(loopPlan({ each: "input.items", file: "body.js" }), {
      input: null, loadNode: async (nd) => fns2[nd.key === "lp" ? "body" : nd.key], callScript: noCall,
    });
    expect(r.result).toEqual([
      { item: 1, index: 0, doubled: 2 },
      { item: 2, index: 1, doubled: 4 },
      { item: 3, index: 2, doubled: 6 },
    ]);
    expect(r.statuses.lp).toBe("succeeded");
  });

  test("callScript body: invokes the target once per item", async () => {
    const calls: unknown[] = [];
    const r = await executePlan(loopPlan({ each: "input", call: { workflow: "sub", ref: "workflows/sub" } }), {
      input: null,
      loadNode: async (nd) => (nd.key === "src" ? (() => ["a", "b"]) as NodeFn : (() => { throw new Error("n/a"); }) as NodeFn),
      callScript: async (_c, item) => { calls.push(item); return `handled:${item}`; },
    });
    expect(r.result).toEqual(["handled:a", "handled:b"]);
    expect(calls).toEqual(["a", "b"]);
  });

  test("defaults to iterating the upstream output when `each` is omitted", async () => {
    const r = await executePlan(loopPlan({ file: "body.js" }), {
      input: null,
      loadNode: async (nd) => (nd.key === "src" ? (() => [10, 20]) as NodeFn : ((x: any) => x + 1) as NodeFn),
      callScript: noCall,
    });
    expect(r.result).toEqual([11, 21]);
  });

  test("fails with a WorkflowError when the each-expression is not an array", async () => {
    await expect(
      executePlan(loopPlan({ each: "input.nope", file: "body.js" }), {
        input: null,
        loadNode: async (nd) => (nd.key === "src" ? (() => ({ nope: 5 })) as NodeFn : ((x: any) => x) as NodeFn),
        callScript: noCall,
      }),
    ).rejects.toMatchObject({ name: "WorkflowError", node: "lp" });
  });
});

describe("makeCtx", () => {
  test("exposes only the node's declared secret refs", () => {
    const events: any[] = [];
    const ctx = makeCtx({ node: "x", inputs: {}, allSecrets: { A: "1", B: "2", C: "3" }, declared: ["A", "C"], state: {}, onEvent: (e) => events.push(e) });
    expect(ctx.secrets).toEqual({ A: "1", C: "3" });
    ctx.log.info("hello", { k: 1 });
    expect(events[0]).toMatchObject({ type: "log", node: "x", level: "info", message: "hello" });
  });
});
