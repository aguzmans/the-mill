import { stringify as yamlStringify } from "yaml";

// Windmill OpenFlow → Mill project importer (JS/TS + Postgres + control flow).
//
// Data wiring: Windmill steps reference `flow_input.*` and `results.<step>.*`; Mill's runtime
// exposes both on `ctx.state`, so imported steps read from there — reproducing Windmill's DAG.
// Control flow maps onto Mill's own node kinds, INLINE in the same run (so ctx.state is intact):
//   rawscript(js) → jscode · rawscript(postgres) → sql · script/flow → callScript (args prep)
//   branchone → if-node chain · branchall → split+join · forloopflow → loop node
// Anything Mill has no primitive for (whileloop, multi-module loop body, wmill.* APIs) becomes a
// loud TODO node + a report entry. Nothing is dropped silently.

export type WmTransform = { type: "static"; value?: unknown } | { type: "javascript"; expr?: string };
export interface WmBranch { summary?: string; expr?: string; modules?: WmModule[] }
export interface WmValue {
  type: string; content?: unknown; language?: string; path?: string;
  input_transforms?: Record<string, WmTransform>;
  branches?: WmBranch[]; default?: WmModule[]; modules?: WmModule[];
  iterator?: WmTransform; parallel?: boolean; skip_failures?: boolean;
  [k: string]: unknown;
}
export interface WmModule { id?: string; summary?: string; value?: WmValue; continue_on_error?: boolean; skip_if?: { expr?: string } }
export interface OpenFlow { summary?: string; description?: string; value?: { modules?: WmModule[] }; schema?: unknown }

export interface ImportReport { total: number; supported: number; skipped: { id: string; type: string; reason: string }[]; warnings: string[]; deps: string[] }
export interface SubWorkflow { name: string; workflowYaml: string; files: Record<string, string> }
export interface ImportResult { name: string; workflowYaml: string; files: Record<string, string>; report: ImportReport; subWorkflows: SubWorkflow[]; dependencies: string[] }

type Emit = { entry: string; exits: string[] };
type MNode = Record<string, unknown>;
type MEdge = { from: string; to: string; branch?: "true" | "false" };

const JS_LANGS = new Set(["bun", "deno", "nativets"]);
const sanitize = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^-+/, "") || "step";

