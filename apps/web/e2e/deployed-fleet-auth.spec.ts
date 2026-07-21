import { test, expect } from "@playwright/test";

// Regression for the Fleet white-screen: when /api/* is locked (MILL_ADMIN_TOKEN) the browser
// gets 401s, and the fleet poll used to hand the page an `{error}` body with no `workers`
// array → `Cannot read properties of undefined (reading 'map')`. The API client now throws on
// non-2xx and the page renders a graceful error state instead of crashing.
// Runs against the LIVE bundle the api serves. Set DEPLOYED_BASE to the api origin.
const BASE = process.env.DEPLOYED_BASE;
test.skip(!BASE, "set DEPLOYED_BASE to the live api origin (e.g. http://api:8080)");

test("fleet page survives a 401 from /api/fleet (no crash, graceful state)", async ({ page }) => {
  // Force the exact production failure regardless of the backend's auth config.
  await page.route("**/api/fleet", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized (admin token required)" }) }),
  );
  // Any uncaught React/JS error (the old bug) fails the test.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/fleet`);

  // The shell still renders, an explicit error state shows, and the router error boundary does not.
  await expect(page.getByTestId("fleet-page")).toBeVisible();
  await expect(page.getByTestId("fleet-error")).toBeVisible();
  await expect(page.getByTestId("fleet-source")).toHaveText(/error/i);
  await expect(page.getByText("Unexpected Application Error")).toHaveCount(0);

  expect(pageErrors.join("\n")).not.toMatch(/reading 'map'|Cannot read properties/);
});

test("fleet page renders normally when /api/fleet is healthy (control)", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/fleet`);
  await expect(page.getByTestId("fleet-page")).toBeVisible();
  await expect(page.getByTestId("fleet-error")).toHaveCount(0); // no error banner on the happy path
  expect(pageErrors.join("\n")).toBe("");
});
