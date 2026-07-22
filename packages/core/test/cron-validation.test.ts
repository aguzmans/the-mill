import { test, expect, describe } from "bun:test";
import { parseWorkflow } from "../src/index";

// A minimal but structurally-valid workflow (start → end), so the only thing under test is
// the cron trigger's schedule validation.
const wf = (trigger: unknown) => ({
  apiVersion: "mill/v1",
  kind: "Workflow",
  metadata: { name: "w" },
  nodes: [{ key: "start", kind: "start" }, { key: "end", kind: "end" }],
  edges: [{ from: "start", to: "end" }],
  triggers: [trigger],
});

const scheduleIssue = (r: { issues: { message: string }[] }) =>
  r.issues.find((i) => i.message.includes("schedule") || i.message.includes("cron"));

describe("cron trigger schedule validation", () => {
  test("accepts valid 5- and 6-field schedules", () => {
    for (const s of ["0 9 * * 1-5", "*/15 * * * *", "0 0 1 * *", "*/30 * * * * *"]) {
      const r = parseWorkflow(wf({ type: "cron", schedule: s }));
      expect(r.ok).toBe(true);
    }
  });

  test("rejects malformed schedules with a schedule-scoped message", () => {
    for (const s of ["not a cron", "* * * *", "99 * * * *", "0 25 * * *"]) {
      const r = parseWorkflow(wf({ type: "cron", schedule: s }));
      expect(r.ok).toBe(false);
      expect(scheduleIssue(r)).toBeDefined();
    }
  });

  test("rejects a cron trigger with no schedule", () => {
    const r = parseWorkflow(wf({ type: "cron" }));
    expect(r.ok).toBe(false);
    expect(scheduleIssue(r)).toBeDefined();
  });

  test("does not require a schedule for non-cron triggers", () => {
    expect(parseWorkflow(wf({ type: "webhook" })).ok).toBe(true);
    expect(parseWorkflow(wf({ type: "manual" })).ok).toBe(true);
  });
});
