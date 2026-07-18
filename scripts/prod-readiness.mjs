// Final production-readiness sweep: adversarial API + frontend checks against the live stack.
// Classifies findings as BUG (wrong/broken), WARN (prod-readiness gap), or ok.
import { chromium } from "@playwright/test";
const BASE = process.env.LIVE_BASE || "http://api:8080";
const TOK = process.env.INGRESS_TOKEN || "";
const bugs = [], warns = [];
const browser = await chromium.launch();
const ctx = await browser.newContext();
const api = ctx.request;

const expectStatus = async (label, promise, want) => {
  try {
    const r = await promise; const got = r.status();
    const ok = Array.isArray(want) ? want.includes(got) : got === want;
    console.log(`${ok ? "✓" : "✗"} ${label} → ${got}${ok ? "" : ` (wanted ${want})`}`);
    if (!ok) bugs.push(`${label}: got ${got}, wanted ${want}`);
    return r;
  } catch (e) { console.log(`✗ ${label} — ${e.message.split("\n")[0]}`); bugs.push(`${label}: ${e.message.split("\n")[0]}`); }
};
const GET = (p) => api.get(`${BASE}${p}`);
const POST = (p, data, headers) => api.post(`${BASE}${p}`, { data, headers });

console.log("── API: happy paths ──");
for (const p of ["/api/health", "/api/projects", "/api/status", "/api/fleet", "/api/metrics", "/api/triggers", "/api/workers", "/api/reconcile-events"])
  await expectStatus(`GET ${p}`, GET(p), 200);
await expectStatus("GET graph", GET("/api/projects/pipelines/workflows/map-numbers"), 200);
await expectStatus("GET runs", GET("/api/projects/pipelines/workflows/map-numbers/runs"), 200);
await expectStatus("GET diff", GET("/api/projects/pipelines/diff"), 200);
await expectStatus("GET endpoints", GET("/api/projects/pipelines/endpoints"), 200);

console.log("\n── API: error paths (should be 4xx, not 500/200) ──");
await expectStatus("GET unknown project graph", GET("/api/projects/nope/workflows/nope"), [400, 404]);
await expectStatus("GET unknown job", GET("/api/jobs/nope"), 404);
await expectStatus("GET unknown project endpoints", GET("/api/projects/nope/endpoints"), 404);
await expectStatus("trigger unknown workflow", POST("/api/projects/demos/workflows/nope/trigger", { input: {} }), 404);
await expectStatus("node-test unknown node", POST("/api/projects/pipelines/workflows/types/nodes/nope/test", { input: {} }), 404);
await expectStatus("create project bad id", POST("/api/projects", { id: "Bad Id!" }), 400);
await expectStatus("create project duplicate", POST("/api/projects", { id: "demos" }), 409);
await expectStatus("save invalid workflow", POST("/api/projects/demos/workflows/math", { workflow: { nodes: [{ key: "x", kind: "jscode" }] }, files: {} }), 400);
await expectStatus("retry unknown job", POST("/api/jobs/nope/retry", {}), 404);
// malformed JSON body
await expectStatus("save malformed JSON", api.post(`${BASE}/api/projects/demos/workflows/math`, { headers: { "content-type": "application/json" }, data: "{ not json" }), [400, 500]);

console.log("\n── API: path-traversal guard on Save ──");
const trav = await POST("/api/projects/demos/workflows/math", { workflow: { apiVersion: "mill/v1", kind: "Workflow", metadata: { name: "math" }, triggers: [{ type: "manual" }], nodes: [{ key: "start", kind: "start" }, { key: "end", kind: "end" }], edges: [{ from: "start", to: "end" }] }, files: { "../../evil.js": "hacked" } });
if (trav) { const ok = trav.status() === 400; console.log(`${ok ? "✓" : "✗"} save with ../ file path rejected → ${trav.status()}`); if (!ok) bugs.push(`path traversal not rejected: ${trav.status()}`); }

console.log("\n── API: ingress auth ──");
await expectStatus("ingress no bearer", POST("/p/w/math/demos", {}), 401);
await expectStatus("ingress wrong bearer", POST("/p/w/math/demos", {}, { authorization: "Bearer wrong" }), 401);
if (TOK) {
  await expectStatus("ingress correct bearer", POST("/p/w/math/demos", { input: {} }, { authorization: `Bearer ${TOK}` }), [200, 202]);
  await expectStatus("ingress unknown path", POST("/p/w/math/nosuch", {}, { authorization: `Bearer ${TOK}` }), 404);
}

console.log("\n── API: unauthenticated control-plane (prod-readiness) ──");
// The /api/* control plane has NO auth — anyone reaching it can mutate. Confirm + flag.
const del = await api.fetch(`${BASE}/api/projects/__probe_nonexistent__`, { method: "DELETE" });
if (del.status() !== 401 && del.status() !== 403) warns.push("control-plane /api/* has no authentication (create/delete/save/trigger are open) — relies entirely on ingress-level SSO");
const cors = (await GET("/api/status")).headers()["access-control-allow-origin"];
if (cors === "*") warns.push("CORS is Access-Control-Allow-Origin: * on /api/* — any origin can call the control plane from a browser");

console.log("\n── Frontend: pages load with no console/page errors ──");
const routes = ["/", "/fleet", "/projects/pipelines", "/projects/demos/workflows/fanout", "/projects/deps-demo/workflows/enrich", "/prototype/"];
for (const route of routes) {
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push(String(e)));
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1200);
    const bodyLen = (await page.locator("body").textContent() || "").length;
    const blank = bodyLen < 40;
    // filter noise (favicon/font 404s aren't app bugs)
    const real = errs.filter((e) => !/favicon|font|manifest|net::ERR_/.test(e));
    const ok = !blank && real.length === 0;
    console.log(`${ok ? "✓" : "✗"} ${route}  (${bodyLen} chars, ${real.length} console errors)`);
    if (blank) bugs.push(`${route}: blank page`);
    real.slice(0, 3).forEach((e) => bugs.push(`${route} console error: ${e.slice(0, 120)}`));
  } catch (e) { console.log(`✗ ${route} — ${e.message.split("\n")[0]}`); bugs.push(`${route}: ${e.message.split("\n")[0]}`); }
  finally { await page.close(); }
}

console.log(`\n════ SUMMARY ════`);
console.log(`BUGS: ${bugs.length}`); bugs.forEach((b) => console.log(`  🐛 ${b}`));
console.log(`WARNINGS (prod-readiness): ${warns.length}`); warns.forEach((w) => console.log(`  ⚠️  ${w}`));
await browser.close();
process.exit(bugs.length ? 1 : 0);
