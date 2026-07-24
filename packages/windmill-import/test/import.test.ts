import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { importWindmillFlow, parseWmSqlHeader, type OpenFlow } from "../src/index";
import { parseWorkflow } from "@mill/core";
import { runWorkflow } from "@mill/executor";

function materialize(r: { workflowYaml: string; files: Record<string, string>; name?: string; subWorkflows?: { name: string; workflowYaml: string; files: Record<string, string> }[] }) {
  const dir = mkdtempSync(join(tmpdir(), "wmimp-"));
  writeFileSync(join(dir, "project.yaml"), "apiVersion: mill/v1\nkind: Project\nmetadata: { name: p }\n");
  const writeWf = (name: string, yaml: string, files: Record<string, string>) => {
    const wf = join(dir, "workflows", name);
    mkdirSync(join(wf, "nodes"), { recursive: true });
    writeFileSync(join(wf, "workflow.yaml"), yaml);
    for (const [rel, content] of Object.entries(files)) { const abs = join(wf, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); }
  };
  writeWf(r.name ?? "demo", r.workflowYaml, r.files);
  for (const sub of r.subWorkflows ?? []) writeWf(sub.name, sub.workflowYaml, sub.files);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("windmill import", () => {
  test("JS flow round-trips + RUNS with Windmill's flow_input/results wiring", async () => {
    const flow: OpenFlow = { summary: "demo", value: { modules: [
      { id: "a", value: { type: "rawscript", language: "bun", content: "export async function main(n: number) { return n * 2; }", input_transforms: { n: { type: "javascript", expr: "flow_input.n" } } } },
      // b reads a PRIOR step's result AND the flow input — the cross-step reference Windmill allows.
      { id: "b", value: { type: "rawscript", language: "bun", content: "export async function main(x, k) { return x + k; }", input_transforms: { x: { type: "javascript", expr: "results.a" }, k: { type: "javascript", expr: "flow_input.k" } } } },
    ] } };
    const r = importWindmillFlow(flow, { name: "demo" });
    // the generated workflow must be structurally valid
    expect(parseWorkflow(require("yaml").parse(r.workflowYaml)).ok).toBe(true);

    const { dir, cleanup } = materialize(r);
    try {
      const res = await runWorkflow({ projectDir: dir, workflow: "demo", input: { n: 5, k: 100 }, secrets: {} }, () => {});
      // a = 5*2 = 10 ; b = results.a(10) + flow_input.k(100) = 110  → workflow returns b
      expect(res.status).toBe("succeeded");
      expect(res.result).toBe(110);
    } finally { cleanup(); }
  });

  test("postgresql step → a Mill sql node with params in $1..$n order", () => {
    const flow: OpenFlow = { value: { modules: [
      { id: "q", value: { type: "rawscript", language: "postgresql",
        content: "-- $1 orgId\n-- $2 active\nselect * from orgs where id = $1 and active = $2",
        input_transforms: { orgId: { type: "javascript", expr: "flow_input.id" }, active: { type: "static", value: true } } } },
    ] } };
    const r = importWindmillFlow(flow, { name: "rep" });
    const def = require("yaml").parse(r.workflowYaml);
    const q = def.nodes.find((n: any) => n.key === "q");
    expect(q.kind).toBe("sql");
    expect(q.connection).toBe("DATABASE_URL");
    expect(q.params).toEqual(["(ctx.state.flow_input.id)", "true"]); // sql exprs reach ctx.state
    expect(parseWorkflow(def).ok).toBe(true);
  });

  test("SQL magic comments (database / return_last_result / $1) parse from raw query text", () => {
    // The exact shape Windmill users copy-paste: pragma comments, a CTE chain, one final SELECT.
    const query = [
      "-- database f/database/postgresql",
      "-- return_last_result",
      "-- $1 invoices",
      "WITH inv_input AS (SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS x(invoice_id varchar(64)))",
      "SELECT COUNT(*) AS invoices_written FROM inv_input;",
    ].join("\n");
    const h = parseWmSqlHeader(query);
    expect(h.database).toBe("f/database/postgresql");
    expect(h.returnLastResult).toBe(true);
    expect(h.params).toEqual([{ index: 1, name: "invoices", default: undefined }]);

    // …and the same text imported as a step keeps the raw query and binds $1 to its arg.
    const flow: OpenFlow = { value: { modules: [
      { id: "writeInvoices", value: { type: "rawscript", language: "postgresql", content: query,
        input_transforms: { invoices: { type: "javascript", expr: "results.fetch" } } } },
    ] } };
    const r = importWindmillFlow(flow, { name: "inv" });
    const q = require("yaml").parse(r.workflowYaml).nodes.find((n: any) => n.key === "writeInvoices");
    expect(q.kind).toBe("sql");
    expect(q.query).toContain("jsonb_to_recordset");   // full query preserved, comments and all
    expect(q.params).toEqual(["(ctx.state.results.fetch)"]);
  });

  test("SQL header params sort by index and tolerate `= default`", () => {
    const h = parseWmSqlHeader("-- $2 limit = 100\n-- $1 orgId\nselect 1");
    expect(h.params).toEqual([{ index: 1, name: "orgId", default: undefined }, { index: 2, name: "limit", default: "100" }]);
  });

  test("non-JS languages are skipped + reported (loud TODO node, nothing silent)", () => {
    const flow: OpenFlow = { value: { modules: [
      { id: "py", value: { type: "rawscript", language: "python3", content: "def main(): return 1" } },
      { id: "loop", value: { type: "forloopflow", modules: [] } },
    ] } };
    const r = importWindmillFlow(flow, { name: "x" });
    expect(r.report.skipped.map((s) => s.id).sort()).toEqual(["loop", "py"]);
    expect(r.files["nodes/py.js"]).toContain("TODO");
    expect(parseWorkflow(require("yaml").parse(r.workflowYaml)).ok).toBe(true); // still a valid workflow
  });

  test("Windmill continue_on_error maps to the node's continueOnError", () => {
    const flow: OpenFlow = { value: { modules: [
      { id: "risky", continue_on_error: true, value: { type: "rawscript", language: "bun", content: "export async function main() { return 1; }" } },
    ] } };
    const def = require("yaml").parse(importWindmillFlow(flow, { name: "c" }).workflowYaml);
    expect(def.nodes.find((x: any) => x.key === "risky").continueOnError).toBe(true);
  });

  test("bare npm imports become node deps", () => {
    const flow: OpenFlow = { value: { modules: [
      { id: "s", value: { type: "rawscript", language: "bun", content: "import dayjs from 'dayjs';\nexport async function main() { return dayjs().year(); }" } },
    ] } };
    const r = importWindmillFlow(flow, { name: "d" });
    expect(r.report.deps).toContain("dayjs");
    const def = require("yaml").parse(r.workflowYaml);
    expect(def.nodes.find((n: any) => n.key === "s").deps).toEqual({ dayjs: "latest" });
  });
});

describe("windmill import — control flow (runs end to end)", () => {
  test("branchone runs the matching branch, else the default", async () => {
    const flow: OpenFlow = { value: { modules: [
      { id: "pick", value: { type: "rawscript", language: "bun", content: "export async function main(n: number) { return n; }", input_transforms: { n: { type: "javascript", expr: "flow_input.n" } } } },
      { id: "br", value: { type: "branchone",
        branches: [{ expr: "results.pick > 0", modules: [{ id: "pos", value: { type: "rawscript", language: "bun", content: "export async function main() { return 'positive'; }" } } ] }],
        default: [{ id: "neg", value: { type: "rawscript", language: "bun", content: "export async function main() { return 'negative'; }" } }] } },
    ] } };
    const r = importWindmillFlow(flow, { name: "demo" });
    expect(parseWorkflow(require("yaml").parse(r.workflowYaml)).ok).toBe(true);
    const { dir, cleanup } = materialize(r);
    try {
      expect((await runWorkflow({ projectDir: dir, workflow: "demo", input: { n: 5 }, secrets: {} }, () => {})).result).toBe("positive");
      expect((await runWorkflow({ projectDir: dir, workflow: "demo", input: { n: -1 }, secrets: {} }, () => {})).result).toBe("negative");
    } finally { cleanup(); }
  });

  test("forloopflow (single JS body) runs per item with iter.value", async () => {
    const flow: OpenFlow = { value: { modules: [
      { id: "lp", value: { type: "forloopflow", iterator: { type: "javascript", expr: "flow_input.nums" },
        modules: [{ id: "body", value: { type: "rawscript", language: "bun", content: "export async function main(x: number) { return x * 10; }", input_transforms: { x: { type: "javascript", expr: "iter.value" } } } }] } },
    ] } };
    const r = importWindmillFlow(flow, { name: "lp" });
    const { dir, cleanup } = materialize(r);
    try {
      const res = await runWorkflow({ projectDir: dir, workflow: "lp", input: { nums: [1, 2, 3] }, secrets: {} }, () => {});
      expect(res.result).toEqual([10, 20, 30]);
    } finally { cleanup(); }
  });

  test("script/flow ref → args-prep jscode + callScript to the target", () => {
    const flow: OpenFlow = { value: { modules: [
      { id: "a", value: { type: "script", path: "f/user_model/get_user_by_plato_id", input_transforms: { platoId: { type: "javascript", expr: "flow_input.platoId" } } } },
    ] } };
    const def = require("yaml").parse(importWindmillFlow(flow, { name: "s" }).workflowYaml);
    const call = def.nodes.find((n: any) => n.kind === "callScript");
    expect(call.call.ref).toBe("workflows/get_user_by_plato_id");
    expect(def.nodes.some((n: any) => n.kind === "jscode" && n.name.includes("args"))).toBe(true);
    expect(parseWorkflow(def).ok).toBe(true);
  });
});

describe("windmill import — multi-module loop body (sub-workflow + envelope)", () => {
  test("loop body of 2 steps reads a sibling body result AND the parent's results", async () => {
    const flow: OpenFlow = { value: { modules: [
      { id: "base", value: { type: "rawscript", language: "bun", content: "export async function main(b: number) { return b; }", input_transforms: { b: { type: "javascript", expr: "flow_input.base" } } } },
      { id: "lp", value: { type: "forloopflow", iterator: { type: "javascript", expr: "flow_input.items" }, modules: [
        { id: "m1", value: { type: "rawscript", language: "bun", content: "export async function main(x: number) { return x * 2; }", input_transforms: { x: { type: "javascript", expr: "iter.value" } } } },
        // m2 references a SIBLING body step (results.m1) AND a PARENT step (results.base)
        { id: "m2", value: { type: "rawscript", language: "bun", content: "export async function main(a: number, c: number) { return a + c; }", input_transforms: { a: { type: "javascript", expr: "results.m1" }, c: { type: "javascript", expr: "results.base" } } } },
      ] } },
    ] } };
    const r = importWindmillFlow(flow, { name: "demo" });
    expect(r.subWorkflows.length).toBe(1); // the loop body became a sub-workflow
    expect(parseWorkflow(require("yaml").parse(r.workflowYaml)).ok).toBe(true);
    expect(parseWorkflow(require("yaml").parse(r.subWorkflows[0].workflowYaml)).ok).toBe(true);
    const { dir, cleanup } = materialize(r);
    try {
      // base=100 ; items=[1,2,3] → m1=[2,4,6] → m2 = m1 + base = [102,104,106]
      const res = await runWorkflow({ projectDir: dir, workflow: "demo", input: { base: 100, items: [1, 2, 3] }, secrets: {} }, () => {});
      expect(res.status).toBe("succeeded");
      expect(res.result).toEqual([102, 104, 106]);
    } finally { cleanup(); }
  });
});

describe("windmill import — skip_if", () => {
  test("a step with skip_if runs only when the expr is false", async () => {
    const flow: OpenFlow = { value: { modules: [
      { id: "gate", value: { type: "rawscript", language: "bun", content: "export async function main(x: number) { return x; }", input_transforms: { x: { type: "javascript", expr: "flow_input.x" } } } },
      { id: "work", skip_if: { expr: "results.gate === 0" }, value: { type: "rawscript", language: "bun", content: "export async function main() { return 'ran'; }" } },
      { id: "fin", value: { type: "rawscript", language: "bun", content: "export async function main(r) { return r ?? 'skipped'; }", input_transforms: { r: { type: "javascript", expr: "results.work" } } } },
    ] } };
    const r = importWindmillFlow(flow, { name: "demo" });
    expect(parseWorkflow(require("yaml").parse(r.workflowYaml)).ok).toBe(true);
    const { dir, cleanup } = materialize(r);
    try {
      expect((await runWorkflow({ projectDir: dir, workflow: "demo", input: { x: 5 }, secrets: {} }, () => {})).result).toBe("ran");     // 5 !== 0 → runs
      expect((await runWorkflow({ projectDir: dir, workflow: "demo", input: { x: 0 }, secrets: {} }, () => {})).result).toBe("skipped"); // 0 === 0 → skipped
    } finally { cleanup(); }
  });
});
