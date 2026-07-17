import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { runWorkflow, runNode } from "../src";

// A workflow whose loop body imports EXTERNAL npm libraries (ms + nanoid). Proves node code
// can pull in third-party packages and run — in-process here; isolated/exported are covered
// by the api export test + live checks. Requires the deps to be installed (bun install at repo
// root hoists them, since examples/* is a workspace).
const DEPS_DEMO = resolve(import.meta.dir, "../../../examples/deps-demo");

describe("external library dependencies", () => {
  test("a node using `ms` + `nanoid` runs and produces enriched output", async () => {
    const r = await runWorkflow({ projectDir: DEPS_DEMO, workflow: "enrich", input: {} });
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ count: 3, totalTtlMs: 9_090_000, idLen: 10 }); // 2h + 30m + 90s, nanoid(10)
  });

  test("run-node tests the dependency-using loop body in isolation", async () => {
    const r = await runNode(DEPS_DEMO, "enrich", "each", { events: [{ name: "x", ttl: "1h" }] });
    expect(r.status).toBe("succeeded");
    const rows = r.output as { id: string; name: string; ttlMs: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("x");
    expect(rows[0].ttlMs).toBe(3_600_000); // ms("1h")
    expect(rows[0].id).toHaveLength(10); // nanoid(10)
  });
});
