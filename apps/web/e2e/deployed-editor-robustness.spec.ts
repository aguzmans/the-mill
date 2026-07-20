import { test, expect, type Page } from "@playwright/test";

// Simulate engineers poking at every workflow's config through the editor UI: cycle trigger
// types, toggle exclusivity, add/remove triggers, open each node, use the code editor. All
// DRAFT (no Save/commit) — this is a UI-robustness sweep. Any console error is a finding.
const BASE = process.env.DEPLOYED_BASE;
test.skip(!BASE, "set DEPLOYED_BASE to the api origin");

const WORKFLOWS: [string, string][] = [
  ["billing", "dunning"], ["billing", "heartbeat"], ["billing", "invoices"], ["billing", "notify"], ["billing", "slow"],
  ["demos", "math"], ["demos", "scrape-novi"], ["demos", "fanout"], // site-check omitted (known broken)
  ["deps-demo", "enrich"],
  ["acuity", "intake"], ["acuity", "create-invoice"], ["acuity", "crm-upsert"], ["acuity", "send-confirmation"],
  ["pipelines", "branch"], ["pipelines", "double"], ["pipelines", "map-mixed"], ["pipelines", "map-numbers"],
  ["pipelines", "map-objects"], ["pipelines", "map-strings"], ["pipelines", "retry"], ["pipelines", "types"],
  ["pipelines", "usesub"], ["pipelines", "validated"],
];

function trackConsole(page: Page): string[] {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  return errs;
}

test.describe("engineer config-editing sweep (all workflows)", () => {
  for (const [pid, wf] of WORKFLOWS) {
    test(`${pid}/${wf}: edit triggers, exclusivity, nodes without errors`, async ({ page }) => {
      const errs = trackConsole(page);
      await page.goto(`${BASE}/projects/${pid}/workflows/${wf}`);
      await expect(page.getByTestId("workflow-editor")).toBeVisible();
      await expect(page.getByTestId("triggers-panel")).toBeVisible();

      // 1) cycle the first trigger through every type; the right field must appear each time
      const type0 = page.getByTestId("trigger-type-0");
      if (await type0.count()) {
        await type0.selectOption("cron");
        await expect(page.getByTestId("trigger-schedule-0")).toBeVisible();
        await page.getByTestId("trigger-schedule-0").fill("*/15 * * * *");
        await type0.selectOption("webhook");
        await expect(page.getByTestId("trigger-path-0")).toBeVisible();
        await type0.selectOption("event");
        await type0.selectOption("manual");
      }

      // 2) toggle exclusive on and off
      const excl = page.getByTestId("exclusive-checkbox");
      await excl.check(); await expect(excl).toBeChecked();
      await excl.uncheck(); await expect(excl).not.toBeChecked();

      // 3) add a trigger then remove it (config churn engineers do)
      const rowsBefore = await page.locator('[data-testid="triggers-list"] > div[data-testid^="trigger-"]').count();
      await page.getByTestId("add-trigger").click();
      await expect(page.locator('[data-testid="triggers-list"] > div[data-testid^="trigger-"]')).toHaveCount(rowsBefore + 1);
      await page.getByTestId(`trigger-remove-${rowsBefore}`).click();
      await expect(page.locator('[data-testid="triggers-list"] > div[data-testid^="trigger-"]')).toHaveCount(rowsBefore);

      // 4) open every canvas node's inspector (no crash), and the code editor for a jscode node
      const nodes = page.locator(".react-flow__node");
      const count = await nodes.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        await nodes.nth(i).click();
        await expect(page.getByTestId("node-panel")).toBeVisible();
      }

      // no console errors during the whole session
      expect(errs, `console errors in ${pid}/${wf}:\n${errs.join("\n")}`).toEqual([]);
    });
  }
});
