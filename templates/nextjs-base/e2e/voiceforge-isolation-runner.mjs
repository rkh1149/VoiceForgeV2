/**
 * LOCKED PLATFORM FILE - managed by VoiceForge.
 * Runs the Stage 14I browser matrix after Chromium has been prepared.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const compiledPath = "e2e/generated/voiceforge-compiled.spec.ts";
const manifestPath = "e2e/generated/voiceforge-acceptance-manifest.ts";
const forceFullMatrix = process.env.VOICEFORGE_FORCE_FULL_E2E === "1";
const manifestSource = existsSync(manifestPath)
  ? readFileSync(manifestPath, "utf8")
  : "";
const simpleProfile =
  !forceFullMatrix && manifestSource.includes('"validationProfile": "simple"');

// Establish the complete baseline without overlapping workflows that were
// classified as unsafe for parallel execution. A separate pass below still
// proves that explicitly parallel-safe journeys can run concurrently.
run("baseline full suite", ["playwright", "test", "--workers=1"]);

if (simpleProfile) {
  progress("proportional simple-app validation passed; retry and parallel probes skipped");
} else if (existsSync(compiledPath)) {
  const compiledSource = readFileSync(compiledPath, "utf8");
  run(
    "independent retry suite",
    [
      "playwright",
      "test",
      compiledPath,
      "--workers=1",
      "--retries=1",
      "--grep",
      "voiceforge-isolated-journey",
    ],
    { VOICEFORGE_ACCEPTANCE_RETRY_PROBE: "1" },
  );

  if (compiledSource.includes("[voiceforge-parallel]")) {
    run("parallel-safe suite", [
      "playwright",
      "test",
      compiledPath,
      "--fully-parallel",
      "--workers=2",
      "--grep",
      "\\[voiceforge-parallel\\]",
    ]);
  } else {
    progress("parallel-safe suite skipped; no journey was classified as safe");
  }
}

progress(
  simpleProfile
    ? "proportional E2E suite passed"
    : "Stage 14I isolation matrix passed",
);

function run(label, args, extraEnv = {}) {
  progress(`starting ${label}`);
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, args, {
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    progress(`${label} failed with exit code ${result.status ?? "unknown"}`);
    process.exit(result.status ?? 1);
  }
  progress(`${label} passed`);
}

function progress(message) {
  console.log(`[voiceforge-e2e] Stage 14I: ${message}`);
}
