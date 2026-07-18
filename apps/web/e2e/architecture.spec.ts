import { test, expect } from "@playwright/test";

test.describe("architecture reference", () => {
  test("nav reaches the architecture page and shows topology + decisions", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByTestId("nav-architecture").click();
    const arch = page.getByTestId("architecture-page");
    await expect(arch).toBeVisible();
    await expect(arch).toContainText("Topology");
    await expect(arch).toContainText("Why no database");
    await expect(arch).toContainText("K8s strategy");
  });
});

test.describe("new project", () => {
  test("New Project opens a wizard with sync policy", async ({ page }) => {
    await page.goto("/workspace");
    await page.getByTestId("new-project").click();
    await expect(page.getByTestId("new-project-modal")).toBeVisible();
    await expect(page.getByTestId("np-autosync")).toBeVisible();
    await page.getByTestId("new-project-submit").click();
    await expect(page.getByTestId("toast")).toContainText("registered");
  });
});

test.describe("fleet isolation", () => {
  test("fleet shows the isolation ladder and autoscaling", async ({ page }) => {
    await page.goto("/fleet");
    // EKS model: the pod is the isolation boundary (default rung); docker is local-only; roadmap below.
    await expect(page.getByTestId("isolation-ladder")).toContainText("Hardened worker pod");
    await expect(page.getByTestId("isolation-ladder")).not.toContainText("NsjailProcessExecutor");
    await expect(page.getByTestId("ladder-firecracker")).toBeVisible();
    await expect(page.getByTestId("ladder-container")).toContainText("local");
    await expect(page.getByTestId("autoscaling-panel")).toContainText("HPA");
    await expect(page.getByTestId("autoscaling-panel")).toContainText("KEDA"); // queue-depth autoscaling
    await expect(page.getByTestId("autoscaling-panel")).toContainText("min–max");
  });
});
