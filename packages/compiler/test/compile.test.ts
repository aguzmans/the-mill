import { test, expect, describe } from "bun:test";
import { parseWorkflow } from "@mill/core";
import { buildPlan } from "../src";

function invoicesLike(): any {
  return {
    apiVersion: "mill/v1",
    kind: "Workflow",
    metadata: { name: "invoices" },
    nodes: [
      { key: "start", kind: "start", name: "Start" },
      { key: "fetch", kind: "jscode", name: "Fetch", file: "nodes/fetch.js" },
      { key: "gate", kind: "if", name: "Any open?", conditions: [{ expr: "input.length > 0" }, { connector: "or", expr: "false" }] },
      { key: "load", kind: "jscode", name: "Load", file: "nodes/load.js", secrets: ["WAREHOUSE_DSN"] },
      { key: "notify", kind: "callScript", name: "Notify", call: { workflow: "notify", ref: "workflows/notify" } },
      { key: "end", kind: "end", name: "End" },
    ],
    edges: [
      { from: "start", to: "fetch" },
      { from: "fetch", to: "gate" },
      { from: "gate", to: "load", branch: "true" },
      { from: "gate", to: "end", branch: "false" },
      { from: "load", to: "notify" },
      { from: "notify", to: "end" },
    ],
  };
}

describe("buildPlan", () => {
  const wf = parseWorkflow(invoicesLike()).value!;
  const plan = buildPlan(wf);

  test("produces a topologically ordered plan", () => {
    expect(plan.startKey).toBe("start");
    expect(plan.order[0]).toBe("start");
    expect(plan.order.indexOf("fetch")).toBeLessThan(plan.order.indexOf("gate"));
    expect(plan.order.indexOf("load")).toBeLessThan(plan.order.indexOf("notify"));
    expect(plan.order.at(-1)).toBe("end");
  });

  test("compiles the if node's multi-conditional expression", () => {
    expect(plan.nodes.gate.condition).toBe("input.length > 0 || false");
  });

  test("wires parents, children and branch labels", () => {
    expect(plan.nodes.gate.children).toEqual([{ to: "load", branch: "true" }, { to: "end", branch: "false" }]);
    expect(plan.nodes.end.parents.sort()).toEqual(["gate", "notify"]);
    expect(plan.nodes.load.secrets).toEqual(["WAREHOUSE_DSN"]);
    expect(plan.nodes.notify.call?.ref).toBe("workflows/notify");
  });

  test("throws on a workflow with no start", () => {
    const bad: any = invoicesLike();
    bad.nodes = bad.nodes.filter((n: any) => n.kind !== "start");
    bad.edges = bad.edges.filter((e: any) => e.from !== "start");
    expect(() => buildPlan(bad)).toThrow(/no start/);
  });
});
