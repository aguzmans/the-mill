import { workflowDef, projectDef, type WorkflowDef, type ProjectDef, type WorkflowNode } from "./schema";
import { childrenOf, hasCycle, reachable } from "./graph";

export interface ValidationIssue {
  code: string;
  message: string;
  node?: string;
}
export interface ValidationResult<T> {
  ok: boolean;
  issues: ValidationIssue[];
  value?: T;
}

/** Compile an `if` node's clauses (or single condition) into a JS boolean expression. */
export function compileCondition(node: Pick<WorkflowNode, "condition" | "conditions">): string {
  if (node.conditions && node.conditions.length > 0) {
    return node.conditions
      .map((c, i) => (i === 0 ? "" : c.connector === "or" ? " || " : " && ") + c.expr)
      .join("");
  }
  return node.condition ?? "false";
}

/** Parse + schema-validate a project.yaml object. */
export function parseProject(raw: unknown): ValidationResult<ProjectDef> {
  const p = projectDef.safeParse(raw);
  if (!p.success) return { ok: false, issues: schemaIssues(p.error) };
  return { ok: true, issues: [], value: p.data };
}

/** Parse + schema-validate + graph-validate a workflow.yaml object. */
export function parseWorkflow(raw: unknown): ValidationResult<WorkflowDef> {
  const p = workflowDef.safeParse(raw);
  if (!p.success) return { ok: false, issues: schemaIssues(p.error) };
  const wf = p.data;
  const issues = validateGraph(wf);
  return { ok: issues.length === 0, issues, value: wf };
}

function schemaIssues(err: import("zod").ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({ code: "schema", message: `${i.path.join(".") || "<root>"}: ${i.message}` }));
}

/** The DAG rules the compiler relies on — stronger than FK integrity (ARCHITECTURE §4). */
export function validateGraph(wf: WorkflowDef): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const keys = wf.nodes.map((n) => n.key);
  const byKey = new Map(wf.nodes.map((n) => [n.key, n]));

  if (byKey.size !== wf.nodes.length) {
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    issues.push({ code: "dup-key", message: `duplicate node keys: ${[...new Set(dup)].join(", ")}` });
  }

  const starts = wf.nodes.filter((n) => n.kind === "start");
  if (starts.length !== 1) issues.push({ code: "start", message: `expected exactly one start node, found ${starts.length}` });
  if (!wf.nodes.some((n) => n.kind === "end")) issues.push({ code: "end", message: "expected at least one end node" });

  for (const e of wf.edges) {
    if (!byKey.has(e.from)) issues.push({ code: "edge", message: `edge from unknown node '${e.from}'` });
    if (!byKey.has(e.to)) issues.push({ code: "edge", message: `edge to unknown node '${e.to}'` });
  }

  for (const n of wf.nodes) {
    const outs = childrenOf(wf, n.key);
    const ins = wf.edges.filter((e) => e.to === n.key);
    if (n.kind === "jscode" && !n.file) issues.push({ code: "jscode-file", message: `jscode node '${n.key}' needs a file`, node: n.key });
    if (n.kind === "callScript" && !n.call?.ref) issues.push({ code: "call-ref", message: `callScript node '${n.key}' needs call.ref`, node: n.key });
    if (n.kind === "loop") {
      const hasFile = !!n.file, hasCall = !!n.call?.ref;
      if (hasFile === hasCall) // needs exactly one body: a per-item file XOR a per-item call
        issues.push({ code: "loop-body", message: `loop node '${n.key}' needs exactly one body — a jscode 'file' or a 'call.ref' (got ${hasFile && hasCall ? "both" : "neither"})`, node: n.key });
    }
    if (n.kind === "if") {
      if (!outs.some((e) => e.branch === "true") || !outs.some((e) => e.branch === "false"))
        issues.push({ code: "if-branches", message: `if node '${n.key}' needs both a true and a false branch`, node: n.key });
      if (outs.some((e) => !e.branch))
        issues.push({ code: "if-branch-label", message: `if node '${n.key}' outgoing edges must be labelled true/false`, node: n.key });
      if (!n.condition && !(n.conditions && n.conditions.length))
        issues.push({ code: "if-condition", message: `if node '${n.key}' needs a condition`, node: n.key });
    } else {
      if (outs.some((e) => e.branch)) issues.push({ code: "branch-on-non-if", message: `only 'if' nodes may have branch-labelled edges ('${n.key}')`, node: n.key });
    }
    if (n.kind === "start" && ins.length) issues.push({ code: "start-incoming", message: `start '${n.key}' must have no incoming edges`, node: n.key });
    if (n.kind === "end" && outs.length) issues.push({ code: "end-outgoing", message: `end '${n.key}' must have no outgoing edges`, node: n.key });
  }

  // The graph stays a DAG; iteration is expressed by a `loop` node (which repeats its body
  // internally), not by a back-edge in the graph.
  if (hasCycle(wf)) issues.push({ code: "cycle", message: "workflow graph must be acyclic — express iteration with a 'loop' node, not a back-edge" });

  if (starts.length === 1) {
    const reach = reachable(wf, starts[0].key);
    for (const n of wf.nodes) if (n.key !== starts[0].key && !reach.has(n.key)) issues.push({ code: "unreachable", message: `node '${n.key}' is unreachable from start`, node: n.key });
  }

  return issues;
}
