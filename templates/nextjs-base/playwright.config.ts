import { defineConfig } from "@playwright/test";

/**
 * LOCKED PLATFORM FILE — managed by VoiceForge.
 * Runs the baseline browser + accessibility test against the production
 * build (`next start`) on a port that won't clash with a dev server.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4321",
  },
  webServer: {
    command: "npm start -- -p 4321",
    url: "http://localhost:4321",
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
