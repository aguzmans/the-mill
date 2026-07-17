import { test, expect, describe } from "bun:test";
import { TriggerEngine, type TriggerDef } from "../src/triggers";

describe("TriggerEngine", () => {
  test("registers webhooks and reports them", () => {
    const e = new TriggerEngine(() => {});
    e.sync([{ project: "billing", workflow: "invoices", type: "webhook" }]);
    expect(e.hasWebhook("billing", "invoices")).toBe(true);
    expect(e.summary().webhooks).toContain("billing/invoices");
  });

  test("fires a cron trigger", async () => {
    const fired: TriggerDef[] = [];
    const e = new TriggerEngine((t) => fired.push(t));
    e.sync([{ project: "billing", workflow: "heartbeat", type: "cron", schedule: "* * * * * *" }]); // every second
    await new Promise((r) => setTimeout(r, 1600));
    e.sync([]); // stop
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(fired[0].workflow).toBe("heartbeat");
  });

  test("sync replaces the previous set (idempotent)", () => {
    const e = new TriggerEngine(() => {});
    e.sync([
      { project: "p", workflow: "a", type: "cron", schedule: "0 0 * * *" },
      { project: "p", workflow: "b", type: "webhook" },
    ]);
    expect(e.summary().cron).toBe(1);
    expect(e.hasWebhook("p", "b")).toBe(true);
    e.sync([]);
    expect(e.summary().cron).toBe(0);
    expect(e.hasWebhook("p", "b")).toBe(false);
  });

  test("ignores an invalid cron expression without throwing", () => {
    const e = new TriggerEngine(() => {});
    e.sync([{ project: "p", workflow: "bad", type: "cron", schedule: "not a cron" }]);
    expect(e.summary().cron).toBe(0);
  });
});
