import { test, expect } from "@playwright/test";

// The Endpoints panel must show external providers the PUBLIC webhook host + the capability
// (no-bearer) path — not the internal/SSO origin the UI is browsed from, and not the default
// bearer path. Regression for the wrong-URL bug (Acuity was shown an unusable .org/bearer URL).
const BASE = process.env.DEPLOYED_BASE;
test.skip(!BASE, "set DEPLOYED_BASE to the api origin");

test("a capability webhook shows a no-token URL on the public host", async ({ page, request }) => {
  const wf = `hooktest-${Date.now().toString(36)}`;
  const cap = "cap" + "0123456789abcdef".repeat(2); // ≥24 chars → capability path
  const save = await request.post(`${BASE}/api/projects/demos/workflows/${wf}`, {
    data: {
      message: "e2e: capability endpoint",
      workflow: {
        apiVersion: "mill/v1", kind: "Workflow", metadata: { name: wf },
        triggers: [{ type: "webhook", path: cap }],
        nodes: [{ key: "start", kind: "start" }, { key: "end", kind: "end" }],
        edges: [{ from: "start", to: "end" }],
      },
      files: {},
    },
  });
  expect(save.ok()).toBeTruthy();
  const ep = await (await request.get(`${BASE}/api/projects/demos/endpoints`)).json();

  try {
    await page.goto(`${BASE}/projects/demos`);
    const row = page.getByTestId(`endpoint-${wf}`);
    await expect(row).toBeVisible();
    // capability path (no bearer), NOT the default /p/w/<wf>/demos bearer path
    await expect(page.getByTestId(`endpoint-kind-${wf}`)).toHaveText(/no token/i);
    await expect(row).toContainText(cap);
    await expect(row).not.toContainText(`/p/w/${wf}/demos`);
    // uses the configured public host when the API reports one
    if (ep.publicBaseUrl) await expect(row).toContainText(ep.publicBaseUrl);
  } finally {
    await request.delete(`${BASE}/api/projects/demos/workflows/${wf}`).catch(() => {});
  }
});
