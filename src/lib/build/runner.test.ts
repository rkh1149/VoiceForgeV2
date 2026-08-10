import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  SANDBOX_BROWSER_PACKAGES,
  sandboxBrowserSetupPlan,
} from "./runner";

describe("sandbox browser setup", () => {
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

  it("provides a stable per-worker suffix for retry-safe acceptance fixtures", () => {
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
  });
});
