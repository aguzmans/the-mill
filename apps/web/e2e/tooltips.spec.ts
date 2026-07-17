import { test, expect } from "@playwright/test";

// Every page carries small `(i)` explanations and button tooltips — verify they reveal.
test.describe("info tooltips", () => {
  test("an (i) info icon reveals an explanation on hover", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByTestId("infotip").first().hover();
    await expect(page.getByRole("tooltip").first()).toBeVisible();
    await expect(page.getByRole("tooltip").first()).not.toBeEmpty();
  });

  test("a primary button explains itself on hover", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    await page.getByTestId("run-btn").hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "isolated workers" }).first()).toBeVisible();
  });

  test("badges explain their meaning", async ({ page }) => {
    await page.goto("/projects/billing");
    await page.getByTestId("sync-badge").first().hover();
    await expect(page.getByRole("tooltip").first()).toBeVisible();
  });
});
