import { z } from "zod";
import { Cron } from "croner";

// The Mill project/workflow file format — the single source of truth (no DB).
// Types are inferred from these schemas so the schema and the types never drift.

export const nodeKind = z.enum(["start", "jscode", "if", "callScript", "loop", "fanout", "end", "sql"]);

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
  // continueOnError: if this node fails (after retries), don't fail the whole run — record the
  // error, hand downstream nodes a `null` result, and keep going. (Windmill's continue_on_error.)
  continueOnError: z.boolean().optional(),
  // loop (forEach): iterate an array and run a body per item, collecting results.
  //   `each` is a JS expression over the upstream output (`input`) + `ctx` that yields the
  //   array to iterate (defaults to `input` when omitted). The body is this same node's
  //   `file` (a per-item JS Code module) or `call` (a per-item Call Script) — mutually
  //   exclusive. Iterations run sequentially; `ctx.state` carries across them.
  each: z.string().optional(),
  // sql: run a parametrized query against a database (v1: postgres). The connection is a secret
  //   ref holding a URL (e.g. postgres://…); `query` uses $1..$n placeholders bound SERVER-SIDE
  //   (never string-interpolated). Values come from `params` (one JS expression per placeholder)
  //   or `paramsFrom` (a single expression yielding the whole ordered array — precedence over
  //   `params`). `mode:each` runs the query once per item of `each` (item/index in scope), and
  //   `transaction:true` makes that batch atomic. See ARCHITECTURE §SQL.
  dialect: z.enum(["postgres"]).optional(),
  connection: z.string().optional(),
  query: z.string().optional(),
  params: z.array(z.string()).optional(),
  paramsFrom: z.string().optional(),
  mode: z.enum(["single", "each"]).optional(),
  transaction: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).superRefine((n, ctx) => {
  if (n.kind !== "sql") return;
  if (!n.connection?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sql node needs a `connection` (a secret ref, e.g. DATABASE_URL)", path: ["connection"] });
  if (!n.query?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sql node needs a `query`", path: ["query"] });
  if (n.mode === "each" && !n.each?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sql node with mode:each needs an `each` expression (the array to iterate)", path: ["each"] });
});

export const workflowEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  branch: z.enum(["true", "false"]).optional(), // required on edges leaving an `if`
});

export const trigger = z
  .object({
    type: z.enum(["cron", "webhook", "manual", "event"]),
    schedule: z.string().optional(),
    path: z.string().optional(),
    concurrencyPolicy: z.enum(["Allow", "Forbid", "Replace"]).optional(),
  })
  // A cron trigger MUST carry a valid schedule. Validate with croner (the same engine that
  // schedules it) so a malformed expression is rejected at parse time — otherwise the
  // TriggerEngine would silently drop it and the workflow would just never fire.
  .superRefine((t, ctx) => {
    if (t.type !== "cron") return;
    const s = (t.schedule ?? "").trim();
    if (!s) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a cron trigger requires a `schedule`", path: ["schedule"] });
      return;
    }
    try {
      const c = new Cron(s);
      if (!c.nextRun()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cron '${s}' has valid syntax but never fires`, path: ["schedule"] });
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid cron schedule '${s}': ${e instanceof Error ? e.message.replace(/^CronPattern:\s*/i, "") : String(e)}`, path: ["schedule"] });
    }
  });

export const workflowDef = z.object({
  apiVersion: z.literal("mill/v1"),
  kind: z.literal("Workflow"),
  metadata: z.object({ name: z.string().min(1) }),
  triggers: z.array(trigger).default([]),
  nodes: z.array(workflowNode).min(1),
  edges: z.array(workflowEdge).default([]),
  concurrencyPolicy: z.enum(["Allow", "Forbid", "Replace"]).optional(),
  // inputSchema: a JS boolean expression over `input` validated against the RUN input before
  // the start node runs — rejects malformed payloads (e.g. from webhooks) at the boundary.
  inputSchema: z.string().optional(),
  // exclusive: run this workflow ALONE on its worker/pod until it finishes — the worker
  // takes no co-tenant jobs for the duration (heavy/CPU-hungry/memory-hungry runs get the
  // whole pod). Combined with queue-depth autoscaling, an exclusive job in the queue pulls
  // up a fresh pod that dedicates itself to it.
  exclusive: z.boolean().optional(),
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
