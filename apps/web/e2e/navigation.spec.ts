import { test, expect } from "@playwright/test";

test.describe("navigation", () => {
  test("root redirects to the workspace and shows the brand + nav", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByTestId("brand")).toBeVisible();
    await expect(page.getByTestId("nav-workspace")).toBeVisible();
    await expect(page.getByTestId("nav-fleet")).toBeVisible();
    await expect(page.getByTestId("proto-badge")).toContainText("Prototype");
  });

  test("drills from workspace → project → workflow editor", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByTestId("project-card-billing").click();
    await expect(page).toHaveURL(/\/projects\/billing$/);
    await expect(page.getByTestId("project-page")).toBeVisible();

    await page.getByTestId("workflow-row-invoices").click();
    await expect(page).toHaveURL(/\/workflows\/invoices$/);
    await expect(page.getByTestId("workflow-editor")).toBeVisible();
  });

  test("navigates to the fleet page", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByTestId("nav-fleet").click();
    await expect(page).toHaveURL(/\/fleet$/);
    await expect(page.getByTestId("fleet-page")).toBeVisible();
  });
});
