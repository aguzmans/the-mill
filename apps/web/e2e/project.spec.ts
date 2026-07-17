import { test, expect } from "@playwright/test";

test.describe("project", () => {
  test("shows repo header, sync/export actions, and auto-sync state", async ({ page }) => {
    await page.goto("/projects/billing");
    const page_ = page.getByTestId("project-page");
    await expect(page_).toContainText("mill-billing.git");
    await expect(page.getByTestId("sync-btn")).toBeVisible();
    await expect(page.getByTestId("export-btn")).toBeVisible();
    await expect(page.getByTestId("autosync-state")).toContainText("Auto-sync");
  });

  test("lists workflows with status, badges, and triggers", async ({ page }) => {
    await page.goto("/projects/billing");
    const list = page.getByTestId("workflow-list");
    await expect(list).toBeVisible();

    const invoices = page.getByTestId("workflow-row-invoices");
    await expect(invoices).toBeVisible();
    await expect(invoices.getByTestId("sync-badge")).toBeVisible();
    await expect(invoices.getByTestId("health-badge")).toBeVisible();
    // a cron trigger is rendered
    await expect(invoices).toContainText("0 2 * * *");

    await expect(page.getByTestId("new-workflow")).toBeVisible();
  });
});
