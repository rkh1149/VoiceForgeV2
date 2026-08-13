import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("build pipeline app status fallbacks", () => {
  it("keeps existing previews testable when a later build fails", () => {
    const source = readFileSync(
      new URL("./pipeline.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("function appStatusAfterBuildFailure");
    expect(source).toContain('if (app.previewUrl) return "testing";');
    expect(source).toContain("status: appStatusAfterBuildFailure");
    expect(source).toContain("function appStatusAfterNeedsInput");
    expect(source).toContain('.set({ status, errorMessage, ...extra })');
  });

  it("uses durable workflow-scoped repair and validation checkpoints", () => {
    const source = readFileSync(
      new URL("./pipeline.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("createWorkflowRepairPackage");
    expect(source).toContain("validateWorkflowRepairMutationScope");
    expect(source).toContain("validateFocusedWorkflowRepair");
    expect(source).toContain("loadBuildCheckpointById");
    expect(source).toContain("workflowRepairSnapshots");
    expect(source).toContain("workflowRepairOwnsFailure");
    expect(source).toContain("candidateProgressed");
    expect(source).toContain("Checkpointed partial");
    expect(source).toContain("the prior proven source is active again");
    expect(source).toContain("the named workflow will be reviewed");
  });

  it("preserves generated-file review scope across test rollback and resume", () => {
    const source = readFileSync(
      new URL("./pipeline.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("reviewProgress: input.reviewProgress");
    expect(source).toContain(
      "originallyGeneratedPaths.has(path) || isAgentWritablePath(path).ok",
    );
    expect(source).not.toContain(
      "changedFilePaths: Object.keys(agentVisibleFiles(input.files))",
    );
    expect(source).not.toContain(
      "changedFiles: agentVisibleFiles(input.files)",
    );
    expect(source).toContain('!passedSteps.has("build")');
    expect(source.indexOf('!passedSteps.has("build")')).toBeLessThan(
      source.indexOf("const browser = await activeRunner.runFocused"),
    );
    expect(source).toContain('focused.failedStep === "e2e"');
    expect(source).toContain(
      "preserved the static-improving candidate",
    );
    expect(source).toContain('workflowCandidate && step !== "e2e"');
    expect(source).toContain("const focusedImproved");
    expect(source).toContain("workflowFocusedFailureFingerprint");
    expect(source).toContain(
      "Focused browser repair made progress and was checkpointed",
    );
    expect(source).toContain("const debugBudgetStep = workflowRepair");
    expect(source).toContain('`${step}:${workflowRepair.id}`');
  });
});
