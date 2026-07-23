import type { PlanNode } from "@mill/core";
import type { Ctx } from "./ctx";

// SQL node execution (v1: postgres). Lives in the SDK so it's bundled into standalone exports
// exactly like jscode/loop/if — the exported program runs the same query the platform runs.
//
// Safety: query text is NEVER interpolated. `$1..$n` placeholders are bound server-side through
// the driver's parameter array, so a param that is itself an array becomes a Postgres array
// (e.g. `where id = any($1)`), and per-item batches bind a fresh value set per row.

export interface SqlResult { rows: unknown[]; rowCount: number; command?: string; fields?: { name: string }[] }

/** Pluggable DB driver — the default is pg (lazy-imported); tests inject a fake. */
export interface SqlDriver {
  query(url: string, text: string, values: unknown[], opts?: { timeoutMs?: number }): Promise<SqlResult>;
  /** Run `fn` inside one transaction on a single connection; COMMIT on success, ROLLBACK on throw. */
  transaction<T>(url: string, fn: (q: (text: string, values: unknown[]) => Promise<SqlResult>) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>;
  close?(): Promise<void>;
}

type Scope = { input: unknown; ctx: Ctx; item?: unknown; index?: number };
function evalExpr(expr: string, s: Scope): unknown {
  // Same evaluator family as loop `each` / `if` conditions, plus `item`/`index` for batches.
  return new Function("input", "ctx", "item", "index", `"use strict"; return (${expr});`)(s.input, s.ctx, s.item, s.index);
}
function bindParams(node: PlanNode, s: Scope): unknown[] {
  if (node.paramsFrom) {
    const v = evalExpr(node.paramsFrom, s);
    if (!Array.isArray(v)) throw new Error(`sql '${node.key}': paramsFrom must yield an array (got ${v === null ? "null" : typeof v})`);
    return v;
  }
  return (node.params ?? []).map((p) => evalExpr(p, s));
}

/**
 * Execute a `sql` plan node. `single` runs one query; `each` runs one per item of `each`
 * (with `item`/`index` in scope), optionally wrapped in a transaction. Returns rows out.
 * When the connection secret is unset, simulates an empty result (dev/test affordance) — the
 * same "no secret → simulate" pattern the example nodes use, so flows stay runnable offline.
 */
export async function runSqlNode(node: PlanNode, primary: unknown, ctx: Ctx, driver: SqlDriver): Promise<unknown> {
  const url = node.connection ? ctx.secrets?.[node.connection] : undefined;
  const query = node.query ?? "";
  const opts = { timeoutMs: node.timeoutMs };

  if (!url) {
    ctx.log.warn(`sql: connection secret '${node.connection}' is unset — simulating (no DB call)`);
    return node.mode === "each" ? { results: [], rowCount: 0, simulated: true } : { rows: [], rowCount: 0, simulated: true };
  }

  if (node.mode === "each") {
    const arr = evalExpr(node.each ?? "input", { input: primary, ctx });
    if (!Array.isArray(arr)) throw new Error(`sql '${node.key}' mode:each expected an array (each: ${node.each ?? "input"}), got ${arr === null ? "null" : typeof arr}`);
    ctx.log.info(`sql: ${arr.length} item(s)`, { count: arr.length, transaction: !!node.transaction });
    const one = async (q: (t: string, v: unknown[]) => Promise<SqlResult>, item: unknown, index: number) => {
      const r = await q(query, bindParams(node, { input: primary, ctx, item, index }));
      return { item, rows: r.rows, rowCount: r.rowCount };
    };
    let results: { item: unknown; rows: unknown[]; rowCount: number }[];
    if (node.transaction) {
      results = await driver.transaction(url, async (q) => {
        const out: { item: unknown; rows: unknown[]; rowCount: number }[] = [];
        for (let i = 0; i < arr.length; i++) out.push(await one(q, arr[i], i));
        return out;
      }, opts);
    } else {
      results = [];
      for (let i = 0; i < arr.length; i++) results.push(await one((t, v) => driver.query(url, t, v, opts), arr[i], i));
    }
    return { results, rowCount: results.reduce((n, r) => n + (r.rowCount || 0), 0) };
  }

  // single
  const r = await driver.query(url, query, bindParams(node, { input: primary, ctx }), opts);
  ctx.log.info("sql: ok", { rowCount: r.rowCount, command: r.command });
  return { rows: r.rows, rowCount: r.rowCount, command: r.command, fields: r.fields };
}

// ── default driver: node-postgres (pg), lazy-imported so the SDK has no hard pg dependency ──
// A pool per connection URL, reused across runs in the same process (worker stays warm). The
// export's run.sh installs pg (it's injected into the bundle's package.json for sql workloads).
let pools: Map<string, { connect(): Promise<PgClient>; end(): Promise<void> }> | null = null;
interface PgClient { query(q: { text: string; values: unknown[] } | string): Promise<{ rows: unknown[]; rowCount: number | null; command?: string; fields?: { name: string }[] }>; release(): void }

async function getPool(url: string): Promise<{ connect(): Promise<PgClient>; end(): Promise<void> }> {
  // @ts-ignore — pg ships no bundled d.ts in this resolution; we only use a narrow surface.
  const pg: any = await import("pg");
  const Pool = pg.default?.Pool ?? pg.Pool;
  const map = (pools ??= new Map());
  let p = map.get(url);
  if (!p) { p = new Pool({ connectionString: url, max: Number(process.env.MILL_PG_POOL_MAX ?? 4) }); map.set(url, p); }
  return p!;
}
const norm = (r: { rows: unknown[]; rowCount: number | null; command?: string; fields?: { name: string }[] }): SqlResult =>
  ({ rows: r.rows, rowCount: r.rowCount ?? r.rows.length, command: r.command, fields: (r.fields ?? []).map((f) => ({ name: f.name })) });

export const defaultPgDriver: SqlDriver = {
  async query(url, text, values, opts) {
    const client = await (await getPool(url)).connect();
    try {
      if (opts?.timeoutMs) await client.query(`SET statement_timeout = ${Number(opts.timeoutMs)}`); // Number() → no injection
      return norm(await client.query({ text, values }));
    } finally { client.release(); }
  },
  async transaction(url, fn, opts) {
    const client = await (await getPool(url)).connect();
    try {
      if (opts?.timeoutMs) await client.query(`SET statement_timeout = ${Number(opts.timeoutMs)}`);
      await client.query("BEGIN");
      const out = await fn((text, values) => client.query({ text, values }).then(norm));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally { client.release(); }
  },
  async close() { if (pools) { for (const p of pools.values()) await p.end().catch(() => {}); pools.clear(); } },
};
