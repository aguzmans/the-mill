// Comprehensive click-ops session: exercises every feature built this session against the
// live stack, reporting pass/fail per feature. Resilient — one failure never aborts the rest.
import { chromium, expect } from "@playwright/test";
const BASE = process.env.LIVE_BASE || "http://api:8080";
const browser = await chromium.launch();
const ctx = await browser.newContext();
const findings = [];
const section = async (name, fn) => {
  const p = await ctx.newPage();
  try { await fn(p); console.log(`✓ ${name}`); }
  catch (e) { console.log(`✗ ${name} — ${e.message.split("\n")[0]}`); findings.push({ name, error: e.message.split("\n")[0] }); }
  finally { await p.close(); }
};
const openEditor = async (p, proj, wf) => { await p.goto(`${BASE}/projects/${proj}/workflows/${wf}`, { waitUntil: "domcontentloaded" }); await p.getByTestId("workflow-editor").waitFor({ timeout: 15000 }); };

// 1. Loop node
await section("Loop node (fanout): palette + node + inspector", async (p) => {
  await openEditor(p, "demos", "fanout");
  await expect(p.getByTestId("palette-loop")).toBeVisible();
  await expect(p.getByTestId("node-each")).toHaveAttribute("data-kind", "loop");
  await p.getByTestId("node-each").click();
  await expect(p.getByTestId("panel-loop")).toBeVisible();
  await expect(p.getByTestId("loop-each")).toHaveValue(/input\.urls/);
});

// 2. Resizable divider
await section("Resizable editor divider", async (p) => {
  await openEditor(p, "demos", "math");
  const g = p.getByTestId("split-gutter"); await g.waitFor();
  const left = p.getByTestId("editor-split").locator("> div").first();
  const before = await left.evaluate((el) => el.style.flexBasis);
  const box = await g.boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down();
  await p.mouse.move(box.x - 160, box.y + box.height / 2, { steps: 6 }); await p.mouse.up();
  const after = await left.evaluate((el) => el.style.flexBasis);
  if (before === after) throw new Error("divider did not resize");
});

// 3. Fleet real data
await section("Fleet page live data", async (p) => {
  await p.goto(`${BASE}/fleet`, { waitUntil: "domcontentloaded" });
  await p.getByTestId("fleet-page").waitFor({ timeout: 15000 });
  await expect(p.getByTestId("fleet-source")).toHaveText("live", { timeout: 10000 });
  if ((await p.getByTestId(/^worker-/).count()) < 1) throw new Error("no worker rows");
});

// 4. Test-step
await section("Test-step runner (loop body)", async (p) => {
  await openEditor(p, "pipelines", "map-numbers");
  await p.getByTestId("node-each").click();
  await p.getByTestId("step-input").fill('{"nums":[3,4]}');
  await p.getByTestId("step-run").click();
  await p.getByTestId("step-result").waitFor({ timeout: 15000 });
  await expect(p.getByTestId("step-result")).toHaveAttribute("data-status", "succeeded");
  await expect(p.getByTestId("step-output")).toContainText('"sq": 9');
});

// 5. Schema enforcement via test-step
await section("Schema enforcement (bad input fails)", async (p) => {
  await openEditor(p, "pipelines", "validated");
  await p.getByTestId("node-count").click();
  await p.getByTestId("step-input").fill('{"items":"nope"}');
  await p.getByTestId("step-run").click();
  await p.getByTestId("step-result").waitFor({ timeout: 15000 });
  await expect(p.getByTestId("step-result")).toHaveAttribute("data-status", "failed");
  await expect(p.getByTestId("step-result")).toContainText(/schema violation/);
});

// 6. Deps editor
await section("Dependencies editor (add/remove)", async (p) => {
  await openEditor(p, "deps-demo", "enrich");
  await p.getByTestId("node-each").click();
  await expect(p.getByTestId("deps-list")).toContainText("ms@");
  await p.getByTestId("dep-name").fill("lodash"); await p.getByTestId("dep-version").fill("^4.0.0"); await p.getByTestId("dep-add").click();
  await expect(p.getByTestId("deps-list")).toContainText("lodash@^4.0.0");
  await p.getByTestId("dep-remove-lodash").click();
  await expect(p.getByTestId("deps-list")).not.toContainText("lodash");
});

