import { test, expect } from "@playwright/test";

// LIVE-only: proves the isolation ladder is dynamic — the rung(s) the online workers
// actually report (from /api/fleet worker.executor) are highlighted "live", while the
// unimplemented tiers stay on the roadmap. Runs when the app is built VITE_MILL_MODE=live
// against a real api that has both a docker and an in-process worker registered.
const LIVE = process.env.MILL_LIVE === "1";

test.describe("isolation ladder is dynamic (live)", () => {
  test.skip(!LIVE, "requires a live api with registered workers");

  test("highlights the executor tier the workers actually run", async ({ page }) => {
    await page.goto("/fleet");
    await expect(page.getByTestId("isolation-ladder")).toBeVisible();

    // the header chip echoes the live executor set pulled from /api/fleet
    const activeChip = page.getByTestId("ladder-active-executor");
    await expect(activeChip).toBeVisible();

    // the EKS default rung (hardened worker pod, in-process) is what the live workers serve
    await expect(page.getByTestId("ladder-live-pod")).toBeVisible();
    await expect(page.getByTestId("ladder-pod")).toHaveAttribute("data-live", "true");

    // dev, local-docker, and the roadmap tiers are NOT live (no worker runs them)
    await expect(page.getByTestId("ladder-live-dev")).toHaveCount(0);
    await expect(page.getByTestId("ladder-live-container")).toHaveCount(0);
    await expect(page.getByTestId("ladder-live-gvisor")).toHaveCount(0);
    await expect(page.getByTestId("ladder-live-firecracker")).toHaveCount(0);
    await expect(page.getByTestId("ladder-live-k8sjob")).toHaveCount(0);
  });
});
