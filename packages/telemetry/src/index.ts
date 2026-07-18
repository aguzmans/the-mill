// Minimal structured telemetry: JSON logs (Loki-ready via Alloy) + a tiny timing helper.
// Kept dependency-free; the production swap is pino + OpenTelemetry behind this same surface
// (metrics are exposed separately at GET /api/metrics in Prometheus format).

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.MILL_LOG_LEVEL as LogLevel) in LEVELS ? (process.env.MILL_LOG_LEVEL as LogLevel) : "info"];
// Human-readable lines in a TTY; structured JSON otherwise (containers, log shippers).
const JSON_LOGS = process.env.MILL_LOG_FORMAT === "json" || !process.stdout.isTTY;

const redact = (s: string) => s.replace(/github_pat_[A-Za-z0-9_]+/g, "<TOKEN>").replace(/x-access-token:[^@]+@/g, "x-access-token:***@");

/** A logger bound to a component name (e.g. "api", "worker"). */
export function createLogger(component: string) {
  const emit = (level: LogLevel, msg: string, fields?: Fields) => {
    if (LEVELS[level] < MIN) return;
    const rec = { ts: new Date().toISOString(), level, component, msg: redact(msg), ...(fields ?? {}) };
    const line = JSON_LOGS ? JSON.stringify(rec) : `${rec.ts} ${level.toUpperCase().padEnd(5)} [${component}] ${rec.msg}${fields ? " " + redact(JSON.stringify(fields)) : ""}`;
    (level === "error" ? console.error : console.log)(line);
  };
  return {
    debug: (m: string, f?: Fields) => emit("debug", m, f),
    info: (m: string, f?: Fields) => emit("info", m, f),
    warn: (m: string, f?: Fields) => emit("warn", m, f),
    error: (m: string, f?: Fields) => emit("error", m, f),
    /** Time an async op and log its duration (ms). */
    async time<T>(msg: string, fn: () => Promise<T>, fields?: Fields): Promise<T> {
      const t0 = performance.now();
      try { const r = await fn(); emit("info", msg, { ...fields, ms: Math.round(performance.now() - t0) }); return r; }
      catch (e) { emit("error", msg + " failed", { ...fields, ms: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e) }); throw e; }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
