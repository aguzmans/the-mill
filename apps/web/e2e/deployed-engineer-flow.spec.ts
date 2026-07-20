import { test, expect, type Page } from "@playwright/test";

// Simulate the fuller engineer loop against the live backend WITHOUT committing to the repo:
//  (B) change a config, open the Save/commit modal, confirm the change is staged, then CANCEL.
//  (C) probe a node with edge-case inputs in the step-tester and confirm it behaves (never
//      crashes the UI — succeeds or fails gracefully).
const BASE = process.env.DEPLOYED_BASE;
test.skip(!BASE, "set DEPLOYED_BASE to the api origin");

const consoleErrs = (page: Page) => {
  const e: string[] = [];
  page.on("console", (m) => m.type() === "error" && e.push(m.text()));
  page.on("pageerror", (x) => e.push(`pageerror: ${x.message}`));
  return e;
};

test.describe("engineer Save-review flow (no commit)", () => {
  for (const [pid, wf] of [["demos", "math"], ["pipelines", "validated"], ["acuity", "intake"]] as const) {
    test(`${pid}/${wf}: config change stages a commit, then cancel`, async ({ page }) => {
      const errs = consoleErrs(page);
      await page.goto(`${BASE}/projects/${pid}/workflows/${wf}`);
      await expect(page.getByTestId("workflow-editor")).toBeVisible();
      // change a couple of configs
      await page.getByTestId("exclusive-checkbox").check();
      const t0 = page.getByTestId("trigger-type-0");
      if (await t0.count()) { await t0.selectOption("cron"); await page.getByTestId("trigger-schedule-0").fill("*/10 * * * *"); }
      // open Save → the commit modal must show the staged workflow.yaml diff
      await page.getByTestId("save-btn").click();
      const modal = page.getByTestId("commit-modal");
      await expect(modal).toBeVisible();
      await expect(modal).toContainText("workflow.yaml");
      // review, then back out — do NOT commit to the repo
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(modal).toBeHidden();
      expect(errs, `console errors:\n${errs.join("\n")}`).toEqual([]);
    });
  }
});

test.describe("engineer step-tester probing (edge inputs)", () => {
  // (jscode node, edge input, expectation)
  const CASES: [string, string, string, unknown, "succeeded" | "failed"][] = [
    ["demos", "math", "compute", {}, "succeeded"],            // identity node tolerates empty
    ["demos", "math", "compute", null, "succeeded"],          // …and null
    ["pipelines", "validated", "count", { items: "nope" }, "failed"], // schema rejects, gracefully
    ["pipelines", "validated", "count", {}, "failed"],        // missing items → schema fails, no crash
  ];
  for (const [pid, wf, node, input, expected] of CASES) {
    test(`${pid}/${wf} · ${node} · ${JSON.stringify(input)} → ${expected} (no crash)`, async ({ page }) => {
      const errs = consoleErrs(page);
      await page.goto(`${BASE}/projects/${pid}/workflows/${wf}`);
      await page.getByTestId(`node-${node}`).click();
      await expect(page.getByTestId("step-tester")).toBeVisible();
      await page.getByTestId("step-input").fill(JSON.stringify(input));
      await page.getByTestId("step-run").click();
      const result = page.getByTestId("step-result");
      await expect(result).toBeVisible({ timeout: 15000 });
      await expect(result).toHaveAttribute("data-status", expected);
      expect(errs, `console errors:\n${errs.join("\n")}`).toEqual([]);
    });
  }
});
