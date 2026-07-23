import { test, expect, describe } from "bun:test";
import { runSqlNode, type SqlDriver } from "../src/sql";
import type { PlanNode } from "@mill/core";

const ctx = (secrets: Record<string, string> = { DATABASE_URL: "postgres://x" }) =>
  ({ log: { info() {}, warn() {}, error() {}, debug() {} }, secrets, inputs: {}, state: {} }) as any;

// Fake driver that records every query + transaction boundary. A value of "BOOM" throws
// (to exercise rollback).
function fake() {
  const calls: { text: string; values: unknown[]; tx: boolean }[] = [];
  const tx: string[] = [];
  const driver: SqlDriver = {
    async query(_url, text, values) {
      calls.push({ text, values, tx: false });
      return { rows: [{ echo: values[0] }], rowCount: 1, command: "SELECT" };
    },
    async transaction(_url, fn) {
      tx.push("BEGIN");
      try {
        const out = await fn(async (text, values) => {
          calls.push({ text, values, tx: true });
          if (values.includes("BOOM")) throw new Error("boom");
          return { rows: [], rowCount: 1, command: "INSERT" };
        });
        tx.push("COMMIT");
        return out;
      } catch (e) { tx.push("ROLLBACK"); throw e; }
    },
  };
  return { driver, calls, tx };
}

const node = (over: Partial<PlanNode>): PlanNode =>
  ({ key: "q", kind: "sql", name: "q", connection: "DATABASE_URL", mode: "single", parents: [], children: [], ...over }) as PlanNode;

describe("runSqlNode", () => {
  test("single: binds each param expression as $1..$n", async () => {
    const f = fake();
    const out: any = await runSqlNode(node({ query: "select $1, $2", params: ["input.id", "true"] }), { id: 5 }, ctx(), f.driver);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].values).toEqual([5, true]);
    expect(out.rowCount).toBe(1);
    expect(out.command).toBe("SELECT");
  });

  test("paramsFrom: the whole item/array is passed straight through as $1..$n", async () => {
    const f = fake();
    await runSqlNode(node({ query: "insert into t values ($1,$2)", paramsFrom: "input.row" }), { row: [1, "a"] }, ctx(), f.driver);
    expect(f.calls[0].values).toEqual([1, "a"]);
  });

  test("single with an array-valued param (postgres array binding)", async () => {
    const f = fake();
    await runSqlNode(node({ query: "select * from u where id = any($1)", params: ["input.ids"] }), { ids: [1, 2, 3] }, ctx(), f.driver);
    expect(f.calls[0].values).toEqual([[1, 2, 3]]); // one param that IS an array
  });

  test("mode:each runs one query per item, item/index in scope", async () => {
    const f = fake();
    const out: any = await runSqlNode(
      node({ mode: "each", each: "input.rows", query: "insert into t (id,name) values ($1,$2)", params: ["item.id", "item.name"] }),
      { rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }] }, ctx(), f.driver,
    );
    expect(f.calls.map((c) => c.values)).toEqual([[1, "a"], [2, "b"]]);
    expect(out.results).toHaveLength(2);
    expect(out.rowCount).toBe(2);
    expect(f.tx).toEqual([]); // no transaction unless asked
  });

  test("mode:each + transaction wraps the batch (BEGIN…COMMIT)", async () => {
    const f = fake();
    await runSqlNode(
      node({ mode: "each", each: "input.rows", transaction: true, query: "insert into t values ($1)", params: ["item"] }),
      { rows: ["a", "b", "c"] }, ctx(), f.driver,
    );
    expect(f.tx).toEqual(["BEGIN", "COMMIT"]);
    expect(f.calls.every((c) => c.tx)).toBe(true);
  });

  test("mode:each + transaction rolls back on any failure", async () => {
    const f = fake();
    const p = runSqlNode(
      node({ mode: "each", each: "input.rows", transaction: true, query: "insert into t values ($1)", params: ["item"] }),
      { rows: ["a", "BOOM", "c"] }, ctx(), f.driver,
    );
    await expect(p).rejects.toThrow(/boom/);
    expect(f.tx).toEqual(["BEGIN", "ROLLBACK"]);
  });

  test("simulates (no DB call) when the connection secret is unset", async () => {
    const f = fake();
    const out: any = await runSqlNode(node({ query: "select 1", params: [] }), {}, ctx({}), f.driver);
    expect(f.calls).toHaveLength(0);
    expect(out.simulated).toBe(true);
    expect(out.rows).toEqual([]);
  });

  test("paramsFrom that doesn't yield an array is a clear error", async () => {
    const f = fake();
    await expect(runSqlNode(node({ query: "select $1", paramsFrom: "input.notArray" }), { notArray: 7 }, ctx(), f.driver))
      .rejects.toThrow(/must yield an array/);
  });
});
