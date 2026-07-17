import type { NodeKind, CallTarget } from "./schema";

// The compiler's output: a validated, topologically-ordered execution plan that the
// runtime interpreter walks. Lives in core so both @mill/compiler (producer) and
// @mill/sdk (consumer) share the contract without depending on each other.

export interface PlanEdge {
  to: string;
  branch?: "true" | "false"; // set on edges leaving an `if`
}

export interface PlanNode {
  key: string;
  kind: NodeKind;
  name: string;
  file?: string; // jscode: path to the .js, relative to the workflow dir
  condition?: string; // if: the compiled boolean expression
  call?: CallTarget; // callScript (or loop-with-callScript-body): the invocation target
  each?: string; // loop: JS expression selecting the array to iterate (over `input`/`ctx`)
  secrets?: string[]; // declared secret refs exposed to this node's sandbox
  parents: string[]; // upstream node keys
  children: PlanEdge[]; // downstream edges
}

export interface ExecPlan {
  workflow: string;
  startKey: string;
  order: string[]; // topological order
  nodes: Record<string, PlanNode>;
}
