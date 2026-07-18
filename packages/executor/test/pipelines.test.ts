import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { runWorkflow } from "../src";

// Step input→output continuity across data types. Each workflow's nodes assert their
// own input shape (throwing on a break), so a "succeeded" status IS the continuity proof;
// we additionally pin the final result so a silent regression can't slip through.
const PIPELINES = resolve(import.meta.dir, "../../../examples/pipelines");
const run = (workflow: string, input: unknown = {}) => runWorkflow({ projectDir: PIPELINES, workflow, input });

describe("pipelines — step input/output continuity", () => {
  test("types: threads every JS data type through start → seed → derive → verify", async () => {
    const r = await run("types");
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ ok: true, checked: 7 });
    // every step ran (nothing skipped) — the chain stayed live end to end
    expect(Object.values(r.statuses ?? {})).toEqual(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
  });

  test("map-numbers: iterate numbers → square → reduce", async () => {
    const r = await run("map-numbers");
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ count: 5, total: 55 });
  });

  test("map-objects: iterate objects → line totals → grand total", async () => {
    const r = await run("map-objects");
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ lines: 3, grand: 43 });
  });

  test("map-strings: iterate strings → upper/len → join", async () => {
    const r = await run("map-strings");
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ joined: "ALPHA,BETA,GAMMA", totalLen: 14 });
  });

  test("map-mixed: iterate a heterogeneous array → classify by runtime type", async () => {
    const r = await run("map-mixed");
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ total: 6, byType: { number: 1, string: 1, boolean: 1, null: 1, array: 1, object: 1 } });
  });

  test("branch: data survives an if-branch + fan-in (even path)", async () => {
    const r = await run("branch", { n: 4 });
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ n: 4, parity: "even", seedKept: true });
    expect(r.statuses?.odd).toBe("skipped"); // false branch never ran
  });

  test("branch: odd path threads through the other branch", async () => {
    const r = await run("branch", { n: 7 });
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ n: 7, parity: "odd", seedKept: true });
    expect(r.statuses?.even).toBe("skipped");
  });

  test("usesub: callScript continuity — sub-workflow output flows back into the caller", async () => {
    const r = await run("usesub");
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ ok: true, doubled: 42 });
    // the sub-workflow's node actually executed (recursion happened)
    expect(r.events.some((e) => e.type === "node" && e.node === "dbl")).toBe(true);
  });

  test("double: the sub-workflow also runs standalone with a default input", async () => {
    const r = await run("double");
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ doubled: 2 });
  });

  test("retry: a transiently-failing node retries and succeeds (per-node retry policy)", async () => {
    const r = await run("retry");
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ ok: true, tries: 3 });
    expect(r.events.some((e) => e.type === "log" && /attempt 1\/3 failed/.test((e as { message?: string }).message ?? ""))).toBe(true);
  });

  test("validated: input/output schemas are enforced (passes when satisfied)", async () => {
    const r = await run("validated");
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ total: 3, sum: 60 });
  });
});
