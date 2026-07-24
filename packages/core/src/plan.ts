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
  each?: string; // loop/sql-each: JS expression selecting the array to iterate (over `input`/`ctx`)
  // sql: a parametrized DB query (v1: postgres). See schema.ts for the field contract.
  dialect?: "postgres";
  connection?: string; // secret ref holding the connection URL
  query?: string; // $1..$n placeholder SQL
  params?: string[]; // one JS expression per placeholder
  paramsFrom?: string; // single JS expression yielding the whole ordered params array (wins over params)
  mode?: "single" | "each"; // each → run once per item of `each`
  transaction?: boolean; // each-mode: wrap the batch in one transaction
  timeoutMs?: number; // statement_timeout backstop
  retry?: { maxAttempts: number; backoffMs?: number; jitter?: boolean }; // per-node retry policy
  continueOnError?: boolean; // on failure (after retries), continue the run with a null output
  inputSchema?: string; // JS boolean expr over `input` — enforced before the node runs
  outputSchema?: string; // JS boolean expr over `output` — enforced after the node runs
  secrets?: string[]; // declared secret refs exposed to this node's sandbox
  parents: string[]; // upstream node keys
  children: PlanEdge[]; // downstream edges
}

export interface ExecPlan {
  workflow: string;
  startKey: string;
  order: string[]; // topological order
  nodes: Record<string, PlanNode>;
  inputSchema?: string; // JS boolean expr over the run `input` — validated before the start node
}