// ── content + code helpers ──────────────────────────────────────────────────
export type Inline = { __inline: string };
const isInline = (v: unknown): v is Inline => !!v && typeof v === "object" && "__inline" in (v as object);
function getContent(v: WmValue, resolveInline?: (p: string) => string): string {
  const c = v.content;
  if (isInline(c)) return resolveInline ? resolveInline(c.__inline) : `/* missing inline: ${c.__inline} */`;
  return typeof c === "string" ? c : "";
}
export function parseMainParams(content: string): string[] {
  const m = content.match(/function\s+main\s*\(([\s\S]*?)\)/);
  if (!m) return [];
  return splitTopLevel(m[1]).map((p) => p.trim()).filter(Boolean).map((p) => p.replace(/^\.\.\./, "").split(/[:=]/)[0].trim()).filter(Boolean);
}
function splitTopLevel(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of s) { if ("<([{".includes(ch)) depth++; else if (">)]}".includes(ch)) depth--; if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch; }
  if (cur.trim()) out.push(cur); return out;
}
function stripTypes(content: string): string {
  const B = (globalThis as { Bun?: { Transpiler: new (o: unknown) => { transformSync(s: string): string } } }).Bun;
  if (B) { try { return new B.Transpiler({ loader: "ts" }).transformSync(content); } catch { /* keep raw */ } }
  return content;
}
const renameMain = (content: string) => content.replace(/export\s+(?:default\s+)?(?:async\s+)?function\s+main\s*\(/, "async function __wm_main(");
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

// Collect every SQL step id across the WHOLE tree (nested too) — so `results.<sqlStep>` refs
// anywhere get a `.rows` (a Windmill SQL step's output is the rows array; Mill's sql node
// returns `{ rows, … }`).
function collectSqlIds(modules: WmModule[] | undefined, into: Set<string>): void {
  for (const m of modules ?? []) {
    const v = m.value;
    if (!v) continue;
    if (v.type === "rawscript" && v.language === "postgresql" && m.id) into.add(m.id);
    collectSqlIds(v.default, into);
    collectSqlIds(v.modules, into);
    for (const b of v.branches ?? []) collectSqlIds(b.modules, into);
  }
}
// Every step id inside a (sub)chain — so a loop body's sub-workflow can tell its OWN steps'
// `results.<id>` (its ctx.state) from PARENT `results.<id>` (threaded via the loop envelope).
function collectIds(modules: WmModule[] | undefined, into: Set<string>): void {
  for (const m of modules ?? []) {
    if (m.id) into.add(m.id);
    const v = m.value; if (!v) continue;
    collectIds(v.default, into); collectIds(v.modules, into);
    for (const b of v.branches ?? []) collectIds(b.modules, into);
  }
}

class Importer {
  nodes: MNode[] = [{ key: "start", kind: "start", name: "Start" }];
  edges: MEdge[] = [];
  files: Record<string, string> = {};
  skipped: ImportReport["skipped"] = [];
  warnings: string[] = [];
  deps = new Set<string>();
  used = new Set<string>(["start", "end"]);
  total = 0; supported = 0;
  subWorkflows: { name: string; workflowYaml: string; files: Record<string, string> }[] = [];
  dependencies = new Set<string>(); // other workflows this one callScripts to (script/flow refs)

  // `envelope` mode = this Importer emits a loop-body sub-workflow whose input is an envelope
  // `{ item, index, flow_input, results }` (the loop threads the parent context through). `bodyIds`
  // are the ids emitted here, so `results.<id>` resolves to OUR ctx.state vs. the parent snapshot.
  constructor(private resolveInline: ((p: string) => string) | undefined, public sqlIds: Set<string>, private envelope = false, private bodyIds = new Set<string>()) {}

  // Local bindings every generated JS node opens with — so exprs use bare flow_input/results/iter.
  private preamble(): string {
    return this.envelope
      ? `  const env = ctx.state.flow_input;                          // eslint-disable-line
  const flow_input = env.flow_input;                          // eslint-disable-line
  const results = { ...(env.results ?? {}), ...(ctx.state.results ?? {}) }; // parent snapshot + our own
  const iter = { value: env.item, index: env.index };         // eslint-disable-line`
      : `  const flow_input = ctx.state.flow_input;                    // eslint-disable-line
  const results = ctx.state.results ?? {};                    // eslint-disable-line
  const iter = { value: ctx.state.item, index: ctx.state.index }; // eslint-disable-line`;
  }

  fresh(id: string): string { let k = id || "step"; let i = 1; while (this.used.has(k)) k = `${id}_${i++}`; this.used.add(k); return k; }
  edge(from: string, to: string, branch?: "true" | "false") { this.edges.push(branch ? { from, to, branch } : { from, to }); }
  warn(s: string) { this.warnings.push(s); }
  skip(id: string, type: string, reason: string) { this.skipped.push({ id, type, reason }); }

  // results.<id> → results.<id>.rows for SQL steps (for JS wrappers where flow_input/results are locals)
  private rowsFix(expr: string): string {
    let e = expr;
    for (const id of this.sqlIds) { const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); e = e.replace(new RegExp(`\\bresults\\.${esc}\\b`, "g"), `results.${id}.rows`); }
    return e;
  }
  // For runtime-evaluated exprs (if conditions, loop `each`, sql params): reach ctx.state (there
  // are no local flow_input/results here). In envelope mode, resolve parent vs. own refs.
  private ctxExpr(expr: string): string {
    let e = this.rowsFix(expr);
    if (!this.envelope) return e.replace(/\bflow_input\b/g, "ctx.state.flow_input").replace(/\bresults\b/g, "ctx.state.results");
    e = e.replace(/\bresults\.([A-Za-z_$][\w$]*)/g, (_, id) => (this.bodyIds.has(id) ? `ctx.state.results.${id}` : `ctx.state.flow_input.results.${id}`));
    e = e.replace(/\bflow_input\b/g, "ctx.state.flow_input.flow_input");
    return e.replace(/\biter\.value\b/g, "ctx.state.flow_input.item").replace(/\biter\.index\b/g, "ctx.state.flow_input.index");
  }

  // An arg expression for a JS wrapper (flow_input/results/iter are locals in scope).
  private jsArg(t: WmTransform | undefined): string {
    if (!t) return "undefined";
    if (t.type === "static") return JSON.stringify(t.value ?? null);
    return `(${this.rowsFix((t.expr ?? "undefined").trim() || "undefined")})`;
  }

  private jsFile(v: WmValue): { file: string; deps: string[] } {
    const raw = getContent(v, this.resolveInline);
    const args = parseMainParams(raw).map((p) => this.jsArg(v.input_transforms?.[p])).join(", ");
    const body = renameMain(stripTypes(raw));
    const file = `// Imported from a Windmill ${v.language} step. main() preserved; the adapter reads
// flow_input / results / iter from ctx.state (Mill exposes Windmill's data model there).
${body}

export default async function (input, ctx) {
${this.preamble()}
  return await __wm_main(${args});
}
`;
    return { file, deps: collectImports(raw) };
  }

  private passthrough(name: string, key: string): Emit {
    this.files[`nodes/${sanitize(key)}.js`] = `export default function (input) {\n  return input;\n}\n`;
    this.nodes.push({ key, kind: "jscode", name, file: `nodes/${sanitize(key)}.js` });
    return { entry: key, exits: [key] };
  }
  // skip_if: run the step only when the expression is FALSE. An `if` guard routes true → a
  // "skipped" passthrough (the step never runs, so `results.<id>` stays undefined, matching
  // Windmill), false → the step. Both paths converge at the continuation.
  private wrapSkipIf(rawId: string, expr: string, inner: Emit): Emit {
    const ifKey = this.fresh(`${rawId}_skipif`);
    const skipKey = this.fresh(`${rawId}_skipped`);
    this.nodes.push({ key: ifKey, kind: "if", name: `skip ${rawId}?`, condition: this.ctxExpr(expr.trim() || "false") });
    this.files[`nodes/${sanitize(skipKey)}.js`] = `export default function () {\n  return null; // step '${rawId}' skipped (skip_if)\n}\n`;
    this.nodes.push({ key: skipKey, kind: "jscode", name: `${rawId} (skipped)`, file: `nodes/${sanitize(skipKey)}.js` });
    this.edge(ifKey, skipKey, "true");   // skip_if true → skip the step
    this.edge(ifKey, inner.entry, "false"); // else run it
    return { entry: ifKey, exits: [skipKey, ...inner.exits] };
  }

  private todo(id: string, type: string, key: string): Emit {
    this.files[`nodes/${sanitize(key)}.js`] = `export default async function () {\n  throw new Error(${JSON.stringify(`TODO: Windmill step '${id}' (${type}) was not auto-imported — port it manually.`)});\n}\n`;
    this.nodes.push({ key, kind: "jscode", name: `TODO: ${id}`, file: `nodes/${sanitize(key)}.js` });
    return { entry: key, exits: [key] };
  }

  // Emit one module → its entry node + exit node(s).
  emitModule(mod: WmModule): Emit {
    this.total++;
    const v = mod.value ?? { type: "identity" };
    const rawId = mod.id || "step";
    const key = this.fresh(rawId);
    const name = mod.summary || rawId;
    const applyCoe = (nodeKey: string) => { if (mod.continue_on_error) { const n = this.nodes.find((x) => x.key === nodeKey); if (n) n.continueOnError = true; } };

    let out: Emit;
    if (v.type === "rawscript" && JS_LANGS.has(v.language ?? "")) {
      const { file, deps } = this.jsFile(v);
      this.files[`nodes/${sanitize(key)}.js`] = file;
      const node: MNode = { key, kind: "jscode", name, file: `nodes/${sanitize(key)}.js` };
      if (deps.length) { node.deps = Object.fromEntries(deps.map((d) => [d, "latest"])); deps.forEach((d) => this.deps.add(d)); }
      this.nodes.push(node); this.supported++; out = { entry: key, exits: [key] };
    } else if (v.type === "rawscript" && v.language === "postgresql") {
      const sql = getContent(v, this.resolveInline);
      const names: string[] = [];
      for (const m of sql.matchAll(/^\s*--\s*\$(\d+)\s+([A-Za-z_]\w*)/gm)) names[Number(m[1]) - 1] = m[2];
      const params = names.map((n) => (n && v.input_transforms?.[n] ? (v.input_transforms[n].type === "static" ? JSON.stringify((v.input_transforms[n] as { value?: unknown }).value ?? null) : `(${this.ctxExpr(((v.input_transforms[n] as { expr?: string }).expr ?? "undefined").trim())})`) : "undefined"));
      const node: MNode = { key, kind: "sql", name, connection: "DATABASE_URL", query: sql };
      if (params.length) node.params = params;
      this.nodes.push(node); this.supported++;
      const pin = sql.match(/^\s*--\s*database\s+(\S+)/m)?.[1];
      this.warn(`step '${rawId}' → sql node; point the DATABASE_URL secret at ${pin ? `the Windmill resource '${pin}'` : "your Postgres URL"}.`);
      out = { entry: key, exits: [key] };
    } else if (v.type === "script" || v.type === "flow") {
      out = this.emitCall(rawId, key, v, name);
    } else if (v.type === "identity") {
      out = this.passthrough(name, key);
      this.supported++;
    } else if (v.type === "branchone") {
      out = this.emitBranchOne(rawId, key, v);
    } else if (v.type === "branchall") {
      out = this.emitBranchAll(rawId, key, v, name);
    } else if (v.type === "forloopflow") {
      out = this.emitLoop(rawId, key, v, name);
    } else {
      this.skip(rawId, v.type + (v.language ? `/${v.language}` : ""), v.type === "rawscript" ? `language '${v.language}' not supported (JS-only)` : `module type '${v.type}' not auto-imported`);
      out = this.todo(rawId, v.type, key);
    }
    applyCoe(out.exits[out.exits.length - 1]);
    if (mod.skip_if?.expr?.trim()) out = this.wrapSkipIf(rawId, mod.skip_if.expr, out);
    return out;
  }

  // script / flow ref → a "prep" jscode (builds the named args) + a callScript to the target.
  private emitCall(rawId: string, callKey: string, v: WmValue, name: string): Emit {
    const target = sanitize(((v.path as string) ?? "unknown").split("/").pop() || "script");
    const prepKey = this.fresh(`${rawId}_args`);
    const fields = Object.entries(v.input_transforms ?? {}).map(([k, t]) => `${JSON.stringify(k)}: ${this.jsArg(t)}`).join(", ");
    this.files[`nodes/${sanitize(prepKey)}.js`] = `export default async function (input, ctx) {
${this.preamble()}
  return { ${fields} };                     // args for ${target}
}
`;
    this.nodes.push({ key: prepKey, kind: "jscode", name: `${name} · args`, file: `nodes/${sanitize(prepKey)}.js` });
    this.nodes.push({ key: callKey, kind: "callScript", name, call: { workflow: target, ref: `workflows/${target}` } });
    this.edge(prepKey, callKey);
    this.dependencies.add(target); // this workflow depends on the referenced script/flow
    this.warn(`step '${rawId}' calls ${v.type} '${v.path}' → callScript(workflows/${target}); import that ${v.type} too.`);
    this.supported++;
    return { entry: prepKey, exits: [callKey] };
  }

  // branchone → a chain of `if` nodes (pick the first true branch, else default), inlined.
  private emitBranchOne(rawId: string, firstKey: string, v: WmValue): Emit {
    const branches = v.branches ?? [];
    const build = (i: number): Emit => {
      if (i >= branches.length) {
        const def = this.emitChain(v.default ?? []);
        return def ?? this.passthrough("(no branch)", this.fresh(`${rawId}_else`));
      }
      const br = branches[i];
      const ifKey = i === 0 ? firstKey : this.fresh(`${rawId}_b${i}`);
      this.nodes.push({ key: ifKey, kind: "if", name: br.summary || `branch ${i + 1}`, condition: this.ctxExpr((br.expr ?? "false").trim() || "false") });
      const trueSide = this.emitChain(br.modules ?? []) ?? this.passthrough(`branch ${i + 1}`, this.fresh(`${rawId}_t${i}`));
      const falseSide = build(i + 1);
      this.edge(ifKey, trueSide.entry, "true");
      this.edge(ifKey, falseSide.entry, "false");
      return { entry: ifKey, exits: [...trueSide.exits, ...falseSide.exits] };
    };
    this.supported++;
    return build(0);
  }

  // branchall → run every branch (sequentially — Mill has no parallel), then a join that
  // collects each branch's last result into an array (Windmill's branchall result shape).
  private emitBranchAll(rawId: string, joinKey: string, v: WmValue, name: string): Emit {
    if (v.parallel) this.warn(`branchall '${rawId}' ran branches in parallel in Windmill; Mill runs them sequentially.`);
    const split = this.passthrough(`${name} · split`, this.fresh(`${rawId}_split`));
    const lastOfEach: string[] = [];
    const joinParents: string[] = [];
    for (const [i, br] of (v.branches ?? []).entries()) {
      const chain = this.emitChain(br.modules ?? []) ?? this.passthrough(`branch ${i + 1}`, this.fresh(`${rawId}_e${i}`));
      this.edge(split.entry, chain.entry);
      lastOfEach.push(chain.exits[chain.exits.length - 1]);
      joinParents.push(...chain.exits);
    }
    const collect = lastOfEach.map((k) => `results[${JSON.stringify(k)}]`).join(", ");
    this.files[`nodes/${sanitize(joinKey)}.js`] = `export default function (input, ctx) {\n  const results = ctx.state.results ?? {};\n  return [ ${collect} ];\n}\n`;
    this.nodes.push({ key: joinKey, kind: "jscode", name: `${name} · join`, file: `nodes/${sanitize(joinKey)}.js` });
    for (const p of joinParents) this.edge(p, joinKey);
    this.supported++;
    return { entry: split.entry, exits: [joinKey] };
  }

  // forloopflow → Mill loop node. Single JS body → a loop-body file (item/iter in ctx.state).
  private emitLoop(rawId: string, loopKey: string, v: WmValue, name: string): Emit {
    if (v.parallel) this.warn(`loop '${rawId}' ran in parallel in Windmill; Mill runs iterations sequentially.`);
    const body = v.modules ?? [];
    const each = this.ctxExpr((v.iterator?.type === "javascript" ? v.iterator.expr : undefined)?.trim() || "input");
    if (body.length === 1 && body[0].value?.type === "rawscript" && JS_LANGS.has(body[0].value?.language ?? "")) {
      const { file, deps } = this.jsFile(body[0].value!);
      const bodyFile = `nodes/${sanitize(loopKey)}_body.js`;
      this.files[bodyFile] = file;
      const node: MNode = { key: loopKey, kind: "loop", name, file: bodyFile, each };
      if (deps.length) { node.deps = Object.fromEntries(deps.map((d) => [d, "latest"])); deps.forEach((d) => this.deps.add(d)); }
      this.nodes.push(node); this.supported++;
      return { entry: loopKey, exits: [loopKey] };
    }
    // Any other body (multiple steps, or a single sql/callScript/branch step) → extract to a
    // sub-workflow the loop calls per item, threading the parent context through an envelope.
    if (body.length) {
      const bodyName = sanitize(`${loopKey}_body`);
      const bodyIds = new Set<string>(); collectIds(body, bodyIds);
      const sub = new Importer(this.resolveInline, this.sqlIds, true, bodyIds);
      const chain = sub.emitChain(body);
      sub.nodes.push({ key: "end", kind: "end", name: "End" });
      if (chain) { sub.edge("start", chain.entry); for (const ex of chain.exits) sub.edge(ex, "end"); } else sub.edge("start", "end");
      this.subWorkflows.push({ name: bodyName, workflowYaml: yamlStringify({ apiVersion: "mill/v1", kind: "Workflow", metadata: { name: bodyName }, triggers: [{ type: "manual" }], nodes: sub.nodes, edges: sub.edges }, { lineWidth: 0 }), files: sub.files });
      this.subWorkflows.push(...sub.subWorkflows);
      this.skipped.push(...sub.skipped); this.warnings.push(...sub.warnings); this.total += sub.total; this.supported += sub.supported; sub.deps.forEach((d) => this.deps.add(d)); sub.dependencies.forEach((d) => this.dependencies.add(d));
      // Iterate envelopes so the body sub-workflow can see the parent's flow_input + results.
      const envEach = `(${each}).map((__it, __ix) => ({ item: __it, index: __ix, flow_input: ctx.state.flow_input, results: ctx.state.results }))`;
      this.nodes.push({ key: loopKey, kind: "loop", name, each: envEach, call: { workflow: bodyName, ref: `workflows/${bodyName}` } });
      this.supported++;
      return { entry: loopKey, exits: [loopKey] };
    }
    this.skip(rawId, "forloopflow", "empty loop body");
    return this.todo(rawId, "forloopflow", loopKey);
  }

  // A linear chain of modules → wired entry→…→exits.
  emitChain(modules: WmModule[]): Emit | null {
    if (!modules.length) return null;
    let first: Emit | null = null;
    let prevExits: string[] = [];
    for (const mod of modules) {
      const em = this.emitModule(mod);
      if (!first) first = em; else for (const p of prevExits) this.edge(p, em.entry);
      prevExits = em.exits;
    }
    return { entry: first!.entry, exits: prevExits };
  }
}

