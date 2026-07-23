import { test, expect, describe } from "bun:test";
import { parseWorkflow } from "../src/index";
import { buildPlan } from "@mill/compiler";

const wf = (sqlNode: Record<string, unknown>) => ({
  apiVersion: "mill/v1",
  kind: "Workflow",
  metadata: { name: "w" },
  nodes: [
    { key: "start", kind: "start" },
    { key: "q", kind: "sql", name: "query", ...sqlNode },
    { key: "end", kind: "end" },
  ],
  edges: [{ from: "start", to: "q" }, { from: "q", to: "end" }],
});

describe("sql node schema + compile", () => {
  test("accepts a valid single-query node", () => {
    const r = parseWorkflow(wf({ connection: "DATABASE_URL", query: "select * from t where id=$1", params: ["input.id"] }));
    expect(r.ok).toBe(true);
  });

  test("requires connection and query", () => {
    expect(parseWorkflow(wf({ query: "select 1" })).ok).toBe(false);       // no connection
    expect(parseWorkflow(wf({ connection: "DATABASE_URL" })).ok).toBe(false); // no query
  });

  test("mode:each requires an `each` expression", () => {
    expect(parseWorkflow(wf({ connection: "DATABASE_URL", query: "insert ...", mode: "each" })).ok).toBe(false);
    expect(parseWorkflow(wf({ connection: "DATABASE_URL", query: "insert ...", mode: "each", each: "input.rows" })).ok).toBe(true);
  });

  test("compiler auto-declares the connection secret + defaults dialect/mode", () => {
    const r = parseWorkflow(wf({ connection: "DATABASE_URL", query: "select 1" }));
    expect(r.ok).toBe(true);
    const plan = buildPlan(r.value!);
    const q = plan.nodes.q;
    expect(q.secrets).toContain("DATABASE_URL"); // exposed into ctx.secrets without listing it twice
    expect(q.dialect).toBe("postgres");
    expect(q.mode).toBe("single");
  });
});
