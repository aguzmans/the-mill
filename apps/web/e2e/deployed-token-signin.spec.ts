import { test, expect } from "@playwright/test";

// End-to-end for the UI admin-token flow (Option A): against a controller running with
// MILL_ADMIN_TOKEN, the Fleet page shows the unauthorized error until the operator pastes the
// token in the header control; after Save it attaches the bearer to every /api call and the
// fleet loads. Runs only when ADMIN_TOKEN matches the token the target api was booted with.
const BASE = process.env.DEPLOYED_BASE;
const ADMIN = process.env.ADMIN_TOKEN;
test.skip(!BASE || !ADMIN, "set DEPLOYED_BASE + ADMIN_TOKEN (api must run with MILL_ADMIN_TOKEN=ADMIN_TOKEN)");

test("paste the admin token → the fleet loads", async ({ page }) => {
  await page.goto(`${BASE}/fleet`);

  // Locked: the API 401s and the page shows the graceful error, not a crash.
  await expect(page.getByTestId("fleet-error")).toBeVisible();
  await expect(page.getByTestId("token-control")).toContainText(/sign in/i);

  // Sign in with the token.
  await page.getByTestId("token-control").click();
  await page.getByTestId("token-input").fill(ADMIN!);
  await page.getByTestId("token-save").click();

  // The bearer is now attached: the fleet loads, the error clears, the control shows signed-in.
  await expect(page.getByTestId("fleet-error")).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByTestId("fleet-source")).toHaveText(/live/i, { timeout: 10000 });
  await expect(page.getByTestId("token-control")).toContainText(/signed in/i);

  // Persists across a reload (localStorage), so the operator doesn't re-enter it every visit.
  await page.reload();
  await expect(page.getByTestId("fleet-error")).toHaveCount(0);
  await expect(page.getByTestId("token-control")).toContainText(/signed in/i);
});
