import { defineConfig, devices } from "@playwright/test";

/**
 * E2E + visual tests run against the app in `mock` data mode so they are fully
 * deterministic and require no QuestDB connection.
 */
const PORT = Number(process.env.PW_PORT ?? 3210);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? "github" : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "mobile",
      use: { ...devices["iPhone 14 Pro"] },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm run build && pnpm run start`,
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(PORT),
      POWERFLOW_DATA_MODE: "mock",
      POWERFLOW_AUTH_DISABLED: "1",
      NODE_ENV: "production",
    },
  },
});
