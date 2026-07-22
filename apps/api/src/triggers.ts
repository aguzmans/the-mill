import { Cron } from "croner";

// The trigger engine registers cron schedules + webhook routes from the reconciled
// workflows (level-triggered: rebuilt on every reconcile). Cron uses app-level scheduling
// (croner) per ARCHITECTURE §9; webhooks are handled by an HTTP route on the controller.

export interface TriggerDef {
  project: string;
  workflow: string;
  type: "cron" | "webhook" | "manual" | "event";
  schedule?: string;
  path?: string;
  concurrencyPolicy?: "Allow" | "Forbid" | "Replace";
}

export class TriggerEngine {
  private crons: Cron[] = [];
  private webhooks = new Set<string>();

  constructor(private onFire: (t: TriggerDef, input: unknown) => void | Promise<void>) {}

  /** Replace all registered triggers with the current set (idempotent). */
  sync(triggers: TriggerDef[]): void {
    for (const c of this.crons) c.stop();
    this.crons = [];
    this.webhooks.clear();
    for (const t of triggers) {
      if (t.type === "cron" && t.schedule) {
        try {
          // Pin the schedule's timezone (default UTC) so fire times are deterministic regardless
          // of the container's TZ — and so the editor's next-run preview (computed in UTC) matches
          // exactly what runs. Override per-deployment with MILL_CRON_TZ (an IANA zone).
          this.crons.push(new Cron(t.schedule, { timezone: process.env.MILL_CRON_TZ || "UTC" }, () => this.onFire(t, {})));
        } catch (e) {
          console.error(`bad cron '${t.schedule}' for ${t.project}/${t.workflow}:`, e instanceof Error ? e.message : e);
        }
      } else if (t.type === "webhook") {
        this.webhooks.add(`${t.project}/${t.workflow}`);
      }
    }
  }

  hasWebhook(project: string, workflow: string): boolean {
    return this.webhooks.has(`${project}/${workflow}`);
  }

  summary() {
    return {
      cron: this.crons.length,
      webhooks: [...this.webhooks],
      nextRuns: this.crons.map((c) => c.nextRun()?.toISOString() ?? null).filter(Boolean).slice(0, 10),
    };
  }
}