export function importWindmillFlow(flow: OpenFlow, opts: { name: string; resolveInline?: (p: string) => string }): ImportResult {
  const sqlIds = new Set<string>(); collectSqlIds(flow.value?.modules, sqlIds);
  const imp = new Importer(opts.resolveInline, sqlIds);

  const chain = imp.emitChain(flow.value?.modules ?? []);
  imp.nodes.push({ key: "end", kind: "end", name: "End" });
  if (chain) { imp.edge("start", chain.entry); for (const ex of chain.exits) imp.edge(ex, "end"); }
  else imp.edge("start", "end");

  if (flow.schema) imp.warn("Windmill input `schema` (JSON Schema) was not converted to a Mill inputSchema — add validation manually if needed.");

  const doc = {
    apiVersion: "mill/v1", kind: "Workflow", metadata: { name: opts.name },
    triggers: [{ type: "manual" }], nodes: imp.nodes, edges: imp.edges,
  };
  return {
    name: opts.name,
    workflowYaml: yamlStringify(doc, { lineWidth: 0 }),
    files: imp.files,
    report: { total: imp.total, supported: imp.supported, skipped: imp.skipped, warnings: imp.warnings, deps: [...imp.deps] },
    subWorkflows: imp.subWorkflows,
    dependencies: [...imp.dependencies],
  };
}
