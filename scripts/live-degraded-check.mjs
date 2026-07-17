import { chromium } from "@playwright/test";
const BASE = process.env.LIVE_BASE || "http://api:8080";
const b = await chromium.launch();
const p = await b.newPage();
let f = 0;
const check = (n, ok) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) f++; };
try {
  await p.goto(`${BASE}/projects/billing`, { waitUntil: "networkidle" });
  await p.getByTestId("project-page").waitFor({ timeout: 10000 });
  await p.waitForTimeout(1000);
  check("header flipped to OutOfSync", (await p.getByTestId("sync-badge").first().getAttribute("data-status")) === "OutOfSync");
  check("header flipped to Degraded", (await p.getByTestId("health-badge").first().getAttribute("data-health")) === "Degraded");
  check("bad-commit / last-known-good banner shown", (await p.getByTestId("bad-commit-banner").count()) > 0);
} catch (e) { console.error("ERR", e.message); f++; } finally { await b.close(); }
console.log(f ? `\n${f} FAILED` : "\nDEGRADED UI OK ✅");
process.exit(f ? 1 : 0);
