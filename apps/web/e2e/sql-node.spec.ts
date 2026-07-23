import { test, expect } from "@playwright/test";

// The visual SQL tool: drop a SQL node from the palette, configure connection/query/params and
// single-vs-each mode in the inspector, and see it render on the canvas. Mock-mode (no backend).
const OUT = process.env.SHOTS || "test-results";

test.describe("SQL node editor", () => {
  test.skip(!!process.env.DEPLOYED_BASE, "mock-mode spec");

  test("add a SQL node, configure it, render on canvas", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    await page.waitForSelector('[data-testid="workflow-editor"]', { timeout: 15000 });

    // palette → add a SQL node
    await page.getByTestId("palette-sql").click();
    const sqlNode = page.locator('[data-kind="sql"]').first();
    await expect(sqlNode).toBeVisible();

    // select it → the SQL inspector opens
    await sqlNode.click();
    await expect(page.getByTestId("sql-panel")).toBeVisible();

    // configure connection + query
    await page.getByTestId("sql-connection").fill("REPORTING_DB");
    await page.getByTestId("sql-query").fill("select id, name from orgs where id = any($1)");

    // default single mode → one param
    await expect(page.getByTestId("sql-param-0")).toBeVisible();
    await page.getByTestId("sql-param-0").fill("input.ids");
    await page.screenshot({ path: `${OUT}/sql-single.png`, fullPage: true });

    // switch to per-item mode → each + transaction appear
    await page.getByTestId("sql-mode").selectOption("each");
    await expect(page.getByTestId("sql-each")).toBeVisible();
    await page.getByTestId("sql-each").fill("input.rows");
    await page.getByTestId("sql-transaction").check();
    await expect(page.getByTestId("sql-transaction")).toBeChecked();

    // add a second param
    await page.getByTestId("sql-param-add").click();
    await page.getByTestId("sql-param-1").fill("item.name");
    await expect(page.getByTestId("sql-param-1")).toHaveValue("item.name");

    // whole-item passthrough toggle swaps the param list for a single paramsFrom expr
    await page.getByTestId("sql-usepf").check();
    await expect(page.getByTestId("sql-paramsfrom")).toBeVisible();
    await expect(page.getByTestId("sql-params")).toHaveCount(0);

    // canvas node reflects the query snippet + each/tx summary
    await expect(sqlNode).toContainText("select id, name from orgs");
    await page.screenshot({ path: `${OUT}/sql-each.png`, fullPage: true });
  });
});
