import { test, expect } from "@playwright/test";

// The "dunning" workflow is Degraded (a bad commit) — running it must surface a
// node failure with an error log, and keep the failure visible in the run panel.
test.describe("workflow failure handling", () => {
  test("a degraded workflow fails a node and logs the error", async ({ page }) => {
    await page.goto("/projects/billing/workflows/dunning");
    await expect(page.getByTestId("workflow-editor")).toBeVisible();

    await page.getByTestId("run-btn").click();

    await expect(page.getByTestId("run-result")).toContainText("Failed", { timeout: 15_000 });
    await expect(page.getByTestId("node-status-send")).toContainText("Failed");
    await expect(page.getByTestId("log-console")).toContainText("Error");
    await expect(page.getByTestId("node-send")).toHaveAttribute("data-status", "failed");
  });
});
