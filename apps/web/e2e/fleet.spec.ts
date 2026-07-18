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

  test("surfaces failures prominently (banner + red stat) so operators notice", async ({ page }) => {
    await page.goto("/fleet");
    // mock fleet has failures → a red banner and a highlighted Failed stat card
    const banner = page.getByTestId("failures-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("failed run");
    const failed = page.getByTestId("stat-failed");
    await expect(failed).toBeVisible();
    await expect(failed).toContainText("Failed");
    await expect(failed).toHaveAttribute("data-danger", "true");
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

  test("isolation ladder reflects the EKS model (pod = boundary) + roadmap tiers", async ({ page }) => {
    await page.goto("/fleet");
    const ladder = page.getByTestId("isolation-ladder");
    await expect(ladder).toBeVisible();
    // dev + the EKS default (hardened worker pod, in-process)
    await expect(page.getByTestId("ladder-dev")).toContainText("InProcessExecutor");
    await expect(page.getByTestId("ladder-pod")).toContainText("Hardened worker pod");
    // docker is a local-only demo, not the k8s path
    await expect(page.getByTestId("ladder-container")).toContainText("local");
    // roadmap rungs
    await expect(page.getByTestId("ladder-gvisor")).toContainText("GvisorExecutor");
    await expect(page.getByTestId("ladder-firecracker")).toContainText("FirecrackerExecutor");
    await expect(page.getByTestId("ladder-k8sjob")).toContainText("K8sJobExecutor");
  });
});
