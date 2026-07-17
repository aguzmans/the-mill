import { test, expect } from "@playwright/test";

test.describe("worker fleet", () => {
  test("shows fleet stats and per-worker capacity/memory", async ({ page }) => {
    await page.goto("/fleet");
    await expect(page.getByTestId("fleet-page")).toBeVisible();
    await expect(page.getByTestId("stat-workers")).toBeVisible();
    await expect(page.getByTestId("stat-queue")).toBeVisible();
    await expect(page.getByTestId("stat-inflight")).toBeVisible();

    const list = page.getByTestId("worker-list");
    await expect(list).toBeVisible();
    await expect(page.getByTestId("worker-w-7f3a")).toContainText("mill-worker-7f3a");
    await expect(page.getByTestId("worker-w-7f3a")).toContainText("MB");
  });

  test("shows dynamic min–max concurrency and a paused (load-shedding) worker", async ({ page }) => {
    await page.goto("/fleet");
    // per-worker band + fleet-level HPA in the autoscaling panel
    await expect(page.getByTestId("autoscaling-panel")).toContainText("min–max");
    await expect(page.getByTestId("autoscaling-panel")).toContainText("HPA");
    // the heavy worker has stopped pulling
    await expect(page.getByTestId("paused-w-2b91")).toContainText("paused");
    await expect(page.getByTestId("worker-w-2b91")).toContainText("min 1");
  });

  test("shows execution stats, pending-queue detail, and per-worker running jobs", async ({ page }) => {
    await page.goto("/fleet");
    // execution/throughput stats
    const exec = page.getByTestId("execution-panel");
    await expect(exec).toContainText("Throughput");
    await expect(exec).toContainText("p50 / p95");
    await expect(exec).toContainText("Success rate");
    await expect(page.getByTestId("throughput-trend")).toBeVisible();
    // pending queue detail
    await expect(page.getByTestId("queue-panel")).toContainText("oldest wait");
    await expect(page.getByTestId("queue-by-workflow")).toContainText("Nightly Invoices");
    // jobs currently running on a worker
    const jobs = page.getByTestId("jobs-w-7f3a");
    await expect(jobs).toContainText("Running now");
    await expect(jobs).toContainText("Load Warehouse");
    await expect(jobs).toContainText("more in flight");
  });
});
