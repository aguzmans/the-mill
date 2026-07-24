import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { parse as yamlParse } from "yaml";
import { importWindmillFlow, parseMainParams, type OpenFlow } from "./index";

// Windmill code-file extension → language (a script is `<name>.<ext>` + `<name>.script.yaml`).
function langForExt(file: string): string {
  if (/\.(bun\.ts|deno\.ts|ts|js|mjs)$/.test(file)) return "bun";
  if (/\.(pg\.sql|sql)$/.test(file)) return "postgresql";
  if (/\.py$/.test(file)) return "python3";
  if (/\.go$/.test(file)) return "go";
  if (/\.(sh|bash)$/.test(file)) return "bash";
  return "bun";
}

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

/** Does a workflow already exist in the target project? */
const wfExists = (projectDir: string, name: string) => existsSync(join(projectDir, "workflows", name, "workflow.yaml"));

/**
 * Import a Windmill flow into `<projectDir>/workflows/<name>/…`. A flow is BLOCKED (not written)
 * when it depends on other jobs (via callScript) that aren't imported yet — import those first,
 * or pass `force` to import anyway (its callScript steps fail until the targets exist).
 */
export function importToProject(flowPath: string, projectDir: string, name?: string, opts?: { force?: boolean }) {
  const { flow, dir, defaultName } = readFlow(flowPath);
  const wfName = (name || defaultName).replace(/[^A-Za-z0-9._-]/g, "-");
  const result = importWindmillFlow(flow, { name: wfName, resolveInline: (p) => readFileSync(join(dir, p), "utf8") });

  // Deps this import satisfies itself (its extracted loop-body sub-workflows) don't count.
  const selfProvided = new Set([wfName, ...result.subWorkflows.map((s) => s.name)]);
  const missing = result.dependencies.filter((d) => !selfProvided.has(d) && !wfExists(projectDir, d));
  if (missing.length && !opts?.force) {
    return { wfName, blocked: true as const, missing, dependencies: result.dependencies, report: result.report };
  }

  if (!existsSync(join(projectDir, "project.yaml"))) {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "project.yaml"), `apiVersion: mill/v1\nkind: Project\nmetadata:\n  name: ${basename(projectDir)}\n`);
  }
  const writeWf = (nm: string, yaml: string, files: Record<string, string>) => {
    const wfDir = join(projectDir, "workflows", nm);
    mkdirSync(join(wfDir, "nodes"), { recursive: true });
    writeFileSync(join(wfDir, "workflow.yaml"), yaml);
    for (const [rel, content] of Object.entries(files)) { const abs = join(wfDir, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); }
    return wfDir;
  };
  const wfDir = writeWf(wfName, result.workflowYaml, result.files);
  for (const sub of result.subWorkflows) writeWf(sub.name, sub.workflowYaml, sub.files); // extracted loop bodies
  return { wfName, wfDir, blocked: false as const, missing, dependencies: result.dependencies, report: result.report };
}

function ensureProject(projectDir: string) {
  if (!existsSync(join(projectDir, "project.yaml"))) {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "project.yaml"), `apiVersion: mill/v1\nkind: Project\nmetadata:\n  name: ${basename(projectDir)}\n`);
  }
}
function writeResult(projectDir: string, r: { name: string; workflowYaml: string; files: Record<string, string>; subWorkflows: { name: string; workflowYaml: string; files: Record<string, string> }[] }) {
  ensureProject(projectDir);
  const put = (nm: string, yaml: string, files: Record<string, string>) => {
    const wfDir = join(projectDir, "workflows", nm);
    mkdirSync(join(wfDir, "nodes"), { recursive: true });
    writeFileSync(join(wfDir, "workflow.yaml"), yaml);
    for (const [rel, content] of Object.entries(files)) { const abs = join(wfDir, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); }
  };
  put(r.name, r.workflowYaml, r.files);
  for (const s of r.subWorkflows) put(s.name, s.workflowYaml, s.files);
}

/** Build (in memory) a 1-node Mill workflow from a standalone Windmill script. */
function buildScript(codePath: string) {
  const code = readFileSync(codePath, "utf8");
  const lang = langForExt(codePath);
  const params = lang === "postgresql" ? [] : parseMainParams(code);
  const flow: OpenFlow = { value: { modules: [{ id: "run", value: { type: "rawscript", language: lang, content: code, input_transforms: Object.fromEntries(params.map((p) => [p, { type: "javascript", expr: `flow_input.${p}` }])) } }] } };
  const wfName = basename(codePath).replace(/\.[^.]*$/, "").replace(/\.(bun|deno|pg)$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
  return importWindmillFlow(flow, { name: wfName });
}

/** Import a standalone Windmill script as a Mill workflow (writes immediately). */
export function importScriptToProject(codePath: string, projectDir: string) {
  const result = buildScript(codePath);
  writeResult(projectDir, result);
  return { wfName: result.name, wfDir: join(projectDir, "workflows", result.name), report: result.report, kind: "script" as const };
}

/**
 * Import a whole `wmill sync` folder: every `.flow` dir + every standalone script, in DEPENDENCY
 * ORDER (a job is written only after the jobs it callScripts to), so refs resolve. Reports any
 * dependency that isn't in the folder and doesn't already exist (an unresolved external ref).
 */
export function importWorkspace(srcDir: string, projectDir: string) {
  ensureProject(projectDir);
  // 1. discover + build everything in memory
  const built: { kind: "flow" | "script"; result: ReturnType<typeof importWindmillFlow> }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.endsWith(".flow")) { const { flow, dir, defaultName } = readFlow(p); built.push({ kind: "flow", result: importWindmillFlow(flow, { name: defaultName.replace(/[^A-Za-z0-9._-]/g, "-"), resolveInline: (x) => readFileSync(join(dir, x), "utf8") }) }); }
        else walk(p);
      } else if (e.isFile() && /\.script\.(yaml|json)$/.test(e.name)) {
        const base = p.replace(/\.script\.(yaml|json)$/, "");
        const code = [".bun.ts", ".deno.ts", ".ts", ".js", ".pg.sql", ".sql", ".py", ".go", ".sh"].map((x) => base + x).find(existsSync);
        if (code) built.push({ kind: "script", result: buildScript(code) });
      }
    }
  };
  walk(srcDir);

  // 2. topological order — a job after everything it depends on (cycles fall back to input order)
  const inBatch = new Set(built.map((b) => b.result.name));
  const byName = new Map(built.map((b) => [b.result.name, b] as const));
  const ordered: typeof built = []; const done = new Set<string>(); const onStack = new Set<string>();
  const visit = (name: string) => {
    if (done.has(name) || onStack.has(name)) return;
    const b = byName.get(name); if (!b) return;
    onStack.add(name);
    for (const dep of b.result.dependencies) if (inBatch.has(dep)) visit(dep);
    onStack.delete(name); done.add(name); ordered.push(b);
  };
  for (const b of built) visit(b.result.name);

  // 3. write in order + report unresolved external refs
  const out: { wfName: string; kind: "flow" | "script"; report: ReturnType<typeof importWindmillFlow>["report"]; unresolved: string[] }[] = [];
  for (const b of ordered) {
    writeResult(projectDir, b.result);
    const unresolved = b.result.dependencies.filter((d) => !inBatch.has(d) && !wfExists(projectDir, d));
    out.push({ wfName: b.result.name, kind: b.kind, report: b.result.report, unresolved });
  }
  return out;
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
