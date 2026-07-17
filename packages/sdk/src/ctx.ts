// The Mill SDK surface handed to node code as `ctx` (ARCHITECTURE §3.5, decision #2).
// v1: log, secrets (declared refs only), inputs (fan-in), state (retry journal) + global fetch.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Ctx {
  log: Record<LogLevel, (message: string, fields?: LogFields) => void>;
  secrets: Record<string, string>;
  inputs: Record<string, unknown>;
  state: Record<string, unknown>;
}

export type RunEvent =
  | { type: "log"; node: string; level: LogLevel; message: string; fields?: LogFields }
  | { type: "node"; node: string; status: "running" | "succeeded" | "failed" | "skipped"; ms?: number; error?: string };

export interface MakeCtxOpts {
  node: string;
  inputs: Record<string, unknown>;
  /** All secrets the worker holds (flat, per-namespace). */
  allSecrets: Record<string, string>;
  /** The node's declared secret refs — only these are exposed into ctx.secrets. */
  declared?: string[];
  /** Shared state store (survives retries; scoped to the run). */
  state: Record<string, unknown>;
  onEvent?: (e: RunEvent) => void;
}

/**
 * Build the `ctx` for one node. Secrets are scrubbed to the node's declared refs even
 * though the worker holds them all — the least-privilege seam for Scope B.
 */
export function makeCtx(opts: MakeCtxOpts): Ctx {
  const secrets: Record<string, string> = {};
  for (const name of opts.declared ?? []) {
    if (name in opts.allSecrets) secrets[name] = opts.allSecrets[name];
  }
  const emit = (level: LogLevel) => (message: string, fields?: LogFields) =>
    opts.onEvent?.({ type: "log", node: opts.node, level, message, fields });

  return {
    log: { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") },
    secrets,
    inputs: opts.inputs,
    state: opts.state,
  };
}
