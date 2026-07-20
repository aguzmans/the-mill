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
    nodes[n.key] = {
      key: n.key,
      kind: n.kind,
      name: n.name || n.key,
      file: n.file,
      call: n.call,
      each: n.each,
      retry: n.retry,
      inputSchema: n.inputSchema,
      outputSchema: n.outputSchema,
      secrets: n.secrets,
      condition: n.kind === "if" ? compileCondition(n) : undefined,
      parents: parentsOf(wf, n.key),
      children: childrenOf(wf, n.key).map((e) => ({ to: e.to, branch: e.branch })),
    };
  }

  return { workflow: wf.metadata.name, startKey: start.key, order, nodes, inputSchema: wf.inputSchema };
}
