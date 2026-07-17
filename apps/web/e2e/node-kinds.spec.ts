import { test, expect } from "@playwright/test";

test.describe("typed flow components", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    await expect(page.getByTestId("workflow-editor")).toBeVisible();
  });

  test("renders start / if / callScript / end as distinct node kinds", async ({ page }) => {
    await expect(page.getByTestId("node-start")).toHaveAttribute("data-kind", "start");
    await expect(page.getByTestId("node-gate")).toHaveAttribute("data-kind", "if");
    await expect(page.getByTestId("node-notify")).toHaveAttribute("data-kind", "callScript");
    await expect(page.getByTestId("node-end")).toHaveAttribute("data-kind", "end");
    await expect(page.getByTestId("node-fetch")).toHaveAttribute("data-kind", "jscode");
  });

  test("the if node inspector shows a condition and true/false branches", async ({ page }) => {
    await page.getByTestId("node-gate").click();
    await expect(page.getByTestId("panel-if")).toBeVisible();
    await expect(page.getByTestId("if-condition")).toBeVisible();
    await expect(page.getByTestId("panel-if")).toContainText("then-branch");
  });

  test("the callScript inspector lets you target another script", async ({ page }) => {
    await page.getByTestId("node-notify").click();
    await expect(page.getByTestId("panel-callscript")).toBeVisible();
    await expect(page.getByTestId("call-target")).toBeVisible();
    await expect(page.getByTestId("panel-callscript")).toContainText("standalone");
  });

  test("start and end inspectors describe entry and exit", async ({ page }) => {
    await page.getByTestId("node-start").click();
    await expect(page.getByTestId("panel-start")).toContainText("entry point");
    await page.getByTestId("node-end").click();
    await expect(page.getByTestId("panel-end")).toContainText("exit clause");
  });

  test("the palette exposes all five draggable components", async ({ page }) => {
    await expect(page.getByTestId("palette")).toBeVisible();
    for (const kind of ["start", "jscode", "if", "callScript", "end"]) {
      await expect(page.getByTestId(`palette-${kind}`)).toHaveAttribute("draggable", "true");
    }
  });

  test("dragging a component from the palette adds a node to the canvas", async ({ page }) => {
    await expect(page.getByTestId("node-jscode-1")).toHaveCount(0);
    await page.getByTestId("palette-jscode").dragTo(page.getByTestId("graph-canvas"));
    await expect(page.getByTestId("node-jscode-1")).toBeVisible();
  });
});

test.describe("project internals", () => {
  test("workflow rows show a step-kind breakdown", async ({ page }) => {
    await page.goto("/projects/billing");
    await expect(page.getByTestId("steps-invoices")).toContainText("steps");
    await expect(page.getByTestId("steps-dunning")).toBeVisible();
  });
});
