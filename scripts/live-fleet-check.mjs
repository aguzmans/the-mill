// Drive the LIVE Fleet page in a real browser: prove it renders real workers, live
// running-jobs, and rolling execution stats from /api/fleet (not the mock catalogue).
import { chromium } from "@playwright/test";
const BASE = process.env.LIVE_BASE || "http://api:8080";
const browser = await chromium.launch();
const page = await browser.newPage();
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) failures++; };

try {
  await page.goto(`${BASE}/fleet`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("fleet-page").waitFor({ timeout: 15000 });

  // The "live" badge only renders in LIVE mode once /api/fleet has responded.
  await page.getByTestId("fleet-source").waitFor({ timeout: 10000 });
  const src = (await page.getByTestId("fleet-source").textContent())?.trim() ?? "";
  check(`fleet data source is live (got "${src}")`, src === "live");

  // A real worker row (the isolated worker registers as w-isolat).
  const workerRows = await page.getByTestId(/^worker-/).count();
  check(`renders ${workerRows} real worker row(s)`, workerRows >= 1);

  // Workers-online stat reflects the live fleet (>= 1).
  const online = (await page.getByTestId("stat-workers").textContent()) ?? "";
  check(`workers-online stat populated (${online.replace(/\s+/g, " ").trim()})`, /[1-9]/.test(online));

  // Fire a slow-ish job and catch it "Running now" on its worker.
  await page.request.post(`${BASE}/api/projects/demos/workflows/scrape-novi/trigger`, { data: { input: {} } });
  await page.request.post(`${BASE}/api/projects/demos/workflows/scrape-novi/trigger`, { data: { input: {} } });
  let sawRunning = false;
  for (let i = 0; i < 20 && !sawRunning; i++) {
    const runningNow = await page.getByText("scrape-novi").count();
    if (runningNow > 0) sawRunning = true;
    else await page.waitForTimeout(300);
  }
  check("caught a job executing 'Running now' on a worker", sawRunning);

  // Execution stats panel present with a success rate.
  const exec = (await page.getByTestId("execution-panel").textContent()) ?? "";
  check("execution stats show a success rate", /%/.test(exec) && exec.includes("Success rate"));
} catch (e) {
  console.error("ERROR:", e.message);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nLIVE FLEET UI OK ✅");
process.exit(failures ? 1 : 0);
