import { defineConfig, devices } from "@playwright/test";

// The webServer builds the app and serves the production bundle, so tests exercise
// the same artifact that ships in Docker. Set CI=1 to fail on accidental .only.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Mock-mode specs build + preview the prototype bundle here. When DEPLOYED_BASE is set we're
  // testing a real live backend instead, so skip the (slow, irrelevant) mock webServer entirely.
  webServer: process.env.DEPLOYED_BASE
    ? undefined
    : {
        command: "npm run build && npm run preview",
        url: "http://localhost:4173",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
