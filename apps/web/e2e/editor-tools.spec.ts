import { test, expect } from "@playwright/test";

test.describe("editor tooling", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    await expect(page.getByTestId("workflow-editor")).toBeVisible();
  });

  test("a JS Code node opens the Monaco editor with a Save & Apply button", async ({ page }) => {
    await page.getByTestId("node-fetch").click();
    await expect(page.getByTestId("code-editor")).toBeVisible();
    await expect(page.getByTestId("code-editor")).toContainText("nodes/fetch.js");
    await expect(page.getByTestId("code-apply")).toBeVisible();
  });

  test("the if node is multi-conditional and can grow", async ({ page }) => {
    await page.getByTestId("node-gate").click();
    await expect(page.getByTestId("panel-if")).toBeVisible();
    // seeded with two clauses joined by OR
    await expect(page.getByTestId("if-preview")).toContainText("||");
    await expect(page.getByTestId("if-clause-1")).toBeVisible();
    // add a third clause
    await page.getByTestId("if-add-condition").click();
    await expect(page.getByTestId("if-clause-2")).toBeVisible();
  });

  test("clicking a palette tool adds a node to the canvas", async ({ page }) => {
    await expect(page.getByTestId("node-if-1")).toHaveCount(0);
    await page.getByTestId("palette-if").click();
    await expect(page.getByTestId("node-if-1")).toBeVisible();
  });
});
