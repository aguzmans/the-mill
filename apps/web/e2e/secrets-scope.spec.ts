import { test, expect } from "@playwright/test";

// Scoped secrets, end-to-end against a real controller: the same name set at global / project /
// workflow scope stays isolated per scope. Runs only when pointed at a live backend.
const BASE = process.env.DEPLOYED_BASE;
const OUT = process.env.SHOTS || "test-results";
test.skip(!BASE, "set DEPLOYED_BASE to a live controller");

async function rowVisible(page: import("@playwright/test").Page, name: string) {
  return page.getByTestId(`secret-row-${name}`).isVisible().catch(() => false);
}

test("secrets are isolated per scope (global / project / workflow)", async ({ page }) => {
  await page.goto(`${BASE}/secrets`);
  await page.waitForSelector('[data-testid="scope-selector"]', { timeout: 15000 });

  // ── Global scope: set a global-only secret ──
  await page.getByTestId("scope-global").click();
  await page.getByTestId("secret-name").fill("GLOBAL_ONLY");
  await page.getByTestId("secret-value").fill("g-val");
  await page.getByTestId("secret-save").click();
  await expect(page.getByTestId("secret-row-GLOBAL_ONLY")).toBeVisible();
  await page.screenshot({ path: `${OUT}/secrets-global.png`, fullPage: true });

  // ── Project scope (billing): set API_KEY there ──
  await page.getByTestId("scope-project").click();            // the scope pill
  await page.getByTestId("scope-project-select").selectOption("billing");
  await page.getByTestId("secret-name").fill("API_KEY");
  await page.getByTestId("secret-value").fill("billing-val");
  await page.getByTestId("secret-save").click();
  await expect(page.getByTestId("secret-row-API_KEY")).toBeVisible();
  // the global-only secret must NOT show in project scope
  expect(await rowVisible(page, "GLOBAL_ONLY")).toBe(false);
  await page.screenshot({ path: `${OUT}/secrets-project.png`, fullPage: true });

  // ── Back to Global: API_KEY must NOT be here (isolation) ──
  await page.getByTestId("scope-global").click();
  await expect(page.getByTestId("secret-row-GLOBAL_ONLY")).toBeVisible();
  expect(await rowVisible(page, "API_KEY")).toBe(false);

  // ── Workflow scope (billing/invoices): its own API_KEY ──
  await page.getByTestId("scope-workflow").click();
  await page.getByTestId("scope-project-select").selectOption("billing");
  await page.getByTestId("scope-workflow-select").selectOption("invoices");
  expect(await rowVisible(page, "API_KEY")).toBe(false); // nothing here yet
  await page.getByTestId("secret-name").fill("API_KEY");
  await page.getByTestId("secret-value").fill("invoices-val");
  await page.getByTestId("secret-save").click();
  await expect(page.getByTestId("secret-row-API_KEY")).toBeVisible();
  await page.screenshot({ path: `${OUT}/secrets-workflow.png`, fullPage: true });

  // ── Effective view: API_KEY resolves from the workflow, overriding the project value ──
  await expect(page.getByTestId("effective-panel")).toBeVisible();
  await expect(page.getByTestId("effective-source-API_KEY")).toHaveText("workflow");
  await expect(page.getByTestId("effective-row-API_KEY")).toContainText("overrides");
  // invoices' `load` node declares WAREHOUSE_DSN which is set in no scope → flagged as missing
  await expect(page.getByTestId("effective-missing-WAREHOUSE_DSN")).toBeVisible();
  await page.screenshot({ path: `${OUT}/secrets-effective.png`, fullPage: true });

  // project billing still has its own API_KEY, independent of the workflow one
  await page.getByTestId("scope-project").click();
  await page.getByTestId("scope-project-select").selectOption("billing");
  await expect(page.getByTestId("secret-row-API_KEY")).toBeVisible();
});
