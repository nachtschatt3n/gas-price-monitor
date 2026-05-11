import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3457",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun e2e/test-server.ts",
    url: "http://localhost:3457/api/config",
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
