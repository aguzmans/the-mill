import { Cron } from "croner";

// Cron parsing/validation for the trigger editor. Uses the SAME library (croner) as the
// controller's TriggerEngine, so the preview + validation here match exactly what will
// actually be scheduled after Save — no drift between "what the UI accepts" and "what runs".

/** Quick-pick schedules. `value` is a standard 5-field cron; `label` describes it. */
export const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every 15 min", value: "*/15 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily 9am", value: "0 9 * * *" },
  { label: "Weekdays 9am", value: "0 9 * * 1-5" },
  { label: "Mon 8am", value: "0 8 * * 1" },
  { label: "1st of month", value: "0 0 1 * *" },
];

/** null when the expression is a valid, firing cron; otherwise a short human-readable error. */
export function cronError(expr: string): string | null {
  const s = (expr ?? "").trim();
  if (!s) return "A cron trigger needs a schedule";
  let c: Cron;
  try {
    c = new Cron(s);
  } catch (e) {
    return cleanMessage(e instanceof Error ? e.message : String(e));
  }
  // croner accepts some patterns that can never fire (e.g. Feb 30). Treat "no next run" as invalid.
  if (!c.nextRun()) return "Valid syntax, but this schedule never fires";
  return null;
}

/**
 * Up to `n` upcoming fire times, computed in UTC so the preview matches what the controller
 * actually schedules (its TriggerEngine runs in the controller timezone — UTC on staging).
 * Returned Dates are absolute instants, so the caller can render them in UTC or local.
 * Empty array when the expression is invalid.
 */
export function nextRuns(expr: string, n = 5): Date[] {
  try {
    const c = new Cron((expr ?? "").trim(), { timezone: "UTC" });
    return c.nextRuns(n) ?? [];
  } catch {
    return [];
  }
}

/** Compact relative label for an upcoming time, e.g. "in 3h", "in 2d". */
export function untilLabel(d: Date, now = Date.now()): string {
  const s = Math.max(0, Math.round((d.getTime() - now) / 1000));
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

function cleanMessage(m: string): string {
  // croner prefixes errors with "CronPattern: " — trim to the useful part.
  return m.replace(/^CronPattern:\s*/i, "").replace(/\s*$/g, "").replace(/\.$/, "") || "Invalid cron expression";
}