// 7. Run history + timeline + retry
await section("Run history + timeline + Re-run", async (p) => {
  await openEditor(p, "pipelines", "map-objects");
  await p.getByTestId("run-btn").click();
  await p.getByTestId("run-result").waitFor({ timeout: 30000 });
  const rows = p.getByTestId("run-history").locator('[data-testid^="run-row-"]');
  await expect(rows.first()).toBeVisible({ timeout: 12000 });
  const before = await rows.count();
  await rows.first().click();
  await expect(p.getByTestId("run-detail")).toContainText("each", { timeout: 8000 }); // timeline span
  await p.getByTestId("rerun-btn").click();
  await expect.poll(async () => rows.count(), { timeout: 12000 }).toBeGreaterThan(before);
});

// 8. GitOps drawer: reconcile feed + diff
await section("GitOps drawer: reconcile feed", async (p) => {
  await p.goto(`${BASE}/projects/pipelines`, { waitUntil: "domcontentloaded" });
  await p.getByTestId("project-page").waitFor({ timeout: 15000 });
  await p.getByTestId("gitops-btn").click();
  await p.getByTestId("reconcile-feed").waitFor({ timeout: 8000 });
  await expect(p.getByTestId("reconcile-feed")).not.toContainText("No reconcile activity");
});

// 9. Ingress endpoints card
await section("Ingress endpoints card + copy", async (p) => {
  await p.goto(`${BASE}/projects/demos`, { waitUntil: "domcontentloaded" });
  await p.getByTestId("project-page").waitFor({ timeout: 15000 });
  await p.getByTestId("endpoints-card").waitFor({ timeout: 10000 });
  await expect(p.getByTestId("endpoints-card")).toContainText("/p/w/math/demos");
  await expect(p.getByTestId("copy-endpoint-math")).toBeVisible();
});

// 10. Call Script target picker (the reported bug)
await section("Call Script picker lists in-project workflows", async (p) => {
  await openEditor(p, "pipelines", "usesub");
  await p.getByTestId("node-call").click();
  await p.getByTestId("panel-callscript").waitFor({ timeout: 8000 });
  const opts = await p.getByTestId("call-target").locator("option").allInnerTexts();
  const inProject = opts.filter((o) => !/standalone|remote|select a workflow/i.test(o));
  if (inProject.length === 0) throw new Error("no in-project workflows listed (only standalone)");
});

// 11. Delete buttons present (don't click — destructive)
await section("Delete affordances present", async (p) => {
  await p.goto(`${BASE}/projects/demos`, { waitUntil: "domcontentloaded" });
  await p.getByTestId("project-page").waitFor({ timeout: 15000 });
  if ((await p.getByTestId("delete-workflow-math").count()) < 1) throw new Error("no workflow delete button");
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await p.getByTestId("workspace-page").waitFor({ timeout: 15000 });
  if ((await p.getByTestId("delete-project-demos").count()) < 1) throw new Error("no project delete button");
});

// 12. New Project (create + cleanup)
await section("New Project create → appears → delete", async (p) => {
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await p.getByTestId("workspace-page").waitFor({ timeout: 15000 });
  await p.getByTestId("new-project").click();
  await p.getByTestId("np-id").fill("clicktest");
  await p.getByTestId("new-project-submit").click();
  await expect(p.getByTestId("project-card-clicktest")).toBeVisible({ timeout: 15000 });
  // cleanup via API
  await p.request.delete(`${BASE}/api/projects/clicktest`);
});

console.log(`\n${findings.length ? findings.length + " FINDING(S):" : "ALL CLICK-OPS PASSED ✅"}`);
for (const f of findings) console.log(`  - ${f.name}: ${f.error}`);
await browser.close();
process.exit(findings.length ? 1 : 0);
