import { test, expect } from "@playwright/test";

// Secrets store + capability-URL auth against a REAL backend. These prove the Acuity path:
// a header-less provider reaches an unguessable webhook URL, and the workflow reads a secret
// from ctx.secrets. Set DEPLOYED_BASE=http://localhost:8899.
const BASE = process.env.DEPLOYED_BASE;
test.skip(!BASE, "set DEPLOYED_BASE to the live api origin");

const stamp = Date.now().toString(36);
const PID = `sec-${stamp}`;
const WF = "capcheck";
const SECRET = `E2E_SECRET_${stamp.toUpperCase()}`;
const CAP = `${stamp}${"a1b2c3d4e5f6a7b8c9d0e1f2".slice(0, 32)}`; // >=24 chars → capability path

// Clean up the project this suite creates, even on mid-suite failure — no leaked `sec-*` projects.
test.afterAll(async () => { await fetch(`${BASE}/api/projects/${PID}`, { method: "DELETE" }).catch(() => {}); });

test.describe.serial("secrets store + capability-URL auth (live)", () => {
  test("a secret can be set and listed (masked — value never returned)", async ({ request }) => {
    const put = await request.put(`${BASE}/api/secrets/${SECRET}`, { data: { value: "s3cr3t-value" } });
    expect(put.ok()).toBeTruthy();
    const list = await (await request.get(`${BASE}/api/secrets`)).json();
    expect(list.names).toContain(SECRET);
    expect(JSON.stringify(list)).not.toContain("s3cr3t-value"); // values are never exposed
  });

  test("invalid secret name is rejected", async ({ request }) => {
    const r = await request.put(`${BASE}/api/secrets/bad-name!`, { data: { value: "x" } });
    expect(r.status()).toBe(400);
  });

  test("a webhook with a long capability path authenticates by the path — no bearer needed", async ({ request }) => {
    await request.post(`${BASE}/api/projects`, { data: { id: PID } });
    const save = await request.post(`${BASE}/api/projects/${PID}/workflows/${WF}`, {
      data: {
        message: "e2e capcheck",
        workflow: {
          apiVersion: "mill/v1", kind: "Workflow", metadata: { name: WF },
          triggers: [{ type: "webhook", path: CAP }],
          nodes: [
            { key: "start", kind: "start", name: "Start" },
            { key: "check", kind: "jscode", name: "Check", file: "nodes/check.js", secrets: [SECRET] },
            { key: "end", kind: "end", name: "End" },
          ],
          edges: [{ from: "start", to: "check" }, { from: "check", to: "end" }],
        },
        files: { "nodes/check.js": `export default async (input, ctx) => ({ gotSecret: ctx.secrets.${SECRET} === 's3cr3t-value', hadAuth: !!(ctx.request && ctx.request.headers && ctx.request.headers.authorization) })` },
      },
    });
    expect(save.ok()).toBeTruthy();

    // Acuity-style: form POST, NO Authorization header, to the capability URL.
    const r = await request.post(`${BASE}/p/w/${WF}/${CAP}?wait=1`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: "action=appointment.scheduled&id=1",
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.status).toBe("succeeded");
    expect(body.result.hadAuth).toBe(false);   // provider sent no auth header…
    expect(body.result.gotSecret).toBe(true);  // …yet the declared secret was injected
  });

  test("the DEFAULT (project-id) path still requires the bearer", async ({ request }) => {
    const r = await request.post(`${BASE}/p/w/${WF}/${PID}`, {
      headers: { "content-type": "application/x-www-form-urlencoded" }, data: "x=1",
    });
    expect([401, 503]).toContain(r.status()); // 401 (token set) or 503 (ingress disabled) — never 200
  });

  test("a wrong path is 404 (capability tokens are unguessable)", async ({ request }) => {
    const r = await request.post(`${BASE}/p/w/${WF}/not-the-token`, { data: "x=1" });
    expect(r.status()).toBe(404);
  });

  test("the Secrets page lists the secret and can delete it", async ({ page, request }) => {
    await page.goto(`${BASE}/secrets`);
    await expect(page.getByTestId("secrets-page")).toBeVisible();
    await expect(page.getByTestId(`secret-row-${SECRET}`)).toBeVisible({ timeout: 10000 });
    page.on("dialog", (d) => d.accept());
    await page.getByTestId(`secret-delete-${SECRET}`).click();
    await expect(page.getByTestId(`secret-row-${SECRET}`)).toHaveCount(0, { timeout: 10000 });
    // cleanup the project
    await request.delete(`${BASE}/api/projects/${PID}`).catch(() => {});
  });
});
