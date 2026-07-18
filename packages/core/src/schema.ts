import { z } from "zod";

// The Mill project/workflow file format — the single source of truth (no DB).
// Types are inferred from these schemas so the schema and the types never drift.

export const nodeKind = z.enum(["start", "jscode", "if", "callScript", "loop", "fanout", "end"]);

export const ifClause = z.object({
  connector: z.enum(["and", "or"]).optional(), // undefined on the first clause
  expr: z.string().min(1),
});

export const callTarget = z.object({
  workflow: z.string().min(1),
  ref: z.string().min(1), // e.g. "workflows/dunning" (in-project) or "std://…@v2" (remote, later)
  project: z.string().optional(),
  standalone: z.boolean().optional(),
});

export const limits = z.object({
  memMB: z.number().int().positive(),
  cpuMs: z.number().int().positive(),
  wallMs: z.number().int().positive(),
  network: z.enum(["none", "egress-allowlist", "full"]),
});

export const workflowNode = z.object({
  key: z.string().min(1),
  kind: nodeKind,
  name: z.string().default(""),
  // jscode:
  file: z.string().optional(),
  deps: z.record(z.string()).optional(),
  inputSchema: z.string().optional(),
  outputSchema: z.string().optional(),
  secrets: z.array(z.string()).optional(),
  limits: limits.optional(),
  // if:
  condition: z.string().optional(),
  conditions: z.array(ifClause).optional(),
  // callScript (also the per-item body of a loop, when the loop calls a script):
  call: callTarget.optional(),
  // retry: per-node retry policy — attempt up to maxAttempts with linear backoff + jitter.
  retry: z.object({ maxAttempts: z.number().int().positive(), backoffMs: z.number().int().nonnegative().optional(), jitter: z.boolean().optional() }).optional(),
  // loop (forEach): iterate an array and run a body per item, collecting results.
  //   `each` is a JS expression over the upstream output (`input`) + `ctx` that yields the
  //   array to iterate (defaults to `input` when omitted). The body is this same node's
  //   `file` (a per-item JS Code module) or `call` (a per-item Call Script) — mutually
  //   exclusive. Iterations run sequentially; `ctx.state` carries across them.
  each: z.string().optional(),
});

export const workflowEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  branch: z.enum(["true", "false"]).optional(), // required on edges leaving an `if`
});

export const trigger = z.object({
  type: z.enum(["cron", "webhook", "manual", "event"]),
  schedule: z.string().optional(),
  path: z.string().optional(),
  concurrencyPolicy: z.enum(["Allow", "Forbid", "Replace"]).optional(),
});

export const workflowDef = z.object({
  apiVersion: z.literal("mill/v1"),
  kind: z.literal("Workflow"),
  metadata: z.object({ name: z.string().min(1) }),
  triggers: z.array(trigger).default([]),
  nodes: z.array(workflowNode).min(1),
  edges: z.array(workflowEdge).default([]),
  concurrencyPolicy: z.enum(["Allow", "Forbid", "Replace"]).optional(),
});

export const projectDef = z.object({
  apiVersion: z.literal("mill/v1"),
  kind: z.literal("Project"),
  metadata: z.object({ name: z.string().min(1) }),
  sync: z
    .object({
      autoSync: z.boolean().default(false),
      selfHeal: z.boolean().default(true),
      prune: z.boolean().default(false),
    })
    .default({}),
  // Per-project ingress auth: the bearer token for this project's /p endpoints is read from
  // the named env var (a k8s Secret ref) — never the value in git. Falls back to the global
  // MILL_INGRESS_TOKEN when unset.
  ingress: z.object({ tokenEnv: z.string().min(1) }).optional(),
});

export type NodeKind = z.infer<typeof nodeKind>;
export type IfClause = z.infer<typeof ifClause>;
export type CallTarget = z.infer<typeof callTarget>;
export type Limits = z.infer<typeof limits>;
export type WorkflowNode = z.infer<typeof workflowNode>;
export type WorkflowEdge = z.infer<typeof workflowEdge>;
export type Trigger = z.infer<typeof trigger>;
export type WorkflowDef = z.infer<typeof workflowDef>;
export type ProjectDef = z.infer<typeof projectDef>;
