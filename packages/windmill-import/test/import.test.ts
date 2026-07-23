import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { importWindmillFlow, type OpenFlow } from "../src/index";
import { parseWorkflow } from "@mill/core";
import { runWorkflow } from "@mill/executor";

function materialize(r: { workflowYaml: string; files: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), "wmimp-"));
  const wf = join(dir, "workflows", "demo");
  mkdirSync(join(wf, "nodes"), { recursive: true });
  writeFileSync(join(dir, "project.yaml"), "apiVersion: mill/v1\nkind: Project\nmetadata: { name: p }\n");
  writeFileSync(join(wf, "workflow.yaml"), r.workflowYaml);
  for (const [rel, content] of Object.entries(r.files)) {
    const abs = join(wf, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
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
