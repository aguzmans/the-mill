import { test, expect } from "@playwright/test";

// Live editor features that need the real backend (the api serves the SPA same-origin, so
// /api calls work with no CORS grant). Set DEPLOYED_BASE=http://api:8080 on the compose net.
const BASE = process.env.DEPLOYED_BASE;
test.skip(!BASE, "set DEPLOYED_BASE to the api origin");

test.describe("deployed editor (live backend)", () => {
  test("exposes the exclusive-execution toggle", async ({ page }) => {
    await page.goto(`${BASE}/projects/demos/workflows/math`);
    await expect(page.getByTestId("triggers-panel")).toBeVisible();
    const toggle = page.getByTestId("exclusive-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText("Run exclusively");
    await page.getByTestId("exclusive-checkbox").check();
    await expect(page.getByTestId("exclusive-checkbox")).toBeChecked();
  });

  test("step-tester runs a single node with supplied input and shows the output", async ({ page }) => {
    await page.goto(`${BASE}/projects/demos/workflows/math`);
    // select the jscode node — `compute` reduces input.numbers to {count,sum,mean,max,min}
    await page.getByTestId("node-compute").click();
    const tester = page.getByTestId("step-tester");
    await expect(tester).toBeVisible();
    await page.getByTestId("step-input").fill('{ "numbers": [10, 20, 30] }');
    await page.getByTestId("step-run").click();
    // a result appears; the node succeeds and returns the computed stats (sum = 60)
    const result = page.getByTestId("step-result");
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result).toHaveAttribute("data-status", "succeeded");
    await expect(page.getByTestId("step-output")).toContainText('"sum": 60');
  });
});
