// Drive the LIVE demos project end-to-end in a real browser: the project page must load
// (regression: live-only projects used to 404 "Project not found"), every workflow must
// open in the editor with its graph, and the runnable ones must succeed with live logs.
import { chromium } from "@playwright/test";
const BASE = process.env.LIVE_BASE || "http://api:8080";
const browser = await chromium.launch();
const page = await browser.newPage();
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); if (!ok) failures++; };

try {
  // ── 1. Project page loads (not "Project not found") ────────────────────────────
  await page.goto(`${BASE}/projects/demos`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500); // let /api/status resolve
  const body = (await page.locator("body").textContent()) ?? "";
  check("demos project page loads (no 'Project not found')", !body.includes("Project not found"));
  check("header shows the project name 'Demos'", body.includes("Demos"));
  check("header shows the live badge", (await page.getByText("live", { exact: true }).count()) > 0);

  // ── 2. All three workflows are listed as rows ──────────────────────────────────
  for (const wf of ["math", "scrape-novi", "site-check"]) {
    const row = await page.getByTestId(`workflow-row-${wf}`).count();
    check(`workflow row present: ${wf}`, row > 0);
  }

  // ── 2b. Regression: clicking a row must open its editor (rows used to be dead) ──
  await page.getByTestId("workflow-row-math").click();
  await page.getByTestId("workflow-editor").waitFor({ timeout: 15000 });
  check("clicking a workflow row navigates to its editor", page.url().includes("/workflows/math"));

  // ── 3. Each workflow opens in the editor with a rendered graph ──────────────────
  for (const wf of ["math", "scrape-novi", "site-check"]) {
    await page.goto(`${BASE}/projects/demos/workflows/${wf}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow-editor").waitFor({ timeout: 15000 });
    const nodes = await page.locator('[data-testid^="node-"]').count();
    check(`editor opens with a graph: ${wf}`, nodes > 0, `${nodes} node(s)`);
  }

  // ── 4. Run the runnable ones and assert success ────────────────────────────────
  for (const [wf, needle] of [["math", "Succeeded"], ["scrape-novi", "NOVI Health"], ["site-check", "Succeeded"]]) {
    await page.goto(`${BASE}/projects/demos/workflows/${wf}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("run-btn").waitFor({ timeout: 15000 });
    await page.getByTestId("run-btn").click();
    await page.getByTestId("run-result").waitFor({ timeout: 30000 });
    const result = (await page.getByTestId("run-result").textContent()) ?? "";
    const logs = (await page.getByTestId("log-console").textContent()) ?? "";
    check(`run ${wf} → Succeeded`, result.includes("Succeeded"));
    if (needle !== "Succeeded") check(`run ${wf} → produced expected output`, logs.includes(needle) || result.includes(needle), needle);
  }
} catch (e) {
  console.error("ERROR:", e.message);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nLIVE DEMOS E2E OK ✅");
process.exit(failures ? 1 : 0);
