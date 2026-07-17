import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { runNode } from "../src";

// Test-run a single step in isolation with a supplied input (no upstream nodes execute).
const PIPELINES = resolve(import.meta.dir, "../../../examples/pipelines");

describe("runNode — test a single step with a provided input", () => {
  test("jscode: runs just the node against the given input", async () => {
    const r = await runNode(PIPELINES, "types", "derive", {
      num: 42, str: "mill", bool: true, nil: null, arr: [1, 2, 3, 4], obj: { a: 1, b: 2 }, nested: { items: [{ x: 10 }, { x: 20 }] },
    });
    expect(r.status).toBe("succeeded");
    expect(r.output).toMatchObject({ num2: 84, upper: "MILL", arrSum: 10, deep: [10, 20] });
  });

  test("jscode: surfaces a thrown error instead of crashing", async () => {
    const r = await runNode(PIPELINES, "types", "derive", { partial: true }); // missing required keys
    expect(r.status).toBe("failed");
    expect(r.error).toContain("continuity broken");
  });

  test("loop: runs the body once per item of the supplied array", async () => {
    const r = await runNode(PIPELINES, "map-numbers", "each", { nums: [2, 3, 4] });
    expect(r.status).toBe("succeeded");
    expect(r.output).toEqual([
      { n: 2, sq: 4, at: 0 },
      { n: 3, sq: 9, at: 1 },
      { n: 4, sq: 16, at: 2 },
    ]);
  });

  test("if: reports which branch the input takes", async () => {
    const even = await runNode(PIPELINES, "branch", "gate", { n: 4 });
    expect(even.output).toEqual({ branch: "true", value: { n: 4 } });
    const odd = await runNode(PIPELINES, "branch", "gate", { n: 7 });
    expect(odd.output).toEqual({ branch: "false", value: { n: 7 } });
  });

  test("callScript: runs the target sub-workflow with the supplied input", async () => {
    const r = await runNode(PIPELINES, "usesub", "call", { value: 9 });
    expect(r.status).toBe("succeeded");
    expect(r.output).toEqual({ doubled: 18 });
  });

  test("captures the node's ctx.log output", async () => {
    const r = await runNode(PIPELINES, "types", "verify", { num2: 84, upper: "MILL", notBool: false, isNull: true, arrSum: 10, objKeys: ["a", "b"], deep: [10, 20] });
    expect(r.status).toBe("succeeded");
    expect(r.logs.some((e) => e.type === "log" && e.message.includes("threaded intact"))).toBe(true);
  });

  test("unknown node → failed (not a crash)", async () => {
    const r = await runNode(PIPELINES, "types", "nope", {});
    expect(r.status).toBe("failed");
    expect(r.error).toContain("no node 'nope'");
  });
});
