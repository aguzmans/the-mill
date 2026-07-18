import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Proof against the REAL deployed UI: the api serves the live SPA at its own origin
// (http://api:8080 inside the compose network == http://localhost:8787 on the host),
// so /api is same-origin and live data loads with no CORS grant.
const BASE = process.env.DEPLOYED_BASE; // e.g. http://api:8080
test.skip(!BASE, "set DEPLOYED_BASE to the api origin");
const DIR = "/app/shots";
test.beforeAll(() => { try { mkdirSync(DIR, { recursive: true }); } catch {} });

test("deployed /fleet renders the dynamic isolation ladder", async ({ page }) => {
  await page.goto(`${BASE}/fleet`);
  await expect(page.getByTestId("isolation-ladder")).toBeVisible();
  // live source + the live executor chip pulled from /api/fleet
  await expect(page.getByTestId("fleet-source")).toContainText("live");
  await expect(page.getByTestId("ladder-active-executor")).toBeVisible();
  // the EKS default rung (hardened worker pod, in-process) is the live one…
  await expect(page.getByTestId("ladder-live-pod")).toBeVisible();
  await expect(page.getByTestId("ladder-pod")).toHaveAttribute("data-live", "true");
  // …and dev / local-docker / roadmap tiers are NOT live (no worker runs them)
  await expect(page.getByTestId("ladder-live-dev")).toHaveCount(0);
  await expect(page.getByTestId("ladder-live-container")).toHaveCount(0);
  await expect(page.getByTestId("ladder-live-firecracker")).toHaveCount(0);
  await expect(page.getByTestId("ladder-live-k8sjob")).toHaveCount(0);
  // and NsjailProcessExecutor is gone from the ladder entirely
  await expect(page.getByTestId("isolation-ladder")).not.toContainText("NsjailProcessExecutor");
  await page.getByTestId("isolation-ladder").screenshot({ path: `${DIR}/deployed-ladder.png` });
});
