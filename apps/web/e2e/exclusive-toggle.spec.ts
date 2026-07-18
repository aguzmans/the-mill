import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Proof the "Run exclusively" control is in the deployed editor (same-origin api UI).
const BASE = process.env.DEPLOYED_BASE;
test.skip(!BASE, "set DEPLOYED_BASE to the api origin");
const DIR = "/app/shots";
test.beforeAll(() => { try { mkdirSync(DIR, { recursive: true }); } catch {} });

test("editor exposes the exclusive-execution toggle", async ({ page }) => {
  await page.goto(`${BASE}/projects/demos/workflows/math`);
  const panel = page.getByTestId("triggers-panel");
  await expect(panel).toBeVisible();
  const toggle = page.getByTestId("exclusive-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText("Run exclusively");
  // it is interactive
  const box = page.getByTestId("exclusive-checkbox");
  await box.check();
  await expect(box).toBeChecked();
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: `${DIR}/exclusive-toggle.png` });
});
