import { test, expect } from "@playwright/test";

// Per-step "continue if this step fails" toggle in the node inspector (mock mode).
const OUT = process.env.SHOTS || "test-results";

test.describe("continue-on-error toggle", () => {
  test.skip(!!process.env.DEPLOYED_BASE, "mock-mode spec");

  test("shows + toggles per-node failure handling", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    await page.waitForSelector('[data-testid="workflow-editor"]', { timeout: 15000 });
    // select a JS Code node on the canvas
    await page.locator('[data-kind="jscode"]').first().click();
    const toggle = page.getByTestId("continue-on-error");
    await expect(toggle).toBeVisible();
    const box = page.getByTestId("continue-on-error-checkbox");
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
    await page.screenshot({ path: `${OUT}/continue-on-error.png`, fullPage: true });
  });
});
