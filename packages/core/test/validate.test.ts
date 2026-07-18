import { test, expect, describe } from "bun:test";
import { parseWorkflow, compileCondition, topoSort, hasCycle } from "../src";

// A minimal but complete valid workflow: start → a → if → (true:b→end | false:end)
function validWorkflow(): any {
  return {
    apiVersion: "mill/v1",
    kind: "Workflow",
    metadata: { name: "w" },
    nodes: [
      { key: "start", kind: "start", name: "Start" },
      { key: "a", kind: "jscode", name: "A", file: "nodes/a.js" },
      { key: "g", kind: "if", name: "G", condition: "input.length > 0" },
      { key: "b", kind: "jscode", name: "B", file: "nodes/b.js" },
      { key: "end", kind: "end", name: "End" },
    ],
    edges: [
      { from: "start", to: "a" },
      { from: "a", to: "g" },
      { from: "g", to: "b", branch: "true" },
      { from: "g", to: "end", branch: "false" },
      { from: "b", to: "end" },
    ],
  };
}

const codesOf = (raw: any) => parseWorkflow(raw).issues.map((i) => i.code);

describe("parseWorkflow — happy path", () => {
  test("accepts a valid workflow", () => {
    const r = parseWorkflow(validWorkflow());
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.value?.metadata.name).toBe("w");
  });
});

describe("parseWorkflow — schema errors", () => {
  test("rejects a bad apiVersion", () => {
    const w = validWorkflow();
    w.apiVersion = "nope";
    expect(codesOf(w)).toContain("schema");
  });
  test("rejects an empty node list", () => {
    const w = validWorkflow();
    w.nodes = [];
    expect(parseWorkflow(w).ok).toBe(false);
  });
});

describe("parseWorkflow — graph rules", () => {
  test("requires exactly one start", () => {
    const w = validWorkflow();
    w.nodes.push({ key: "start2", kind: "start", name: "S2" });
    expect(codesOf(w)).toContain("start");
  });
  test("requires at least one end", () => {
    const w = validWorkflow();
    w.nodes = w.nodes.filter((n: any) => n.kind !== "end");
    w.edges = w.edges.filter((e: any) => e.to !== "end");
    expect(codesOf(w)).toContain("end");
  });
  test("rejects an edge to an unknown node", () => {
    const w = validWorkflow();
    w.edges.push({ from: "a", to: "ghost" });
    expect(codesOf(w)).toContain("edge");
  });
  test("jscode node must declare a file", () => {
    const w = validWorkflow();
    delete w.nodes.find((n: any) => n.key === "a").file;
    expect(codesOf(w)).toContain("jscode-file");
  });
  test("callScript node must declare a ref", () => {
    const w = validWorkflow();
    w.nodes.find((n: any) => n.key === "b").kind = "callScript";
    delete w.nodes.find((n: any) => n.key === "b").file;
    expect(codesOf(w)).toContain("call-ref");
  });
  test("if node needs both true and false branches", () => {
    const w = validWorkflow();
    w.edges = w.edges.filter((e: any) => !(e.from === "g" && e.branch === "false"));
    w.edges.push({ from: "g", to: "end" }); // unlabelled instead of false
    const codes = codesOf(w);
    expect(codes).toContain("if-branches");
  });
  test("non-if nodes cannot have branch-labelled edges", () => {
    const w = validWorkflow();
    w.edges.find((e: any) => e.from === "a").branch = "true";
    expect(codesOf(w)).toContain("branch-on-non-if");
  });
  test("start may not have incoming edges", () => {
    const w = validWorkflow();
    w.edges.push({ from: "b", to: "start" });
    expect(codesOf(w)).toContain("cycle"); // creates a cycle too
    expect(codesOf(w)).toContain("start-incoming");
  });
  test("detects cycles (no loops in v1)", () => {
    const w = validWorkflow();
    w.edges.push({ from: "b", to: "a" });
    expect(codesOf(w)).toContain("cycle");
  });
  test("flags unreachable nodes", () => {
    const w = validWorkflow();
    w.nodes.push({ key: "orphan", kind: "jscode", name: "O", file: "nodes/o.js" });
    expect(codesOf(w)).toContain("unreachable");
  });
});

describe("compileCondition", () => {
  test("joins multi-clause conditions with && / ||", () => {
    expect(
      compileCondition({ conditions: [{ expr: "a" }, { connector: "or", expr: "b" }, { connector: "and", expr: "c" }] }),
    ).toBe("a || b && c");
  });
  test("falls back to the single condition string", () => {
    expect(compileCondition({ condition: "x > 1" })).toBe("x > 1");
  });
});

// start → src → loop → end
function loopWorkflow(loopNode: any): any {
  return {
    apiVersion: "mill/v1",
    kind: "Workflow",
    metadata: { name: "lp" },
    nodes: [
      { key: "start", kind: "start", name: "Start" },
      { key: "src", kind: "jscode", name: "Src", file: "nodes/src.js" },
      { key: "lp", kind: "loop", name: "Loop", ...loopNode },
      { key: "end", kind: "end", name: "End" },
    ],
    edges: [
      { from: "start", to: "src" },
      { from: "src", to: "lp" },
      { from: "lp", to: "end" },
    ],
  };
}

describe("parseWorkflow — loop node", () => {
  test("accepts a loop with a jscode body + each expression", () => {
    const r = parseWorkflow(loopWorkflow({ each: "input.items", file: "nodes/handle.js" }));
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  test("accepts a loop with a callScript body", () => {
    const r = parseWorkflow(loopWorkflow({ each: "input", call: { workflow: "sub", ref: "workflows/sub" } }));
    expect(r.ok).toBe(true);
  });

  test("rejects a loop with no body", () => {
    expect(codesOf(loopWorkflow({ each: "input.items" }))).toContain("loop-body");
  });

  test("rejects a loop with two bodies (file AND call)", () => {
    expect(codesOf(loopWorkflow({ file: "nodes/handle.js", call: { workflow: "sub", ref: "workflows/sub" } }))).toContain("loop-body");
  });
});

describe("topoSort", () => {
  test("orders start first and end last", () => {
    const wf = parseWorkflow(validWorkflow()).value!;
    const order = topoSort(wf);
    expect(order[0]).toBe("start");
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("g"));
    expect(order.indexOf("g")).toBeLessThan(order.indexOf("b"));
    expect(order.at(-1)).toBe("end");
    expect(hasCycle(wf)).toBe(false);
  });
});

describe("workflow-level exclusive flag", () => {
  test("defaults to undefined when omitted", () => {
    const r = parseWorkflow(validWorkflow());
    expect(r.ok).toBe(true);
    expect(r.value?.exclusive).toBeUndefined();
  });
  test("accepts exclusive: true and carries it onto the parsed value", () => {
    const r = parseWorkflow({ ...validWorkflow(), exclusive: true });
    expect(r.ok).toBe(true);
    expect(r.value?.exclusive).toBe(true);
  });
  test("rejects a non-boolean exclusive", () => {
    const r = parseWorkflow({ ...validWorkflow(), exclusive: "yes" });
    expect(r.ok).toBe(false);
  });
});
