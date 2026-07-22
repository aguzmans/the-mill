import { test } from "@playwright/test";

// Hands-on exploration: drive the LIVE app, exercise features (run, CANCEL, editor, endpoints),
// screenshot each, and report console/page errors. Runs only when SHOTS is set.
const BASE = process.env.DEPLOYED_BASE;
const SHOTS = process.env.SHOTS;
test.skip(!BASE || !SHOTS, "set DEPLOYED_BASE + SHOTS to run the exploration");
test.setTimeout(180_000);

test("explore + exercise every feature", async ({ page }) => {
  const seen: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") seen.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => seen.push("PAGEERROR: " + e.message.slice(0, 160)));
  const shot = async (name: string) => { await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
  const note = (name: string, extra = "") => {
    const crash = seen.filter((s) => s.includes("Application Error") || s.startsWith("PAGEERROR"));
    console.log(`### ${name} ${extra} | crash:${crash.length ? " YES ⚠️" : " no"} | consoleErrs:${seen.length ? "\n   - " + [...new Set(seen)].slice(0, 5).join("\n   - ") : " none"}`);
    seen.length = 0;
  };
  const visit = async (path: string, name: string, waitFor?: string) => {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(900); await shot(name); note(name, path);
  };

  await visit("/workspace", "01-workspace", '[data-testid="brand"]');
  await visit("/fleet", "02-fleet", '[data-testid="fleet-page"]');
  await visit("/secrets", "03-secrets");
  await visit("/projects/acuity", "04-project-endpoints", '[data-testid="project-page"]');
  await visit("/projects/billing/workflows/invoices", "05-editor-vertical", '[data-testid="workflow-editor"]');
  await visit("/projects/billing/workflows/dunning", "06-editor-branch", '[data-testid="workflow-editor"]');

  // Run a workflow → success.
  await page.goto(`${BASE}/projects/billing/workflows/invoices`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="run-btn"]', { timeout: 8000 }).catch(() => {});
  await page.getByTestId("run-btn").click().catch(() => {});
  await page.waitForTimeout(4000); await shot("07-run-succeeded"); note("07-run-succeeded");

  // Run a SLOW workflow and CANCEL it (the new feature).
  await page.goto(`${BASE}/projects/billing/workflows/slow`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="run-btn"]', { timeout: 8000 }).catch(() => {});
  await page.getByTestId("run-btn").click().catch(() => {});
  await page.waitForTimeout(1200); await shot("08-running-with-cancel"); note("08-running-with-cancel");
  const cancelBtn = page.getByTestId("cancel-run-btn");
  console.log("   cancel button present:", await cancelBtn.count());
  await cancelBtn.click().catch(() => {});
  await page.waitForTimeout(6000); await shot("09-after-cancel"); note("09-after-cancel");

  await visit("/architecture", "10-architecture");
});
