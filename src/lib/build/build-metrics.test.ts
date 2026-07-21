import { describe, expect, it } from "vitest";
import {
  buildMetricsArtifactStatus,
  buildMetricsPayload,
  categorizeBuildFailure,
  createBuildMetrics,
  recordDebugRoundMetric,
  recordGeneratedPhaseMetrics,
  recordReviewMetrics,
  setBuildFailureCategory,
  summarizeBuildMetrics,
} from "./build-metrics";

describe("build metrics", () => {
  it("tracks generated files, review warnings, and debug rounds", () => {
    const metrics = createBuildMetrics();

    recordGeneratedPhaseMetrics(metrics, [
      {
        id: "foundation",
        label: "Data foundation",
        agentKey: "backend_platform_planner",
        filesWritten: ["src/lib/tasks.ts"],
        filesDeleted: [],
      },
      {
        id: "pages-workflows",
        label: "Pages",
        agentKey: "frontend_builder",
        filesWritten: ["src/app/page.tsx", "src/components/TaskForm.tsx"],
        filesDeleted: ["src/components/Old.tsx"],
      },
    ]);
    recordReviewMetrics(metrics, [
      {
        agentKey: "code_reviewer",
        phaseKey: "generated-code-review",
        warnings: ["Use platform search helpers."],
        blockingIssues: [],
      },
    ]);
    recordDebugRoundMetric(metrics, {
      step: "test",
      domain: "unit_test",
      focus: "data_save",
      responsiblePhaseId: "unit-workflow-tests",
      responsibleAgentKey: "test_agent",
    });

    expect(metrics.debugRoundsByStep).toEqual({ test: 1 });
    expect(buildMetricsArtifactStatus(metrics)).toBe("warning");
    expect(summarizeBuildMetrics(metrics)).toContain("3 generated file changes");
    expect(buildMetricsPayload(metrics).totals).toMatchObject({
      generatedFileChanges: 3,
      generatedFileDeletes: 1,
      reviewWarnings: 1,
      debugRounds: 1,
    });
  });

  it("marks metrics failed when a failure category is recorded", () => {
    const metrics = createBuildMetrics();
    setBuildFailureCategory(metrics, "build_prerender");

    expect(buildMetricsArtifactStatus(metrics)).toBe("failed");
    expect(summarizeBuildMetrics(metrics)).toContain(
      "Failure category: build_prerender.",
    );
  });

  it("categorizes known failure messages", () => {
    expect(categorizeBuildFailure("typecheck failed with TS2322")).toBe(
      "typecheck",
    );
    expect(categorizeBuildFailure("Generated app review failed")).toBe(
      "integration_review_gate",
    );
    expect(categorizeBuildFailure("Vercel deployment failed")).toBe("vercel");
    expect(categorizeBuildFailure("GitHub returned HTTP 503")).toBe("github");
  });
});
