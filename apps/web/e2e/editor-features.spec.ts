import { test, expect } from "@playwright/test";

test.describe("editor feature coverage", () => {
  test("node inspector tabs expose schema, ctx surface, and isolation", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    await page.getByTestId("node-fetch").click();

    await page.getByTestId("tab-schema").click();
    await expect(page.getByTestId("tab-panel-schema")).toContainText("ctx.inputs");

    await page.getByTestId("tab-context").click();
    await expect(page.getByTestId("tab-panel-context")).toContainText("ctx.secrets");
    await expect(page.getByTestId("node-secrets")).toContainText("API_URL");

    await page.getByTestId("tab-isolation").click();
    await expect(page.getByTestId("tab-panel-isolation")).toContainText("Executor");
  });

  test("triggers panel shows cron next-run, webhook copy, and concurrency policy", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    const triggers = page.getByTestId("triggers-panel");
    await expect(triggers).toContainText("cron");
    await expect(page.getByTestId("copy-webhook")).toBeVisible();
    await expect(page.getByTestId("concurrency-policy")).toContainText("Forbid");
  });

  test("run history shows a failed run with inspection and retry", async ({ page }) => {
    await page.goto("/projects/billing/workflows/dunning");
    await expect(page.getByTestId("run-history")).toBeVisible();
    await expect(page.getByTestId("failure-inspection")).toContainText("Failed at node");
    await page.getByTestId("retry-btn").click();
    await expect(page.getByTestId("toast")).toContainText("Retry queued");
  });

  test("observability panel shows metrics and links out to Grafana/Loki/Tempo", async ({ page }) => {
    await page.goto("/projects/billing/workflows/invoices");
    const panel = page.getByTestId("observability-panel");
    await expect(panel).toContainText("Observability");
    await expect(panel).toContainText("queue depth");
    // outbound links exist
    await expect(page.getByTestId("open-metrics")).toHaveAttribute("href", "/api/metrics");
    await expect(page.getByTestId("open-tempo")).toBeVisible();
    // clicking a destination flashes a toast
    await page.getByTestId("open-grafana").click();
    await expect(page.getByTestId("toast")).toContainText("Grafana");
  });
});
