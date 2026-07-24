import {
  topoSort, childrenOf, parentsOf, compileCondition, hasCycle,
  type WorkflowDef, type ExecPlan, type PlanNode,
} from "@mill/core";

/**
 * Compile a validated workflow into an execution plan (ARCHITECTURE §1, thesis 1).
 * The node kinds map directly onto plan nodes the runtime interprets:
 *   start → entry · jscode → imported module · if → compiled multi-conditional
 *   expression · callScript → invocation · loop → forEach over a body · end → return.
 * Validate the workflow before calling this — buildPlan assumes the graph is sound.
 */
export function buildPlan(wf: WorkflowDef): ExecPlan {
  const start = wf.nodes.find((n) => n.kind === "start");
  if (!start) throw new Error(`workflow '${wf.metadata.name}' has no start node`);
  if (hasCycle(wf)) throw new Error(`workflow '${wf.metadata.name}' has a cycle (loops are not supported)`);

  const order = topoSort(wf);
  const nodes: Record<string, PlanNode> = {};
  for (const n of wf.nodes) {
    // A sql node's connection is a secret ref — declare it automatically so ctx.secrets exposes
    // it without the author also listing it under `secrets:`.
    const secrets = n.kind === "sql" && n.connection
      ? [...new Set([...(n.secrets ?? []), n.connection])]
      : n.secrets;
    nodes[n.key] = {
      key: n.key,
      kind: n.kind,
      name: n.name || n.key,
      file: n.file,
      call: n.call,
      each: n.each,
      retry: n.retry,
      continueOnError: n.continueOnError,
      inputSchema: n.inputSchema,
      outputSchema: n.outputSchema,
      secrets,
      condition: n.kind === "if" ? compileCondition(n) : undefined,
      // sql fields (v1: postgres) — carried onto the plan for the runtime's `case "sql"`.
      dialect: n.kind === "sql" ? (n.dialect ?? "postgres") : undefined,
      connection: n.connection,
      query: n.query,
      params: n.params,
      paramsFrom: n.paramsFrom,
      mode: n.kind === "sql" ? (n.mode ?? "single") : n.mode,
      transaction: n.transaction,
      timeoutMs: n.timeoutMs,
      parents: parentsOf(wf, n.key),
      children: childrenOf(wf, n.key).map((e) => ({ to: e.to, branch: e.branch })),
    };
  }

  return { workflow: wf.metadata.name, startKey: start.key, order, nodes, inputSchema: wf.inputSchema };
}
