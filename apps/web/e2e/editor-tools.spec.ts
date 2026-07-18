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

  test("a JS Code node has a dependencies editor that adds and removes npm deps", async ({ page }) => {
    await page.getByTestId("node-transform").click();
    const deps = page.getByTestId("deps-editor");
    await expect(deps).toBeVisible();
    await page.getByTestId("dep-name").fill("nanoid");
    await page.getByTestId("dep-version").fill("^5.0.0");
    await page.getByTestId("dep-add").click();
    await expect(page.getByTestId("deps-list")).toContainText("nanoid@^5.0.0");
    // remove it again (deps-list may disappear if it was the only dep → assert on the panel)
    await page.getByTestId("dep-remove-nanoid").click();
    await expect(deps).not.toContainText("nanoid");
  });
});
