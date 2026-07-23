#!/usr/bin/env bun
// The Mill CLI: validate and run a project's workflows from disk.
//   mill validate <projectDir> [workflow]
//   mill run <projectDir> <workflow> [--input '<json>'] [--json]
import { runWorkflow, runNode, type ExecResult } from "@mill/executor";
import { loadProject, listWorkflows, loadWorkflow } from "@mill/projectfs";
import { buildPlan } from "@mill/compiler";
import type { RunEvent } from "@mill/sdk";

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[k] = next; i++; } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function printEvent(e: RunEvent) {
  if (e.type === "node") console.log(`[${e.node}] ${e.status}${e.ms != null ? ` (${e.ms}ms)` : ""}${e.error ? ` — ${e.error}` : ""}`);
  else console.log(`  [${e.node}] ${e.level}: ${e.message}${e.fields ? " " + JSON.stringify(e.fields) : ""}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);

  if (cmd === "validate") {
    const projectDir = pos[0];
    if (!projectDir) { console.error("usage: mill validate <projectDir> [workflow]"); process.exit(2); }
    loadProject(projectDir);
    const names = pos[1] ? [pos[1]] : listWorkflows(projectDir);
    let ok = true;
    for (const name of names) {
      try {
        const { def } = loadWorkflow(projectDir, name);
        buildPlan(def);
        console.log(`✓ ${name}  (${def.nodes.length} nodes)`);
      } catch (e) {
        ok = false;
        console.error(`✗ ${name}\n${e instanceof Error ? e.message : String(e)}`);
      }
    }
    process.exit(ok ? 0 : 1);
  }

  if (cmd === "run") {
    const [projectDir, workflow] = pos;
    if (!projectDir || !workflow) { console.error("usage: mill run <projectDir> <workflow> [--input '<json>'] [--json]"); process.exit(2); }
    const input = flags.input ? JSON.parse(String(flags.input)) : {};
    const secrets = process.env.MILL_SECRETS ? JSON.parse(process.env.MILL_SECRETS) : {};
    const request = process.env.MILL_REQUEST ? JSON.parse(process.env.MILL_REQUEST) : undefined; // webhook envelope (isolated path)
    const asJson = flags.json === true;
    const res: ExecResult = await runWorkflow({ projectDir, workflow, input, secrets, request }, asJson ? undefined : printEvent);
    if (asJson) {
      console.log(JSON.stringify(res));
    } else {
      console.log("");
      console.log(res.status === "succeeded" ? "✓ run complete" : `✗ run failed: ${res.error}`);
      console.log("result:", JSON.stringify(res.result ?? null));
    }
    process.exit(res.status === "succeeded" ? 0 : 1);
  }

  if (cmd === "run-node") {
    const [projectDir, workflow, node] = pos;
    if (!projectDir || !workflow || !node) { console.error("usage: mill run-node <projectDir> <workflow> <nodeKey> [--input '<json>'] [--json]"); process.exit(2); }
    const input = flags.input ? JSON.parse(String(flags.input)) : {};
    const secrets = process.env.MILL_SECRETS ? JSON.parse(process.env.MILL_SECRETS) : {};
    const asJson = flags.json === true;
    const r = await runNode(projectDir, workflow, node, input, secrets);
    if (asJson) {
      console.log(JSON.stringify(r));
    } else {
      for (const e of r.logs) printEvent(e);
      console.log("");
      console.log(r.status === "succeeded" ? `✓ step '${node}' (${r.kind}) ok` : `✗ step '${node}' failed: ${r.error}`);
      console.log("output:", JSON.stringify(r.output ?? null));
    }
    process.exit(r.status === "succeeded" ? 0 : 1);
  }

  if (cmd === "import") {
    const [source, flowPath, outDir] = pos;
    if (source !== "windmill" || !flowPath || !outDir) {
      console.error("usage: mill import windmill <flow.yaml | .flow dir | openflow.json> <out-project-dir> [--workflow <name>]");
      process.exit(2);
    }
    const { importToProject } = await import("@mill/windmill-import/src/cli");
    const { wfName, wfDir, report } = importToProject(flowPath, outDir, flags.workflow ? String(flags.workflow) : undefined);
    console.log(`✓ imported → ${wfDir}  (workflow: ${wfName})`);
    console.log(`  steps: ${report.supported}/${report.total} converted` + (report.deps.length ? ` · deps: ${report.deps.join(", ")} (pin versions!)` : ""));
    for (const w of report.warnings) console.log(`  ⚠ ${w}`);
    for (const s of report.skipped) console.log(`  ⤫ '${s.id}' (${s.type}) — ${s.reason}`);
    process.exit(0);
  }

  console.error("commands: validate | run | run-node | import windmill");
  process.exit(2);
}

main();
