import { describe, expect, it } from "vitest";
import {
  GOLDEN_CAPABILITY_VALUES,
  REQUIRED_CAPABILITY_PAIRS,
} from "./capability-catalog";
import { createDeterministicProviderHarness } from "./deterministic-provider-harness";
import {
  analyzeGoldenCapabilityCoverage,
  GOLDEN_CAPABILITY_MATRIX,
} from "./golden-capability-matrix";
import {
  HISTORICAL_REGRESSIONS,
  identifyHistoricalRegressions,
  validateHistoricalRegressionRegistry,
} from "./historical-regressions";
import {
  createStage15GoldenPackage,
  runStage15QualityGate,
} from "./stage15-golden-harness";

describe("Stage 15 deployment quality gate", () => {
  it("covers every supported capability and required high-risk pair", () => {
    const coverage = analyzeGoldenCapabilityCoverage();
    expect(coverage.missingCapabilities).toEqual([]);
    expect(coverage.missingPairs).toEqual([]);
    expect(coverage.duplicateIds).toEqual([]);
    expect(coverage.coveredCapabilities).toHaveLength(
      GOLDEN_CAPABILITY_VALUES.length,
    );
    expect(REQUIRED_CAPABILITY_PAIRS.length).toBeGreaterThan(0);
  });

  it("builds deterministic golden packages from contracts", () => {
    for (const goldenCase of GOLDEN_CAPABILITY_MATRIX) {
      const first = createStage15GoldenPackage(goldenCase);
      const second = createStage15GoldenPackage(goldenCase);
      expect.soft(first.blockingIssues, goldenCase.id).toEqual([]);
      expect.soft(second, goldenCase.id).toEqual(first);
      expect.soft(first.summary.workflows, goldenCase.id).toBeGreaterThan(0);
      expect.soft(first.summary.journeys, goldenCase.id).toBeGreaterThan(0);
      expect.soft(first.summary.steps, goldenCase.id).toBeGreaterThan(0);
    }
  });

  it("keeps every historical failure reproducible and classifiable", () => {
    expect(validateHistoricalRegressionRegistry()).toEqual([]);
    expect(new Set(HISTORICAL_REGRESSIONS.map((item) => item.id)).size).toBe(
      HISTORICAL_REGRESSIONS.length,
    );
    for (const regression of HISTORICAL_REGRESSIONS) {
      expect
        .soft(identifyHistoricalRegressions(regression.sampleFailure))
        .toContain(regression.id);
    }
  });

  it("provides deterministic success and failure providers without network calls", () => {
    const success = createDeterministicProviderHarness();
    expect(success.invoke("ai").data).toMatchObject({
      text: expect.stringContaining("quantity"),
    });
    expect(success.invoke("maps").data.routes).toHaveLength(1);
    expect(success.invoke("files").data.fileId).toBe("file-1");

    const failures = createDeterministicProviderHarness({
      ai: "invalid_response",
      maps: "rate_limited",
      notifications: "unavailable",
      location: "permission_denied",
      files: "oversized_file",
    });
    expect(failures.invoke("ai").data).toEqual({ unexpected: true });
    expect(failures.invoke("maps").status).toBe(429);
    expect(failures.invoke("notifications").status).toBe(503);
    expect(failures.invoke("location").status).toBe(403);
    expect(failures.invoke("files").status).toBe(413);
  });

  it("passes the production-fast quality gate", () => {
    const result = runStage15QualityGate();
    expect(result.blockingIssues).toEqual([]);
    expect(result.status).toBe("passed");
    expect(result.summary.goldenCases).toBe(GOLDEN_CAPABILITY_MATRIX.length);
  });
});
