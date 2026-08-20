import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Stage 14I locked acceptance runtime", () => {
  it("provides deterministic primitives and a typed adapter boundary", () => {
    const source = readFileSync(
      new URL(
        "../../../templates/nextjs-base/e2e/voiceforge-acceptance.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("VoiceForgeAcceptanceAdapters");
    expect(source).toContain("resolveAcceptanceControl");
    expect(source).toContain("resolveUniqueAcceptanceControl");
    expect(source).toContain(".first();");
    expect(source).toContain("selectAcceptanceOption");
    expect(source).toContain("completeAcceptanceForm");
    expect(source).toContain("runAcceptanceAdapter");
    expect(source).toContain("dragAcceptanceControl");
    expect(source).toContain("new DataTransfer()");
    expect(source).toContain("testInfo.workerIndex");
    expect(source).toContain("testInfo.parallelIndex");
    expect(source).toContain("testInfo?: TestInfo");
    expect(source).toContain('fixtureNamespace = "legacy"');
    expect(source).toContain("testInfo.retry");
    expect(source).toContain("testInfo.testId");
    expect(source).toContain("VOICEFORGE_ACCEPTANCE_RETRY_PROBE");
    expect(source).toContain("workflowFixtureSetupTitle");
    expect(source).toContain("x-voiceforge-test-namespace");
  });

  it("isolates local platform records by the browser attempt namespace", () => {
    const source = readFileSync(
      new URL(
        "../../../templates/nextjs-base/src/app/api/data/route.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain('req.headers.get("x-voiceforge-test-namespace")');
    expect(source).toContain("Map<string, Map<string, LocalRecord>>");
    expect(source).toContain("getLocalRecords(namespace)");
    expect(source).toContain("getLocalSavedFilters(namespace)");
  });
});
