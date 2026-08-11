import { defineConfig } from "@playwright/test";

/**
 * LOCKED PLATFORM FILE — managed by VoiceForge.
 * Runs the baseline browser + accessibility test against the production
 * build (`next start`) on a port that won't clash with a dev server.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  // Deterministic UI failures should reach VoiceForge's focused debug loop
  // immediately instead of repeating the same long locator wait.
  retries: 0,
  reporter: [["./e2e/voiceforge-progress-reporter.ts"], ["list"]],
  use: {
    baseURL: "http://localhost:4321",
    actionTimeout: 12_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command: "npm start -- -p 4321",
    url: "http://localhost:4321",
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
