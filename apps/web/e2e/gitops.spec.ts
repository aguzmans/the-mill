import { test, expect } from "@playwright/test";

test.describe("GitOps reconciliation", () => {
  test("Sync opens the reconcile drawer with diff, activity feed, and apply", async ({ page }) => {
    await page.goto("/projects/billing");
    await page.getByTestId("sync-btn").click();

    const drawer = page.getByTestId("reconcile-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Fetch / apply split");
    await expect(page.getByTestId("reconcile-diff")).toBeVisible();
    await expect(page.getByTestId("reconcile-feed")).toBeVisible();
    await expect(page.getByTestId("diff-row").first()).toBeVisible();

    await page.getByTestId("reconcile-apply").click();
    await expect(page.getByTestId("toast")).toContainText("Reconcile queued");
  });

  test("shows desired-vs-live, behind-by, and the bad-commit last-known-good banner", async ({ page }) => {
    await page.goto("/projects/billing");
    await expect(page.getByTestId("behind-by")).toContainText("behind");
    await expect(page.getByTestId("bad-commit-banner")).toContainText("last-known-good");
  });

  test("sync policy toggles are interactive", async ({ page }) => {
    await page.goto("/projects/billing");
    const t = page.getByTestId("policy-autosync");
    const before = await t.getAttribute("data-checked");
    await t.click();
    await expect(t).not.toHaveAttribute("data-checked", before ?? "true");
  });

  test("Export lists the standalone bundle contents", async ({ page }) => {
    await page.goto("/projects/billing");
    await page.getByTestId("export-btn").click();
    await expect(page.getByTestId("export-modal")).toBeVisible();
    await expect(page.getByTestId("export-bundle")).toContainText("index.js");
    await expect(page.getByTestId("export-bundle")).toContainText("run.sh");
  });
});
