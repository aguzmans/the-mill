import { test, expect } from "@playwright/test";

// End-to-end journeys against a REAL live backend (the api serves the SPA same-origin).
// Set DEPLOYED_BASE=http://localhost:8899 (or the compose api origin). These cover the exact
// hand-flows a developer uses — the paths that mock-mode specs structurally CANNOT catch:
//   • no demo/mock projects ever leak into a live deployment
//   • create a project on a fresh (possibly empty) repo
//   • create a workflow from scratch (New Workflow → seeded draft → Save → it appears)
//   • HTTP endpoints appear ONLY after a webhook trigger is configured
//   • the committed workflow triggers and runs
//   • delete workflow + project
// Every test uses a unique id so the suite is re-runnable against any stack (fresh or populated).
const BASE = process.env.DEPLOYED_BASE;
test.skip(!BASE, "set DEPLOYED_BASE to the live api origin (e.g. http://localhost:8899)");

const stamp = Date.now().toString(36);
const PID = `e2e-${stamp}`;
const WF = "acuity-webhook";

// Fail the whole journey on any console/page error — that's how we catch the silent
// "Cannot read properties of undefined" class of bug before a human does.
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => { throw new Error(`pageerror: ${e.message}`); });
});

test.describe.serial("live developer journey", () => {
  test("workspace never shows demo/mock projects (and empty state when empty)", async ({ page }) => {
    await page.goto(`${BASE}/workspace`);
    await expect(page.getByTestId("workspace-page")).toBeVisible();
    // The prototype's hand-authored demo catalogue must NEVER render in a live build. We assert
    // on its UNIQUE fixture strings (a real project can legitimately be named "billing", but its
    // description is the generic live one — these hand-authored blurbs only exist in mock.ts).
    await expect(page.locator("body")).not.toContainText("Revenue and invoicing workflows");
    await expect(page.locator("body")).not.toContainText("Lifecycle and analytics automations");
    // If this stack is empty, the empty-state (not demo cards) must be what's shown.
    const cards = await page.locator('[data-testid^="project-card-"]').count();
    if (cards === 0) await expect(page.getByTestId("workspace-empty")).toBeVisible();
  });

  test("create a project (works even on a brand-new/empty repo)", async ({ page }) => {
    await page.goto(`${BASE}/workspace`);
    await page.getByTestId("new-project").click();
    await expect(page.getByTestId("new-project-modal")).toBeVisible();
    await page.getByTestId("np-id").fill(PID);
    await page.getByTestId("new-project-submit").click();
    // The card appears once the controller has committed + reconciled it.
    await expect(page.getByTestId(`project-card-${PID}`)).toBeVisible({ timeout: 20000 });
  });

  test("a fresh project exposes NO HTTP endpoints", async ({ page }) => {
    await page.goto(`${BASE}/projects/${PID}`);
    await expect(page.getByTestId("project-page")).toBeVisible();
    await expect(page.getByTestId("endpoints-card")).toBeVisible();
    await expect(page.getByTestId("endpoints-none")).toBeVisible(); // "add a webhook trigger to expose one"
    await expect(page.getByTestId("endpoint-project")).toHaveCount(0);
  });

  test("New Workflow opens a real editable draft (not a dead-end)", async ({ page }) => {
    await page.goto(`${BASE}/projects/${PID}`);
    await page.getByTestId("new-workflow").click();
    await expect(page.getByTestId("new-workflow-modal")).toBeVisible();
    await page.getByTestId("np-wf-name").fill(WF);
    await page.getByTestId("np-wf-trigger").selectOption("webhook");
    await page.getByTestId("new-workflow-create").click();
    // We must land in the editor on a seeded draft — the old stub just closed the modal.
    await expect(page).toHaveURL(new RegExp(`/projects/${PID}/workflows/${WF}`));
    await expect(page.getByTestId("workflow-editor")).toBeVisible();
    await expect(page.getByTestId("triggers-panel")).toBeVisible();
    // seeded graph: start → step → end (3 nodes), no overlap crash
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
  });

  test("Save commits the new workflow and it appears in the project", async ({ page }) => {
    await page.goto(`${BASE}/projects/${PID}/workflows/${WF}?new=1&trigger=webhook`);
    await expect(page.getByTestId("workflow-editor")).toBeVisible();
    await page.getByTestId("save-btn").click();
    await page.getByTestId("commit-message").fill("create acuity-webhook");
    await page.getByTestId("commit-submit").click();
    // After a successful save the ?new flag is dropped (reload-safe committed workflow).
    await expect(page).toHaveURL(new RegExp(`/projects/${PID}/workflows/${WF}$`), { timeout: 20000 });

    // Back on the project page, the workflow is now listed…
    await page.goto(`${BASE}/projects/${PID}`);
    await expect(page.getByTestId(`workflow-row-${WF}`)).toBeVisible({ timeout: 20000 });
    // …and because it has a webhook trigger, the endpoint is now exposed.
    await expect(page.getByTestId("endpoints-none")).toHaveCount(0);
    await expect(page.getByTestId("endpoint-project")).toBeVisible();
  });

  test("the committed workflow triggers and runs to success", async ({ page }) => {
    await page.goto(`${BASE}/projects/${PID}/workflows/${WF}`);
    await expect(page.getByTestId("run-panel")).toBeVisible();
    await page.getByTestId("run-input").fill('{ "email": "e2e@mill.dev" }');
    await page.getByTestId("run-btn").click();
    const result = page.getByTestId("run-result");
    await expect(result).toBeVisible({ timeout: 30000 });
    await expect(result).toHaveAttribute("data-status", "succeeded", { timeout: 30000 });
  });

  test("Export from the editor downloads a runnable bundle (.tar.gz)", async ({ page }) => {
    await page.goto(`${BASE}/projects/${PID}/workflows/${WF}`);
    await expect(page.getByTestId("workflow-editor")).toBeVisible();
    // The button was a no-op stub; it must now trigger a real project-bundle download.
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20000 }),
      page.getByTestId("export-workflow-btn").click(),
    ]);
    expect(download.suggestedFilename()).toBe(`${PID}.tar.gz`);
  });

  test("delete the workflow, then the project (cleanup + delete flow)", async ({ page }) => {
    // delete workflow from the project page
    page.on("dialog", (d) => d.accept()); // confirm() guards the git-committing delete
    await page.goto(`${BASE}/projects/${PID}`);
    await page.getByTestId(`delete-workflow-${WF}`).click();
    await expect(page.getByTestId(`workflow-row-${WF}`)).toHaveCount(0, { timeout: 20000 });
    // delete the project from the workspace
    await page.goto(`${BASE}/workspace`);
    await page.getByTestId(`delete-project-${PID}`).click();
    await expect(page.getByTestId(`project-card-${PID}`)).toHaveCount(0, { timeout: 20000 });
  });
});
