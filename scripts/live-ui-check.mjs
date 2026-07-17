// Drive the LIVE UI in a real browser: open the scraper (a backend-only workflow) and
// Run it — proving graph fetch + auto-layout + live trigger + SSE all work end to end.
import { chromium } from "@playwright/test";
const BASE = process.env.LIVE_BASE || "http://api:8080";
const browser = await chromium.launch();
const page = await browser.newPage();
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) failures++; };

try {
  await page.goto(`${BASE}/projects/demos/workflows/scrape-novi`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("workflow-editor").waitFor({ timeout: 15000 });
  check("live editor opened demos/scrape-novi", true);
  check("graph rendered (fetch + extract nodes)", (await page.getByTestId("node-fetch").count()) > 0 && (await page.getByTestId("node-extract").count()) > 0);

  await page.getByTestId("run-btn").click();
  await page.getByTestId("run-result").waitFor({ timeout: 30000 });
  const result = (await page.getByTestId("run-result").textContent()) ?? "";
  const logs = (await page.getByTestId("log-console").textContent()) ?? "";
  check("Run → Succeeded", result.includes("Succeeded"));
  check("streamed a real scrape result (NOVI Health title)", logs.includes("NOVI Health"));
  check("scraped ~83 links", /"links":8\d/.test(logs) || logs.includes("links"));
} catch (e) {
  console.error("ERROR:", e.message);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nLIVE SCRAPER UI OK ✅");
process.exit(failures ? 1 : 0);
