import type { BuildAgentArtifactStatus } from "./agent-artifact-utils";

export type BuildFailureCategory =
  | "architecture_capability"
  | "workflow_contract"
  | "code_generation"
  | "dependency_security"
  | "typecheck"
  | "lint"
  | "unit_test"
  | "build_prerender"
  | "browser_accessibility"
  | "integration_review_gate"
  | "deployment"
  | "github"
  | "vercel"
  | "unknown";

export type BuildPhaseMetric = {
  phaseKey: string;
  label: string;
  agentKey: string;
  changedCount: number;
  deletedCount: number;
  filesWritten: string[];
  filesDeleted: string[];
};

export type BuildReviewWarningMetric = {
  agentKey: string;
  phaseKey: string;
  warnings: string[];
};

export type BuildReviewFailureMetric = {
  agentKey: string;
  phaseKey: string;
  blockingIssues: string[];
};

export type BuildDebugRoundMetric = {
  step: string;
  domain?: string;
  focus?: string;
  responsiblePhaseId?: string;
  responsibleAgentKey?: string;
};

export type BuildMetrics = {
  generatedFilesByPhase: BuildPhaseMetric[];
  reviewWarnings: BuildReviewWarningMetric[];
  reviewFailures: BuildReviewFailureMetric[];
  debugRounds: BuildDebugRoundMetric[];
  debugRoundsByStep: Record<string, number>;
  acceptanceJourneyCoverage: AcceptanceJourneyCoverageMetric | null;
  failureCategory: BuildFailureCategory | null;
};

export type AcceptanceJourneyCoverageMetric = {
  journeysPlanned: number;
  journeysVerified: number;
  workflowsRequired: number;
  workflowsVerified: number;
  stepsRequired: number;
  stepsVerified: number;
  savesRequired: number;
  savesVerified: number;
  refreshChecksRequired: number;
  refreshChecksVerified: number;
  handoffsRequired: number;
  handoffsVerified: number;
};

type PhaseLike = {
  id: string;
  label: string;
  agentKey: string;
  filesWritten: string[];
  filesDeleted?: string[];
};

type ReviewLike = {
  agentKey: string;
  phaseKey: string;
  warnings: string[];
  blockingIssues: string[];
  payload?: Record<string, unknown>;
};

export function createBuildMetrics(): BuildMetrics {
  return {
    generatedFilesByPhase: [],
    reviewWarnings: [],
    reviewFailures: [],
    debugRounds: [],
    debugRoundsByStep: {},
    acceptanceJourneyCoverage: null,
    failureCategory: null,
  };
}

export function recordGeneratedPhaseMetrics(
  metrics: BuildMetrics,
  phases: readonly PhaseLike[],
): void {
  for (const phase of phases) {
    const existing = metrics.generatedFilesByPhase.find(
      (item) => item.phaseKey === phase.id,
    );
    const value: BuildPhaseMetric = {
      phaseKey: phase.id,
      label: phase.label,
      agentKey: phase.agentKey,
      changedCount: phase.filesWritten.length,
      deletedCount: phase.filesDeleted?.length ?? 0,
      filesWritten: [...phase.filesWritten],
      filesDeleted: [...(phase.filesDeleted ?? [])],
    };
    if (existing) Object.assign(existing, value);
    else metrics.generatedFilesByPhase.push(value);
  }
}

export function recordReviewMetrics(
  metrics: BuildMetrics,
  reviews: readonly ReviewLike[],
): void {
  for (const review of reviews) {
    if (review.agentKey === "acceptance_test_reviewer") {
      const summary = recordValue(review.payload?.summary);
      if (summary) {
        metrics.acceptanceJourneyCoverage = {
          journeysPlanned: numberValue(summary.journeysPlanned),
          journeysVerified: numberValue(summary.journeysVerified),
          workflowsRequired: numberValue(summary.workflowsRequired),
          workflowsVerified: numberValue(summary.workflowsVerified),
          stepsRequired: numberValue(summary.stepsRequired),
          stepsVerified: numberValue(summary.stepsVerified),
          savesRequired: numberValue(summary.savesRequired),
          savesVerified: numberValue(summary.savesVerified),
          refreshChecksRequired: numberValue(summary.refreshChecksRequired),
          refreshChecksVerified: numberValue(summary.refreshChecksVerified),
          handoffsRequired: numberValue(summary.handoffsRequired),
          handoffsVerified: numberValue(summary.handoffsVerified),
        };
      }
    }
    if (review.warnings.length > 0) {
      upsertReviewWarnings(metrics, {
        agentKey: review.agentKey,
        phaseKey: review.phaseKey,
        warnings: [...review.warnings],
      });
    }
    if (review.blockingIssues.length > 0) {
      upsertReviewFailures(metrics, {
        agentKey: review.agentKey,
        phaseKey: review.phaseKey,
        blockingIssues: [...review.blockingIssues],
      });
    }
  }
}

export function recordDebugRoundMetric(
  metrics: BuildMetrics,
  input: BuildDebugRoundMetric,
): void {
  metrics.debugRounds.push(input);
  metrics.debugRoundsByStep[input.step] =
    (metrics.debugRoundsByStep[input.step] ?? 0) + 1;
}

