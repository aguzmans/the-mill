import type { WorkflowDef, WorkflowNode } from "./schema";

/** Adjacency helpers over a workflow's edges. */
export function childrenOf(wf: WorkflowDef, key: string) {
  return wf.edges.filter((e) => e.from === key);
}
export function parentsOf(wf: WorkflowDef, key: string) {
  return wf.edges.filter((e) => e.to === key).map((e) => e.from);
}

export function nodeMap(wf: WorkflowDef): Map<string, WorkflowNode> {
  return new Map(wf.nodes.map((n) => [n.key, n]));
}

/** Nodes reachable from `start`, following every outgoing edge. */
export function reachable(wf: WorkflowDef, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const e of childrenOf(wf, k)) stack.push(e.to);
  }
  return seen;
}

/** True if the directed graph has a cycle (Mill v1 workflows must be acyclic). */
export function hasCycle(wf: WorkflowDef): boolean {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>(wf.nodes.map((n) => [n.key, WHITE]));
  const visit = (k: string): boolean => {
    color.set(k, GREY);
    for (const e of childrenOf(wf, k)) {
      const c = color.get(e.to);
      if (c === GREY) return true;
      if (c === WHITE && visit(e.to)) return true;
    }
    color.set(k, BLACK);
    return false;
  };
  for (const n of wf.nodes) if (color.get(n.key) === WHITE && visit(n.key)) return true;
  return false;
}

/**
 * Kahn topological order. Assumes the graph is acyclic (validate first).
 * Ties are broken by the node's position in `wf.nodes` for determinism.
 */
export function topoSort(wf: WorkflowDef): string[] {
  const indeg = new Map<string, number>(wf.nodes.map((n) => [n.key, 0]));
  for (const e of wf.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const order: string[] = [];
  const ready = wf.nodes.filter((n) => (indeg.get(n.key) ?? 0) === 0).map((n) => n.key);
  const seen = new Set<string>();
  while (ready.length) {
    const k = ready.shift()!;
    if (seen.has(k)) continue;
    seen.add(k);
    order.push(k);
    for (const e of childrenOf(wf, k)) {
      const d = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, d);
      if (d <= 0 && !seen.has(e.to)) ready.push(e.to);
    }
  }
  return order;
}
