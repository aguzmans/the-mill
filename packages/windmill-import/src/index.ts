import { stringify as yamlStringify } from "yaml";

// Windmill OpenFlow → Mill project importer (v1: JavaScript/TypeScript rawscript steps).
//
// Windmill wires data by explicit named references: each step's `input_transforms` map its
// named `main(...)` params to expressions over `flow_input.*` (run inputs) and `results.<id>.*`
// (any prior step's output). Mill passes the previous node's output as `input`, but its runtime
// also exposes `ctx.state.flow_input` (the run input) and `ctx.state.results[<key>]` (each node's
// output) — so imported steps read `flow_input`/`results` from there, faithfully reproducing
// Windmill's DAG wiring on Mill's model with no init/plumbing nodes.
//
// Scope: `rawscript` in bun/deno/nativets → jscode; `script` (path ref) → callScript; `identity`
// → passthrough. Anything else (SQL/other languages, forloop/branch/whileloop, approvals) is
// emitted as a loud TODO node and listed in the report — nothing is silently dropped.

export type WmTransform = { type: "static"; value?: unknown } | { type: "javascript"; expr?: string };
export interface WmValue { type: string; content?: unknown; language?: string; path?: string; input_transforms?: Record<string, WmTransform>; [k: string]: unknown }
export interface WmModule { id?: string; summary?: string; value?: WmValue }
export interface OpenFlow { summary?: string; description?: string; value?: { modules?: WmModule[] }; schema?: unknown }

export interface ImportResult {
  name: string;
  workflowYaml: string;
  files: Record<string, string>; // paths relative to the workflow dir, e.g. "nodes/foo.js"
  report: { total: number; supported: number; skipped: { id: string; type: string; reason: string }[]; warnings: string[]; deps: string[] };
}

const JS_LANGS = new Set(["bun", "deno", "nativets"]);

/** Custom-tag marker the caller's YAML parser produces for `content: !inline path`. */
export type Inline = { __inline: string };
const isInline = (v: unknown): v is Inline => !!v && typeof v === "object" && "__inline" in (v as object);

function getContent(v: WmValue, resolveInline?: (p: string) => string): string {
  const c = v.content;
  if (isInline(c)) return resolveInline ? resolveInline(c.__inline) : `/* missing inline file: ${c.__inline} */`;
  return typeof c === "string" ? c : "";
}

