import { test, expect } from "@playwright/test";

// End-to-end checks for the three features added this session, against the REAL backend
// (the api serves the live SPA same-origin). Set DEPLOYED_BASE=http://api:8080 on the compose net.
//   1. Editor canvas no longer hijacks page scroll (wheel doesn't zoom the graph).
//   2. SQL node parses Windmill magic comments (-- $1 name) into params on paste.
//   3. "Import from Windmill" button works — into an existing project AND as a new project.
const BASE = process.env.DEPLOYED_BASE;
test.skip(!BASE, "set DEPLOYED_BASE to the api origin");

// A tiny self-contained Windmill OpenFlow (a JS step feeding a Postgres step with magic comments).
const FLOW = JSON.stringify({
  summary: "e2e import",
  value: {
    modules: [
      { id: "fetch", value: { type: "rawscript", language: "bun", content: "export async function main() { return [{ id: 1 }]; }" } },
      { id: "write", value: { type: "rawscript", language: "postgresql",
        content: "-- database f/database/postgresql\n-- return_last_result\n-- $1 rows\nSELECT count(*) FROM jsonb_to_recordset($1::text::jsonb) AS x(id int);",
        input_transforms: { rows: { type: "javascript", expr: "results.fetch" } } } },
    ],
  },
});

// Unique per run so the spec is re-runnable against the same (persistent) backend.
const RUN = `${Date.now().toString(36)}`;

const scaleOf = async (page: import("@playwright/test").Page) =>
  page.locator(".react-flow__viewport").first().evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el as HTMLElement).transform);
    return m.a; // horizontal scale = zoom factor
  });

test.describe("session features (live backend)", () => {
  test("1. canvas wheel does NOT zoom the graph (page-scroll fix)", async ({ page }) => {
    await page.goto(`${BASE}/projects/demos/workflows/math`);
    await expect(page.locator(".react-flow__viewport").first()).toBeVisible();
    const before = await scaleOf(page);
    // Hover the canvas and wheel down — pre-fix this zoomed the diagram out.
    const pane = page.locator(".react-flow__pane").first();
    const box = await pane.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300);
    const after = await scaleOf(page);
    expect(after).toBeCloseTo(before, 5); // zoom unchanged → wheel no longer captured
  });

  test("2. SQL node fills params from Windmill magic comments", async ({ page }) => {
    await page.goto(`${BASE}/projects/demos/workflows/math`);
    await page.getByTestId("palette-sql").click();          // adds + selects a SQL node
    await expect(page.getByTestId("sql-panel")).toBeVisible();
    await page.getByTestId("sql-query").fill(
      "-- database f/database/postgresql\n-- $1 orgId\n-- $2 since\nselect * from events where org = $1 and ts > $2",
    );
    const hint = page.getByTestId("wm-sql-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("$1→orgId");
    await expect(hint).toContainText("f/database/postgresql");
    await page.getByTestId("wm-sql-fill").click();
    await expect(page.getByTestId("sql-param-0")).toHaveValue("input.orgId");
    await expect(page.getByTestId("sql-param-1")).toHaveValue("input.since");
  });

  test("3a. Import a Windmill flow INTO an existing project", async ({ page }) => {
    await page.goto(`${BASE}/projects/pipelines`);
    await page.getByTestId("import-flow-open").click();
    await expect(page.getByTestId("import-flow")).toBeVisible();
    const wf = `e2e-existing-${RUN}`;
    await page.getByTestId("import-flow-content").fill(FLOW);
    await page.getByTestId("import-flow-name").fill(wf);
    await page.getByTestId("import-flow-submit").click();
    const report = page.getByTestId("import-flow-report");
    await expect(report).toBeVisible({ timeout: 20000 });
    await expect(report).toContainText(wf);
    await expect(report).toContainText("2/2 steps converted");
    await page.getByTestId("import-flow-close").click();
    // the imported workflow shows up in the project's workflow list
    await expect(page.getByText(wf, { exact: false }).first()).toBeVisible({ timeout: 15000 });
  });

  test("3c. Import via FILE UPLOAD (not paste)", async ({ page }) => {
    await page.goto(`${BASE}/projects/pipelines`);
    await page.getByTestId("import-flow-open").click();
    const wf = `e2e-upload-${RUN}`;
    await page.getByTestId("import-flow-file").setInputFiles({ name: `${wf}.flow.json`, mimeType: "application/json", buffer: Buffer.from(FLOW) });
    await page.getByTestId("import-flow-submit").click();
    const report = page.getByTestId("import-flow-report");
    await expect(report).toBeVisible({ timeout: 20000 });
    await expect(report).toContainText(wf); // name derived from the uploaded file
  });

  test("3d. A flow with a missing callScript is BLOCKED, then imports with 'Import anyway'", async ({ page }) => {
    const blocked = JSON.stringify({ value: { modules: [
      { id: "call", value: { type: "script", path: "f/x/missing_target", input_transforms: {} } },
    ] } });
    await page.goto(`${BASE}/projects/pipelines`);
    await page.getByTestId("import-flow-open").click();
    await page.getByTestId("import-flow-content").fill(blocked);
    await page.getByTestId("import-flow-name").fill(`e2e-blocked-${RUN}`);
    await page.getByTestId("import-flow-submit").click();
    // blocked view lists the missing target
    const blockView = page.getByTestId("import-flow-blocked");
    await expect(blockView).toBeVisible({ timeout: 20000 });
    await expect(blockView).toContainText("missing_target");
    // force through
    await page.getByTestId("import-flow-force").click();
    await expect(page.getByTestId("import-flow-report")).toBeVisible({ timeout: 20000 });
  });

  test("3b. Import a Windmill flow AS A NEW project", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.getByTestId("import-flow-open").click();
    await expect(page.getByTestId("import-flow")).toBeVisible();
    await page.getByTestId("import-flow-pid").fill(`e2e-proj-${RUN}`);
    await page.getByTestId("import-flow-content").fill(FLOW);
    await page.getByTestId("import-flow-name").fill("main");
    await page.getByTestId("import-flow-submit").click();
    const report = page.getByTestId("import-flow-report");
    await expect(report).toBeVisible({ timeout: 20000 });
    await expect(report).toContainText("created the project");
  });
});
