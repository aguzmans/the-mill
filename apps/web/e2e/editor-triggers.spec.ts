import { test, expect } from "@playwright/test";

// Editable triggers + exclusive execution + the resizable inspector divider.
// Runs in the default (mock) suite — billing/invoices ships with [cron, webhook, manual].
test.describe("editor — triggers, exclusivity, layout", () => {
  const rows = (page: import("@playwright/test").Page) =>
    page.locator('[data-testid="triggers-list"] > div[data-testid^="trigger-"]');

  test("triggers panel loads the workflow's triggers with type-specific fields", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    await expect(page.getByTestId("triggers-panel")).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    // row 0 = cron → schedule field prefilled; row 1 = webhook → path field + copy URL
    await expect(page.getByTestId("trigger-type-0")).toHaveValue("cron");
    await expect(page.getByTestId("trigger-schedule-0")).toHaveValue("0 2 * * *");
    await expect(page.getByTestId("trigger-type-1")).toHaveValue("webhook");
    await expect(page.getByTestId("copy-webhook").first()).toBeVisible();
  });

  test("changing a trigger's type swaps in the right field", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    // row 2 starts as manual (no schedule/path field)
    await expect(page.getByTestId("trigger-type-2")).toHaveValue("manual");
    await expect(page.getByTestId("trigger-schedule-2")).toHaveCount(0);
    // manual → cron reveals a schedule input we can type into
    await page.getByTestId("trigger-type-2").selectOption("cron");
    const sched = page.getByTestId("trigger-schedule-2");
    await expect(sched).toBeVisible();
    await sched.fill("*/30 * * * * *");
    await expect(sched).toHaveValue("*/30 * * * * *");
    // cron → webhook swaps the schedule field for a path field
    await page.getByTestId("trigger-type-2").selectOption("webhook");
    await expect(page.getByTestId("trigger-schedule-2")).toHaveCount(0);
    await expect(page.getByTestId("trigger-path-2")).toBeVisible();
  });

  test("add and remove triggers", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    await expect(rows(page)).toHaveCount(3);
    await page.getByTestId("add-trigger").click();
    await expect(rows(page)).toHaveCount(4);
    await page.getByTestId("trigger-remove-3").click();
    await expect(rows(page)).toHaveCount(3);
  });

  test("run input schema field is present and editable", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    const field = page.getByTestId("input-schema-field");
    await expect(field).toBeVisible();
    await expect(field).toContainText("Run input schema");
    const input = page.getByTestId("input-schema-input");
    await input.fill("typeof input.since === 'string'");
    await expect(input).toHaveValue("typeof input.since === 'string'");
  });

  test("exclusive-execution toggle is present and interactive", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    const toggle = page.getByTestId("exclusive-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText("Run exclusively");
    const box = page.getByTestId("exclusive-checkbox");
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(box).not.toBeChecked();
  });

  test("inspector divider is present and draggable", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    const split = page.getByTestId("editor-split");
    const gutter = page.getByTestId("split-gutter");
    await expect(split).toBeVisible();
    await expect(gutter).toBeVisible();
    // a drag should not throw and the gutter stays in the DOM
    const box = await gutter.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 80, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    }
    await expect(gutter).toBeVisible();
  });
});
