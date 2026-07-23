import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { parse as yamlParse } from "yaml";
import { importWindmillFlow, type OpenFlow } from "./index";

// `!inline path` in a Windmill flow.yaml → a marker the importer resolves against the flow dir.
const INLINE_TAG = { tag: "!inline", resolve: (s: string) => ({ __inline: s }) } as const;

/** Read a Windmill flow from a `.flow` dir, a flow.yaml, or an OpenFlow .json/.yaml file. */
export function readFlow(path: string): { flow: OpenFlow; dir: string; defaultName: string } {
  let filePath = path;
  let dir = dirname(path);
  if (existsSync(path) && statSync(path).isDirectory()) { filePath = join(path, "flow.yaml"); dir = path; }
  const text = readFileSync(filePath, "utf8");
  const flow = (filePath.endsWith(".json") ? JSON.parse(text) : yamlParse(text, { customTags: [INLINE_TAG as any] })) as OpenFlow;
  // name from the .flow dir (…/myflow.flow → myflow) or the file stem
  const base = basename(dir.endsWith(".flow") ? dir.slice(0, -5) : filePath.replace(/\.(flow\.)?ya?ml$|\.json$/, ""));
  return { flow, dir, defaultName: base || "imported" };
}

/** Import a Windmill flow into `<projectDir>/workflows/<name>/…`, creating project.yaml if needed. */
export function importToProject(flowPath: string, projectDir: string, name?: string) {
  const { flow, dir, defaultName } = readFlow(flowPath);
  const wfName = (name || defaultName).replace(/[^A-Za-z0-9._-]/g, "-");
  const result = importWindmillFlow(flow, {
    name: wfName,
    resolveInline: (p) => readFileSync(join(dir, p), "utf8"),
  });

  if (!existsSync(join(projectDir, "project.yaml"))) {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "project.yaml"), `apiVersion: mill/v1\nkind: Project\nmetadata:\n  name: ${basename(projectDir)}\n`);
  }
  const wfDir = join(projectDir, "workflows", wfName);
  mkdirSync(join(wfDir, "nodes"), { recursive: true });
  writeFileSync(join(wfDir, "workflow.yaml"), result.workflowYaml);
  for (const [rel, content] of Object.entries(result.files)) {
    const abs = join(wfDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return { wfName, wfDir, report: result.report };
}

// CLI: bun cli.ts <windmill-flow-path> <out-project-dir> [--workflow <name>]
if (import.meta.main) {
  const args = process.argv.slice(2);
  const nameFlag = args.indexOf("--workflow");
  const name = nameFlag >= 0 ? args[nameFlag + 1] : undefined;
  const pos = args.filter((a, i) => !a.startsWith("--") && a !== args[nameFlag + 1]);
  const [flowPath, outDir] = pos;
  if (!flowPath || !outDir) {
    console.error("usage: windmill-import <flow.yaml | .flow dir | openflow.json> <out-project-dir> [--workflow <name>]");
    process.exit(2);
  }
  const { wfName, wfDir, report } = importToProject(flowPath, outDir, name);
  console.log(`\n✓ imported → ${wfDir}  (workflow: ${wfName})`);
  console.log(`  steps: ${report.supported}/${report.total} converted` + (report.deps.length ? ` · deps: ${report.deps.join(", ")} (versions unpinned)` : ""));
  for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  for (const s of report.skipped) console.log(`  ⤫ skipped '${s.id}' (${s.type}) — ${s.reason}`);
  if (report.skipped.length) console.log(`\n  ${report.skipped.length} step(s) need manual porting (emitted as loud TODO nodes).`);
}
