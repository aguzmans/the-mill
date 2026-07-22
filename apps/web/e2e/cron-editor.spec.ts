import { test, expect } from "@playwright/test";

// Cron trigger editor: preview of upcoming runs + validation that forces a correct format and
// blocks Save on a bad schedule. Runs in mock mode (skipped when pointed at a live backend).
const OUT = process.env.SHOTS || "test-results";

test.describe("cron trigger editor", () => {
  test.skip(!!process.env.DEPLOYED_BASE, "mock-mode spec (uses prototype routes)");

  test("validates format, previews next runs, gates Save", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    await page.waitForSelector('[data-testid="triggers-panel"]', { timeout: 15000 });

    // Add a trigger and switch it to cron (use the last row so we don't depend on seed triggers).
    await page.getByTestId("add-trigger").click();
    const i = (await page.locator('[data-testid^="trigger-type-"]').count()) - 1;
    await page.getByTestId(`trigger-type-${i}`).selectOption("cron");
    const editor = page.getByTestId(`cron-editor-${i}`);
    const schedule = page.getByTestId(`trigger-schedule-${i}`);

    // 1) Invalid expression → inline error, no preview, Save disabled.
    await schedule.fill("not a cron");
    await expect(page.getByTestId(`cron-error-${i}`)).toBeVisible();
    await expect(page.getByTestId(`cron-preview-${i}`)).toHaveCount(0);
    await expect(page.getByTestId("save-btn")).toBeDisabled();
    await page.screenshot({ path: `${OUT}/cron-invalid.png`, fullPage: true });

    // 2) Out-of-range field is also rejected (forces a correct format).
    await schedule.fill("99 * * * *");
    await expect(page.getByTestId(`cron-error-${i}`)).toBeVisible();
    await expect(page.getByTestId("save-btn")).toBeDisabled();

    // 3) Valid via a preset → preview with exactly 5 upcoming runs, Save enabled.
    await editor.getByRole("button", { name: "Weekdays 9am" }).click();
    await expect(schedule).toHaveValue("0 9 * * 1-5");
    await expect(page.getByTestId(`cron-preview-${i}`)).toBeVisible();
    const rows = editor.locator(`[data-testid="cron-preview-${i}"] li`);
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText("UTC");
    await expect(page.getByTestId("save-btn")).toBeEnabled();

    // 4) Toggle to 10 upcoming runs.
    await page.getByTestId(`cron-toggle-${i}`).click();
    await expect(rows).toHaveCount(10);
    await page.screenshot({ path: `${OUT}/cron-valid.png`, fullPage: true });

    // 5) Typing a valid 6-field (seconds) expression by hand also validates.
    await schedule.fill("*/30 * * * * *");
    await expect(page.getByTestId(`cron-preview-${i}`)).toBeVisible();
    await expect(page.getByTestId("save-btn")).toBeEnabled();
  });
});