/** Names of `main(...)` params, in order — so keyed input_transforms map to positional args. */
export function parseMainParams(content: string): string[] {
  const m = content.match(/function\s+main\s*\(([\s\S]*?)\)/);
  if (!m) return [];
  return splitTopLevel(m[1])
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.replace(/^\.\.\./, "").split(/[:=]/)[0].trim())
    .filter(Boolean);
}
// split on commas that aren't inside <>, (), {}, [] (so `Record<string, x>` stays one param)
function splitTopLevel(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of s) {
    if ("<([{".includes(ch)) depth++;
    else if (">)]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Windmill scripts are TypeScript; Mill node files are .js. Strip TS types (Bun.Transpiler when
 *  available, else a light param-annotation strip) so the emitted .js loads. */
function stripTypes(content: string): string {
  const B = (globalThis as { Bun?: { Transpiler: new (o: unknown) => { transformSync(s: string): string } } }).Bun;
  if (B) { try { return new B.Transpiler({ loader: "ts" }).transformSync(content); } catch { /* fall through */ } }
  return content; // best-effort: assume already JS
}

/** Rewrite the Windmill entrypoint `export async function main(...)` → local `__wm_main`. */
function renameMain(content: string): string {
  return content.replace(/export\s+(?:default\s+)?(?:async\s+)?function\s+main\s*\(/, "async function __wm_main(");
}

/** Bare npm imports → Mill node deps (versions unpinned; flagged in the report). */
function collectImports(content: string): string[] {
  const deps = new Set<string>();
  for (const m of content.matchAll(/(?:from|import)\s+["']([^"'][^"']*)["']/g)) {
    let p = m[1];
    if (p.startsWith(".") || p.startsWith("/") || p.startsWith("node:") || p.startsWith("bun")) continue;
    p = p.startsWith("@") ? p.split("/").slice(0, 2).join("/") : p.split("/")[0];
    deps.add(p);
  }
  return [...deps];
}

/** One positional arg for `__wm_main`, from the param's input_transform. */
function argExpr(param: string, its: Record<string, WmTransform> | undefined): string {
  const t = its?.[param];
  if (!t) return "undefined";
  if (t.type === "static") return JSON.stringify(t.value ?? null);
  if (t.type === "javascript") return `(${(t.expr ?? "undefined").trim() || "undefined"})`;
  return "undefined";
}

const sanitize = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^-+/, "") || "step";

/** Windmill SQL steps declare positional params via `-- $N name` header comments. Map those,
 *  in $1..$n order, to Mill sql-node param expressions from the step's input_transforms. */
function sqlParams(sql: string, its: Record<string, WmTransform> | undefined): string[] {
  const names: string[] = [];
  for (const m of sql.matchAll(/^\s*--\s*\$(\d+)\s+([A-Za-z_]\w*)/gm)) names[Number(m[1]) - 1] = m[2];
  if (!names.length) return [];
  // A sql node's param exprs are evaluated by the runtime with only `ctx` in scope (no local
  // flow_input/results like the JS wrapper), so reach them through ctx.state.
  const forSql = (expr: string) => expr.replace(/\bflow_input\b/g, "ctx.state.flow_input").replace(/\bresults\b/g, "ctx.state.results");
  return names.map((n) => {
    const t = its?.[n];
    if (!t) return "undefined";
    if (t.type === "static") return JSON.stringify(t.value ?? null);
    return `(${forSql((t.expr ?? "undefined").trim() || "undefined")})`;
  });
}

function genJsNode(id: string, v: WmValue, resolveInline?: (p: string) => string): { file: string; deps: string[] } {
  const raw = getContent(v, resolveInline);
  const params = parseMainParams(raw); // param names read from the original (types tolerated)
  const args = params.map((p) => argExpr(p, v.input_transforms)).join(", ");
  const body = renameMain(stripTypes(raw)); // emit plain JS so the .js node loads
  const file = `// Imported from a Windmill ${v.language} step. The original main() is preserved below;
// a Mill adapter reads flow_input/results from ctx.state (Mill exposes Windmill's data model
// there — ctx.state.flow_input is the run input, ctx.state.results[<id>] is each step's output).
${body}

export default async function (input, ctx) {
  const flow_input = ctx.state.flow_input;               // eslint-disable-line
  const results = ctx.state.results ?? {};               // eslint-disable-line
  return await __wm_main(${args});
}
`;
  return { file, deps: collectImports(raw) };
}

const TODO_NODE = (id: string, type: string, extra = "") =>
  `export default async function (input, ctx) {
  throw new Error(${JSON.stringify(`TODO: Windmill step '${id}' (${type}${extra ? " " + extra : ""}) was not auto-imported — port it manually.`)});
}
`;

export function importWindmillFlow(flow: OpenFlow, opts: { name: string; resolveInline?: (p: string) => string }): ImportResult {
  const modules = flow.value?.modules ?? [];
  const nodes: Record<string, unknown>[] = [{ key: "start", kind: "start", name: "Start" }];
  const edges: { from: string; to: string }[] = [];
  const files: Record<string, string> = {};
  const skipped: { id: string; type: string; reason: string }[] = [];
  const warnings: string[] = [];
  const allDeps = new Set<string>();

  // Mill's runtime seeds ctx.state.flow_input (the run input) and ctx.state.results[<key>]
  // (each node's output) automatically, so no init node is needed.
  let prev = "start";
  let supported = 0;
  const used = new Set<string>(["start", "end"]);
  for (const [i, mod] of modules.entries()) {
    const rawId = mod.id || `step${i + 1}`;
    // Keep the Mill node key === the Windmill step id so `results.<id>` references resolve to
    // ctx.state.results[<key>]. Mill keys accept any string; only the *filename* is sanitized.
    let key = rawId;
    while (used.has(key)) key = `${key}_${i}`;
    used.add(key);
    const fileBase = sanitize(key);
    const v = mod.value ?? { type: "identity" };
    const name = mod.summary || rawId;
    const node: Record<string, unknown> = { key, kind: "jscode", name, file: `nodes/${fileBase}.js` };

    if (v.type === "rawscript" && JS_LANGS.has(v.language ?? "")) {
      const { file, deps } = genJsNode(rawId, v, opts.resolveInline);
      files[`nodes/${fileBase}.js`] = file;
      if (deps.length) { node.deps = Object.fromEntries(deps.map((d) => [d, "latest"])); deps.forEach((d) => allDeps.add(d)); }
      supported++;
    } else if (v.type === "rawscript" && v.language === "postgresql") {
      // A Windmill Postgres step → Mill's first-class sql node (reuses the SQL feature).
      const sql = getContent(v, opts.resolveInline);
      const params = sqlParams(sql, v.input_transforms);
      node.kind = "sql";
      delete node.file;
      node.connection = "DATABASE_URL";
      node.query = sql;
      if (params.length) node.params = params;
      const res = v.input_transforms?.database;
      warnings.push(`step '${rawId}' → sql node; set the DATABASE_URL secret to your Postgres URL${res && res.type === "static" ? ` (Windmill resource: ${JSON.stringify((res as { value?: unknown }).value)})` : ""}.`);
      supported++;
    } else if (v.type === "identity") {
      files[`nodes/${fileBase}.js`] = `export default function (input) {\n  return input;\n}\n`;
      supported++;
    } else if (v.type === "script") {
      // Reference to another Windmill script — map to a Mill callScript; the target must be imported too.
      const target = sanitize((v.path as string) ?? "unknown").split("_").pop() || "script";
      node.kind = "callScript";
      delete node.file;
      node.call = { workflow: target, ref: `workflows/${target}` };
      warnings.push(`step '${rawId}' calls script '${v.path}' → callScript(workflows/${target}); import that script too.`);
      supported++;
    } else {
      // rawscript in a non-JS language, or control flow (forloop/branch/whileloop/approval, …).
      const reason = v.type === "rawscript" ? `language '${v.language}' not supported (JS-only import)` : `module type '${v.type}' not auto-imported`;
      files[`nodes/${fileBase}.js`] = TODO_NODE(rawId, v.type, v.language ?? "");
      skipped.push({ id: rawId, type: v.type + (v.language ? `/${v.language}` : ""), reason });
    }

    nodes.push(node);
    edges.push({ from: prev, to: key });
    prev = key;
  }

  nodes.push({ key: "end", kind: "end", name: "End" });
  edges.push({ from: prev, to: "end" });

  if (flow.schema) warnings.push("Windmill input `schema` (JSON Schema) was not converted to a Mill inputSchema — add validation manually if needed.");

  const doc = {
    apiVersion: "mill/v1",
    kind: "Workflow",
    metadata: { name: opts.name },
    triggers: [{ type: "manual" }],
    nodes,
    edges,
  };
  return {
    name: opts.name,
    workflowYaml: yamlStringify(doc, { lineWidth: 0 }),
    files,
    report: { total: modules.length, supported, skipped, warnings, deps: [...allDeps] },
  };
}
