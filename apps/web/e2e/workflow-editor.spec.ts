import { test, expect } from "@playwright/test";

test.describe("workflow editor", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    await expect(page.getByTestId("workflow-editor")).toBeVisible();
  });

  test("renders the DAG with its nodes", async ({ page }) => {
    await expect(page.getByTestId("graph-canvas")).toBeVisible();
    await expect(page.getByTestId("node-fetch")).toBeVisible();
    await expect(page.getByTestId("node-transform")).toBeVisible();
    await expect(page.getByTestId("node-load")).toBeVisible();
  });

  test("selecting a node shows its code in the inspector", async ({ page }) => {
    await page.getByTestId("node-transform").click();
    const panel = page.getByTestId("node-panel");
    await expect(panel).toContainText("nodes/transform.js");
    await expect(panel.getByTestId("code-editor")).toBeVisible();
  });

  test("running the workflow streams logs and completes successfully", async ({ page }) => {
    await page.getByTestId("run-btn").click();

    // logs start streaming
    await expect(page.getByTestId("log-line").first()).toBeVisible();

    // final run result is success
    await expect(page.getByTestId("run-result")).toContainText("Succeeded", { timeout: 15_000 });

    // every node reports succeeded in the run panel
    for (const key of ["fetch", "transform", "load"]) {
      await expect(page.getByTestId(`node-status-${key}`)).toContainText("Succeeded");
    }
    // graph node reflects success too
    await expect(page.getByTestId("node-load")).toHaveAttribute("data-status", "succeeded");

    // a completion log line is present
    await expect(page.getByTestId("log-console")).toContainText("run complete");
  });

  test("Save opens the commit modal and commits back to git", async ({ page }) => {
    await page.getByTestId("save-btn").click();
    // Save = commit: review the draft diff, then commit
    await expect(page.getByTestId("commit-modal")).toBeVisible();
    await expect(page.getByTestId("commit-modal")).toContainText("workflow.yaml");
    await page.getByTestId("commit-submit").click();
    await expect(page.getByTestId("toast")).toContainText("Committed");
  });

  test("Export is available", async ({ page }) => {
    await expect(page.getByTestId("export-workflow-btn")).toBeVisible();
  });
});
