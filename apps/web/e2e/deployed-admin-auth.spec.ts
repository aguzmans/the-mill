import { test, expect } from "@playwright/test";

// Guards the MILL_ADMIN_TOKEN behavior we enabled on staging: when the controller runs with an
// admin token, every /api/* needs the bearer EXCEPT /api/health and /api/metrics, and the /p
// webhook ingress is unaffected (it authenticates by capability path / ingress token, not the
// admin bearer). Runs only when ADMIN_TOKEN is set to the token the target api was booted with.
const BASE = process.env.DEPLOYED_BASE;
const ADMIN = process.env.ADMIN_TOKEN;
test.skip(!BASE || !ADMIN, "set DEPLOYED_BASE + ADMIN_TOKEN (api must run with MILL_ADMIN_TOKEN=ADMIN_TOKEN)");

const auth = { Authorization: `Bearer ${ADMIN}` };

test.describe("admin-token API guard (live)", () => {
  test("unauthenticated /api/* is 401", async ({ request }) => {
    expect((await request.get(`${BASE}/api/projects`)).status()).toBe(401);
    expect((await request.get(`${BASE}/api/secrets`)).status()).toBe(401);
    expect((await request.put(`${BASE}/api/secrets/E2E_GUARD`, { data: { value: "x" } })).status()).toBe(401);
  });

  test("the correct bearer is accepted", async ({ request }) => {
    const r = await request.get(`${BASE}/api/projects`, { headers: auth });
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(await r.json())).toBeTruthy();
  });

  test("a wrong bearer is still 401", async ({ request }) => {
    expect((await request.get(`${BASE}/api/projects`, { headers: { Authorization: "Bearer nope" } })).status()).toBe(401);
  });

  test("infra endpoints stay open for probes/scrape", async ({ request }) => {
    expect((await request.get(`${BASE}/api/health`)).status()).toBe(200);
    expect((await request.get(`${BASE}/api/metrics`)).status()).toBe(200);
  });

  test("the /p webhook ingress is NOT behind the admin guard (404, not 401)", async ({ request }) => {
    // An unknown ingress path must fall through to the ingress router (404), proving the admin
    // middleware didn't intercept it — a header-less provider like Acuity can still reach us.
    expect((await request.get(`${BASE}/p/definitely-not-a-real-endpoint`)).status()).toBe(404);
  });
});