export function setBuildFailureCategory(
  metrics: BuildMetrics,
  category: BuildFailureCategory,
): void {
  metrics.failureCategory = category;
}

export function buildMetricsArtifactStatus(
  metrics: BuildMetrics,
): BuildAgentArtifactStatus {
  if (metrics.failureCategory) return "failed";
  if (
    metrics.reviewWarnings.length > 0 ||
    metrics.reviewFailures.length > 0 ||
    metrics.debugRounds.length > 0
  ) {
    return "warning";
  }
  return "passed";
}

export function summarizeBuildMetrics(metrics: BuildMetrics): string {
  const generatedFiles = metrics.generatedFilesByPhase.reduce(
    (sum, phase) => sum + phase.changedCount,
    0,
  );
  const debugRounds = metrics.debugRounds.length;
  const warningCount = metrics.reviewWarnings.reduce(
    (sum, review) => sum + review.warnings.length,
    0,
  );
  const failure =
    metrics.failureCategory === null
      ? ""
      : ` Failure category: ${metrics.failureCategory}.`;
  return `Build metrics: ${generatedFiles} generated file change${
    generatedFiles === 1 ? "" : "s"
  } across ${metrics.generatedFilesByPhase.length} phase${
    metrics.generatedFilesByPhase.length === 1 ? "" : "s"
  }, ${debugRounds} debug round${
    debugRounds === 1 ? "" : "s"
  }, ${warningCount} review warning${warningCount === 1 ? "" : "s"}.${failure}`;
}

export function buildMetricsPayload(metrics: BuildMetrics): Record<string, unknown> {
  return {
    generatedFilesByPhase: metrics.generatedFilesByPhase,
    reviewWarnings: metrics.reviewWarnings,
    reviewFailures: metrics.reviewFailures,
    debugRoundsByStep: metrics.debugRoundsByStep,
    debugRounds: metrics.debugRounds,
    acceptanceJourneyCoverage: metrics.acceptanceJourneyCoverage,
    failureCategory: metrics.failureCategory,
    totals: {
      generatedFileChanges: metrics.generatedFilesByPhase.reduce(
        (sum, phase) => sum + phase.changedCount,
        0,
      ),
      generatedFileDeletes: metrics.generatedFilesByPhase.reduce(
        (sum, phase) => sum + phase.deletedCount,
        0,
      ),
      reviewWarnings: metrics.reviewWarnings.reduce(
        (sum, review) => sum + review.warnings.length,
        0,
      ),
      reviewFailures: metrics.reviewFailures.reduce(
        (sum, review) => sum + review.blockingIssues.length,
        0,
      ),
      debugRounds: metrics.debugRounds.length,
    },
  };
}

export function categorizeBuildFailure(message: string): BuildFailureCategory {
  const text = message.toLowerCase();
  if (
    text.includes("max turns") ||
    text.includes("generation phase") ||
    text.includes("code agent")
  ) {
    return "code_generation";
  }
  if (
    text.includes("workflow_contract:") ||
    text.includes("workflow contract") ||
    text.includes("workflow plan")
  ) {
    return "workflow_contract";
  }
  if (text.includes("platform capabilities")) return "architecture_capability";
  if (text.includes("acceptance_test:")) return "integration_review_gate";
  if (
    text.includes("dependencies") ||
    text.includes("dependency") ||
    text.includes("security")
  ) {
    return "dependency_security";
  }
  if (text.includes("typecheck") || /\bts\d{4}\b/.test(text)) return "typecheck";
  if (text.includes("lint") || text.includes("eslint")) return "lint";
  if (text.includes("test") || text.includes("vitest")) return "unit_test";
  if (text.includes("prerender") || text.includes("build")) {
    return "build_prerender";
  }
  if (text.includes("e2e") || text.includes("browser") || text.includes("axe")) {
    return "browser_accessibility";
  }
  if (
    text.includes("review failed") ||
    text.includes("review_gate") ||
    text.includes("interface review") ||
    text.includes("persistence review") ||
    text.includes("acceptance review")
  ) {
    return "integration_review_gate";
  }
  if (text.includes("github")) return "github";
  if (text.includes("vercel")) return "vercel";
  if (text.includes("deploy")) return "deployment";
  return "unknown";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function upsertReviewWarnings(
  metrics: BuildMetrics,
  next: BuildReviewWarningMetric,
): void {
  const existing = metrics.reviewWarnings.find(
    (item) =>
      item.agentKey === next.agentKey && item.phaseKey === next.phaseKey,
  );
  if (existing) {
    existing.warnings = uniqueStrings([...existing.warnings, ...next.warnings]);
  } else {
    metrics.reviewWarnings.push(next);
  }
}

function upsertReviewFailures(
  metrics: BuildMetrics,
  next: BuildReviewFailureMetric,
): void {
  const existing = metrics.reviewFailures.find(
    (item) =>
      item.agentKey === next.agentKey && item.phaseKey === next.phaseKey,
  );
  if (existing) {
    existing.blockingIssues = uniqueStrings([
      ...existing.blockingIssues,
      ...next.blockingIssues,
    ]);
  } else {
    metrics.reviewFailures.push(next);
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
