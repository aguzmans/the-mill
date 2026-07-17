import { test, expect } from "@playwright/test";

test.describe("workspace (projects)", () => {
  test("lists project cards with sync + health badges", async ({ page }) => {
    await page.goto("/workspace");
    const grid = page.getByTestId("project-grid");
    await expect(grid).toBeVisible();
    await expect(page.getByTestId("project-card-billing")).toBeVisible();
    await expect(page.getByTestId("project-card-growth")).toBeVisible();

    const billing = page.getByTestId("project-card-billing");
    await expect(billing.getByTestId("sync-badge")).toBeVisible();
    await expect(billing.getByTestId("health-badge")).toBeVisible();
  });

  test("shows the root config repo and a New Project action", async ({ page }) => {
    await page.goto("/workspace");
    await expect(page.getByTestId("workspace-page")).toContainText("mill-config.git");
    await expect(page.getByTestId("new-project")).toBeVisible();
  });
});
