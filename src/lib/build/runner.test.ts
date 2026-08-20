import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  E2E_PROGRESS_HEARTBEAT_MS,
  SANDBOX_BROWSER_PACKAGES,
  focusedRunCommand,
  sandboxBrowserSetupPlan,
} from "./runner";

describe("sandbox browser setup", () => {
  it("targets one workflow journey or affected unit-test file", () => {
    expect(
      focusedRunCommand({
        kind: "e2e",
        grep: "voiceforge-journey:journey-save-route-to-track-route",
      }),
    ).toEqual({
      step: "e2e",
      cmd: "npx",
      args: [
        "playwright",
        "test",
        "--grep",
        "voiceforge-journey:journey-save-route-to-track-route",
      ],
    });
    expect(
      focusedRunCommand({
        kind: "unit",
        testFiles: ["src/lib/routes.test.ts"],
      }),
    ).toEqual({
      step: "test",
      cmd: "npx",
      args: ["vitest", "run", "src/lib/routes.test.ts"],
    });
  });

  it("installs the verified Chromium runtime before hosted browser tests", () => {
    const plan = sandboxBrowserSetupPlan();

    expect(plan).toEqual([
      {
        label: "Linux browser libraries",
        cmd: "sudo",
        args: ["dnf", "install", "-y", ...SANDBOX_BROWSER_PACKAGES],
      },
      {
        label: "Chromium",
        cmd: "npx",
        args: ["playwright", "install", "chromium"],
      },
    ]);
    expect(SANDBOX_BROWSER_PACKAGES).toEqual(
      expect.arrayContaining(["nss", "nspr", "gtk3", "mesa-libgbm"]),
    );
  });

  it("provides a per-attempt namespace for retry-safe acceptance fixtures", () => {
    const source = readFileSync(
      new URL(
        "../../../templates/nextjs-base/e2e/voiceforge-acceptance.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("acceptanceRunSuffix");
    expect(source).toContain("process.pid");
    expect(source).toContain("Date.now()");
    expect(source).toContain("testInfo.workerIndex");
    expect(source).toContain("testInfo.parallelIndex");
    expect(source).toContain("testInfo.retry");
    expect(source).toContain("testInfo.testId");
    expect(source).toContain("export function vfControl");
    expect(source).toContain("export function vfRecords");
    expect(source).toContain("export function vfRecordControl");
    expect(source).toContain("expectContractControl");
  });

  it("runs baseline, retry, and parallel Stage 14I browser validation", () => {
    const source = readFileSync(
      new URL(
        "../../../templates/nextjs-base/e2e/voiceforge-isolation-runner.mjs",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("baseline full suite");
    expect(source).toContain("independent retry suite");
    expect(source).toContain("VOICEFORGE_ACCEPTANCE_RETRY_PROBE");
    expect(source).toContain("--fully-parallel");
    expect(source).toContain("parallel-safe suite");
  });

  it("fails deterministic browser actions quickly and emits progress markers", () => {
    const config = readFileSync(
      new URL(
        "../../../templates/nextjs-base/playwright.config.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const reporter = readFileSync(
      new URL(
        "../../../templates/nextjs-base/e2e/voiceforge-progress-reporter.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(config).toContain("timeout: 120_000");
    expect(config).toContain("actionTimeout: 12_000");
    expect(config).toContain("timeout: 15_000");
    expect(config).toContain("retries: 0");
    expect(config).toContain("voiceforge-progress-reporter.ts");
    expect(reporter).toContain("[voiceforge-e2e]");
    expect(reporter).toContain("onTestBegin");
    expect(reporter).toContain("onTestEnd");
    expect(E2E_PROGRESS_HEARTBEAT_MS).toBe(15_000);
  });
});
