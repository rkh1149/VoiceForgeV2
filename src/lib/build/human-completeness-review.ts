import { z } from "zod";
import type { ArchitecturePlan } from "../architecture";
import type { AppSpec } from "../spec";
import type { FileInspection } from "../agents/file-tools";
import type { PostGenerationReview } from "./post-generation-reviews";
import type { FileMap } from "./template";

export const HUMAN_COMPLETENESS_REVIEW_VERSION = 1 as const;
export const HUMAN_COMPLETENESS_MAX_BLOCKING_ISSUES = 5;

export type HumanCompletenessSourceContext = {
  provenance: "linked_conversation" | "legacy_conversation" | "summary_fallback";
  userMessages: string[];
  approvedSummary: string;
  changeSummary: string;
};

export type HumanCompletenessPromiseKind =
  | "original_request"
  | "workflow"
  | "feature"
  | "screen"
  | "search"
  | "file"
  | "notification"
  | "report"
  | "integration"
  | "ai";

export type HumanCompletenessPromise = {
  id: string;
  kind: HumanCompletenessPromiseKind;
  statement: string;
  expectedOutcome: string;
  criticality: "core" | "supporting";
  workflowIds: string[];
};

export type HumanCompletenessEvidence = {
  version: typeof HUMAN_COMPLETENESS_REVIEW_VERSION;
  source: HumanCompletenessSourceContext;
  app: {
    name: string;
    purpose: string;
    targetUsers: string;
    sharingModel: AppSpec["sharingModel"];
    needsLogin: boolean;
  };
  promises: HumanCompletenessPromise[];
  architecture: {
    summary: string;
    pages: Array<{
      route: string;
      name: string;
      purpose: string;
      workflows: string[];
    }>;
    workflows: Array<{
      id: string;
      name: string;
      trigger: "user_action" | "scheduled" | "system";
      roles: string[];
      startRoute: string;
      controls: string[];
      successRoute: string;
      visibleResult: string;
      saves: string[];
      handoffs: string[];
    }>;
  };
  generated: {
    routeFiles: string[];
    sourceFiles: string[];
    testFiles: string[];
    changedFilePaths: string[];
    deletedFilePaths: string[];
    phaseSummaries: Array<{
      phaseId: string;
      label: string;
      filesWritten: string[];
      notes: string;
    }>;
  };
  deterministicReviews: Array<{
    agentKey: string;
    status: string;
    summary: string;
    warnings: string[];
    blockingIssues: string[];
    evidence: string;
  }>;
};

const candidateEvidenceSchema = z.object({
  path: z.string().min(1),
  explanation: z.string().min(1),
});

export const humanCompletenessAssessmentCandidateSchema = z.object({
  promiseId: z.string().min(1),
  verdict: z.enum(["supported", "partially_supported", "missing", "unclear"]),
  confidence: z.enum(["high", "medium", "low"]),
  finding: z.string(),
  userImpact: z.string(),
  repairRecommendation: z.string(),
  workflowIds: z.array(z.string()),
  codeEvidence: z.array(candidateEvidenceSchema),
  testEvidence: z.array(candidateEvidenceSchema),
});

export const humanCompletenessReviewCandidateSchema = z.object({
  overallAssessment: z.string().min(1),
  assessments: z.array(humanCompletenessAssessmentCandidateSchema),
  limitations: z.array(z.string()),
});

export type HumanCompletenessReviewCandidate = z.infer<
  typeof humanCompletenessReviewCandidateSchema
>;

export type HumanCompletenessAssessment = HumanCompletenessPromise & {
  verdict: "supported" | "partially_supported" | "missing" | "unclear";
  confidence: "high" | "medium" | "low";
  finding: string;
  userImpact: string;
  repairRecommendation: string;
  codeEvidence: Array<{ path: string; explanation: string }>;
  testEvidence: Array<{ path: string; explanation: string }>;
};

export type HumanCompletenessReview = {
  version: typeof HUMAN_COMPLETENESS_REVIEW_VERSION;
  available: boolean;
  verdict: "complete" | "complete_with_notes" | "incomplete";
  summary: {
    promisesReviewed: number;
    supported: number;
    partiallySupported: number;
    missing: number;
    unclear: number;
  };
  overallAssessment: string;
  sourceProvenance: HumanCompletenessSourceContext["provenance"];
  assessments: HumanCompletenessAssessment[];
  filesInspected: string[];
  testFilesInspected: string[];
  limitations: string[];
  warnings: string[];
  blockingIssues: string[];
};

export function createHumanCompletenessEvidence(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  files: FileMap;
  source: HumanCompletenessSourceContext;
  changedFilePaths: readonly string[];
  deletedFilePaths: readonly string[];
  phases: ReadonlyArray<{
    id: string;
    label: string;
    filesWritten: string[];
    notes: string;
  }>;
  deterministicReviews: readonly PostGenerationReview[];
}): HumanCompletenessEvidence {
  const source = boundSourceContext(input.source);
  const sourceFiles = Object.keys(input.files)
    .filter((path) =>
      /^(?:src\/(?:app|components|lib)\/|e2e\/generated\/)/.test(path),
    )
    .sort();
  return {
    version: HUMAN_COMPLETENESS_REVIEW_VERSION,
    source,
    app: {
      name: input.spec.appName,
      purpose: input.spec.purpose,
      targetUsers: input.spec.targetUsers,
      sharingModel: input.spec.sharingModel,
      needsLogin: input.spec.needsLogin,
    },
    promises: collectPromises(input.spec, input.architecture, source),
    architecture: {
      summary: input.architecture.summary,
      pages: input.architecture.pageMap.map((page) => ({
        route: page.route,
        name: page.name,
        purpose: page.purpose,
        workflows: [...page.workflows],
      })),
      workflows: input.architecture.workflowContracts.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        trigger: workflow.trigger,
        roles: [...workflow.actor.roles],
        startRoute: workflow.start.route,
        controls: workflow.controls.map((control) => control.accessibleName),
        successRoute: workflow.success.route,
        visibleResult: workflow.success.visibleResult,
        saves: workflow.expectedSaves.map(
          (save) => `${save.operation} ${save.entityKey} via ${save.storage}`,
        ),
        handoffs: workflow.handoffs.map(
          (handoff) =>
            `${handoff.produces} -> ${handoff.consumerWorkflowId} on ${handoff.consumerRoute}`,
        ),
      })),
    },
    generated: {
      routeFiles: sourceFiles.filter((path) =>
        /^src\/app\/(?:.+\/)?page\.tsx$/.test(path),
      ),
      sourceFiles,
      testFiles: sourceFiles.filter((path) =>
        /(?:\.test\.[tj]sx?$|e2e\/generated\/.+\.spec\.[tj]sx?$)/.test(path),
      ),
      changedFilePaths: uniqueStrings([...input.changedFilePaths]).sort(),
      deletedFilePaths: uniqueStrings([...input.deletedFilePaths]).sort(),
      phaseSummaries: input.phases.map((phase) => ({
        phaseId: phase.id,
        label: phase.label,
        filesWritten: [...phase.filesWritten],
        notes: truncate(normalizeText(phase.notes), 1_200),
      })),
    },
    deterministicReviews: input.deterministicReviews.map((review) => ({
      agentKey: review.agentKey,
      status: review.status,
      summary: review.summary,
      warnings: review.warnings.slice(0, 12),
      blockingIssues: review.blockingIssues.slice(0, 12),
      evidence: compactDeterministicReviewEvidence(review),
    })),
  };
}

export function normalizeHumanCompletenessReview(input: {
  evidence: HumanCompletenessEvidence;
  files: FileMap;
  candidate: HumanCompletenessReviewCandidate;
  inspections: readonly FileInspection[];
}): HumanCompletenessReview {
  const inspectedPaths = inspectedFilePaths(input.inspections).filter(
    (path) => input.files[path] !== undefined,
  );
  const inspectedSet = new Set(inspectedPaths);
  const promisesById = new Map(
    input.evidence.promises.map((promise) => [promise.id, promise]),
  );
  const candidateByPromise = new Map(
    input.candidate.assessments
      .filter((assessment) => promisesById.has(assessment.promiseId))
      .map((assessment) => [assessment.promiseId, assessment]),
  );
  const warnings: string[] = [];
  const blockingIssues: string[] = [];

  const assessments = input.evidence.promises.map((promise) => {
    const candidate = candidateByPromise.get(promise.id);
    if (!candidate) {
      warnings.push(
        `human_completeness:${promise.id} The product reviewer did not assess this approved promise. Browser preview should confirm it.`,
      );
      return {
        ...promise,
        verdict: "unclear" as const,
        confidence: "low" as const,
        finding: "The reviewer did not return an assessment for this promise.",
        userImpact: "VoiceForge cannot confirm this promise from the review output.",
        repairRecommendation: "Confirm this promise during browser testing.",
        codeEvidence: [],
        testEvidence: [],
      };
    }

    const codeEvidence = validEvidence(
      candidate.codeEvidence,
      input.files,
      inspectedSet,
      false,
    );
    const testEvidence = validEvidence(
      candidate.testEvidence,
      input.files,
      inspectedSet,
      true,
    );
    const assessment: HumanCompletenessAssessment = {
      ...promise,
      verdict: candidate.verdict,
      confidence: candidate.confidence,
      finding: normalizeText(candidate.finding),
      userImpact: normalizeText(candidate.userImpact),
      repairRecommendation: normalizeText(candidate.repairRecommendation),
      workflowIds: uniqueStrings(
        candidate.workflowIds.filter((workflowId) =>
          promise.workflowIds.includes(workflowId),
        ),
      ),
      codeEvidence,
      testEvidence,
    };
    const evidencePaths = uniqueStrings([
      ...codeEvidence.map((item) => item.path),
      ...testEvidence.map((item) => item.path),
    ]);
    if (candidate.verdict === "supported" && codeEvidence.length === 0) {
      warnings.push(
        `human_completeness:${promise.id} The reviewer marked this promise supported without inspected implementation evidence. Browser preview should confirm it.`,
      );
    }
    const userActionWorkflow =
      promise.kind === "workflow" &&
      promise.workflowIds.some(
        (workflowId) =>
          input.evidence.architecture.workflows.find(
            (workflow) => workflow.id === workflowId,
          )?.trigger === "user_action",
      );
    if (
      candidate.verdict === "supported" &&
      userActionWorkflow &&
      testEvidence.length === 0
    ) {
      warnings.push(
        `human_completeness:${promise.id} The reviewer marked this user workflow supported without inspected generated acceptance-test evidence. Browser execution should confirm it.`,
      );
    }
    const isHighConfidenceCoreGap =
      promise.criticality === "core" &&
      candidate.confidence === "high" &&
      (candidate.verdict === "missing" ||
        candidate.verdict === "partially_supported") &&
      codeEvidence.length > 0 &&
      assessment.finding.length > 0 &&
      assessment.repairRecommendation.length > 0;
    const issue = formatIssue(assessment, evidencePaths);
    if (isHighConfidenceCoreGap) {
      if (blockingIssues.length < HUMAN_COMPLETENESS_MAX_BLOCKING_ISSUES) {
        blockingIssues.push(issue);
      }
    } else if (candidate.verdict !== "supported") {
      warnings.push(issue);
    }
    return assessment;
  });

  const summary = summarizeAssessments(assessments);
  const uniqueBlockingIssues = uniqueStrings(blockingIssues);
  const uniqueWarnings = uniqueStrings(warnings);
  return {
    version: HUMAN_COMPLETENESS_REVIEW_VERSION,
    available: true,
    verdict:
      uniqueBlockingIssues.length > 0
        ? "incomplete"
        : uniqueWarnings.length > 0
          ? "complete_with_notes"
          : "complete",
    summary,
    overallAssessment: truncate(
      normalizeText(input.candidate.overallAssessment),
      1_200,
    ),
    sourceProvenance: input.evidence.source.provenance,
    assessments,
    filesInspected: inspectedPaths,
    testFilesInspected: inspectedPaths.filter((path) =>
      /(?:\.test\.[tj]sx?$|e2e\/generated\/.+\.spec\.[tj]sx?$)/.test(path),
    ),
    limitations: uniqueStrings(
      input.candidate.limitations.map((item) => truncate(normalizeText(item), 500)),
    ),
    warnings: uniqueWarnings,
    blockingIssues: uniqueBlockingIssues,
  };
}

export function unavailableHumanCompletenessReview(input: {
  evidence: HumanCompletenessEvidence;
  reason: string;
}): HumanCompletenessReview {
  const warning = `human_completeness:review_unavailable ${truncate(normalizeText(input.reason), 600)}`;
  return {
    version: HUMAN_COMPLETENESS_REVIEW_VERSION,
    available: false,
    verdict: "complete_with_notes",
    summary: {
      promisesReviewed: 0,
      supported: 0,
      partiallySupported: 0,
      missing: 0,
      unclear: input.evidence.promises.length,
    },
    overallAssessment:
      "The product completeness reviewer was unavailable. Deterministic workflow reviews and browser tests will continue.",
    sourceProvenance: input.evidence.source.provenance,
    assessments: [],
    filesInspected: [],
    testFilesInspected: [],
    limitations: ["No semantic completeness verdict was produced for this build."],
    warnings: [warning],
    blockingIssues: [],
  };
}

export function humanCompletenessReviewSummary(
  report: HumanCompletenessReview,
): string {
  if (!report.available) {
    return "Product completeness review was unavailable; deterministic and browser checks will continue.";
  }
  const label =
    report.verdict === "incomplete"
      ? "needs repair"
      : report.verdict === "complete_with_notes"
        ? "passed with notes"
        : "passed";
  return `Product completeness ${label}: ${report.summary.supported}/${report.summary.promisesReviewed} promises are fully supported, ${report.summary.partiallySupported} are partial, ${report.summary.missing} are missing, and ${report.summary.unclear} need confirmation.`;
}

export function humanCompletenessPostGenerationReview(
  report: HumanCompletenessReview,
): PostGenerationReview {
  return {
    agentKey: "product_completeness_reviewer",
    phaseKey: "human-language-completeness-review",
    artifactType: "human_completeness_review",
    status:
      report.blockingIssues.length > 0
        ? "failed"
        : report.warnings.length > 0
          ? "warning"
          : "passed",
    summary: humanCompletenessReviewSummary(report),
    warnings: report.warnings,
    blockingIssues: report.blockingIssues,
    payload: { ...report },
  };
}

function collectPromises(
  spec: AppSpec,
  architecture: ArchitecturePlan,
  source: HumanCompletenessSourceContext,
): HumanCompletenessPromise[] {
  const promises: HumanCompletenessPromise[] = [];
  const contractByWorkflowName = new Map(
    architecture.workflowContracts.map((contract) => [
      normalizeKey(contract.source.workflowName || contract.name),
      contract,
    ]),
  );

  if (source.userMessages.length > 0) {
    promises.push({
      id: "original_request:approved-experience",
      kind: "original_request",
      statement: "Original requested experience",
      expectedOutcome: source.userMessages.join(" "),
      criticality: "core",
      workflowIds: architecture.workflowContracts.map((contract) => contract.id),
    });
  }
  if (source.changeSummary.trim()) {
    promises.push({
      id: "original_request:approved-change",
      kind: "original_request",
      statement: "Approved application change",
      expectedOutcome: source.changeSummary,
      criticality: "core",
      workflowIds: architecture.workflowContracts.map((contract) => contract.id),
    });
  }

  spec.workflows.forEach((workflow, index) => {
    const contract = contractByWorkflowName.get(normalizeKey(workflow.name));
    promises.push({
      id: `workflow:${contract?.id ?? promiseSlug(workflow.name, index)}`,
      kind: "workflow",
      statement: workflow.name,
      expectedOutcome: workflow.successOutcome,
      criticality: "core",
      workflowIds: contract ? [contract.id] : [],
    });
  });
  spec.features.forEach((feature, index) =>
    promises.push(simplePromise("feature", feature, feature, index, "core")),
  );
  spec.screens.forEach((screen, index) =>
    promises.push(
      simplePromise("screen", screen.name, screen.description, index, "supporting"),
    ),
  );
  spec.searchRequirements.forEach((search, index) =>
    promises.push(
      simplePromise(
        "search",
        `Search and filter ${search.target}`,
        [...search.fields, ...search.filters].join("; "),
        index,
        "core",
      ),
    ),
  );
  spec.fileRequirements.forEach((file, index) =>
    promises.push(
      simplePromise(
        "file",
        file.name,
        `Accept ${file.acceptedTypes.join(", ") || "the planned files"} for ${file.attachedTo}.`,
        index,
        "core",
      ),
    ),
  );
  spec.notifications.forEach((notification, index) =>
    promises.push(
      simplePromise(
        "notification",
        notification.name,
        `${notification.trigger}; notify ${notification.recipients.join(", ")} through ${notification.channel}.`,
        index,
        "core",
      ),
    ),
  );
  spec.reports.forEach((report, index) =>
    promises.push(
      simplePromise(
        "report",
        report.name,
        `${report.description} Export as ${report.exportFormats.join(", ")}.`,
        index,
        "core",
      ),
    ),
  );
  spec.integrations.forEach((integration, index) =>
    promises.push(
      simplePromise(
        "integration",
        integration.name,
        integration.purpose,
        index,
        integration.requiredForLaunch ? "core" : "supporting",
      ),
    ),
  );
  spec.aiFeatures.forEach((feature, index) =>
    promises.push(simplePromise("ai", feature, feature, index, "core")),
  );
  return uniquePromises(promises);
}

function simplePromise(
  kind: Exclude<HumanCompletenessPromiseKind, "workflow" | "original_request">,
  statement: string,
  expectedOutcome: string,
  index: number,
  criticality: HumanCompletenessPromise["criticality"],
): HumanCompletenessPromise {
  return {
    id: `${kind}:${promiseSlug(statement, index)}`,
    kind,
    statement,
    expectedOutcome,
    criticality,
    workflowIds: [],
  };
}

function boundSourceContext(
  source: HumanCompletenessSourceContext,
): HumanCompletenessSourceContext {
  const messages: string[] = [];
  let remaining = 18_000;
  for (const raw of source.userMessages) {
    if (remaining <= 0) break;
    const message = truncate(normalizeText(raw), Math.min(8_000, remaining));
    if (!message) continue;
    messages.push(message);
    remaining -= message.length;
  }
  return {
    provenance: source.provenance,
    userMessages: messages,
    approvedSummary: truncate(normalizeText(source.approvedSummary), 4_000),
    changeSummary: truncate(normalizeText(source.changeSummary), 2_000),
  };
}

function validEvidence(
  evidence: Array<{ path: string; explanation: string }>,
  files: FileMap,
  inspectedPaths: Set<string>,
  requireTest: boolean,
): Array<{ path: string; explanation: string }> {
  return evidence
    .filter(
      (item) =>
        files[item.path] !== undefined &&
        inspectedPaths.has(item.path) &&
        (!requireTest ||
          /(?:\.test\.[tj]sx?$|e2e\/generated\/.+\.spec\.[tj]sx?$)/.test(
            item.path,
          )),
    )
    .map((item) => ({
      path: item.path,
      explanation: truncate(normalizeText(item.explanation), 500),
    }))
    .slice(0, 8);
}

function inspectedFilePaths(inspections: readonly FileInspection[]): string[] {
  return uniqueStrings(
    inspections.flatMap((inspection) =>
      inspection.operation === "list"
        ? []
        : [
            ...(inspection.path ? [inspection.path] : []),
            ...(inspection.matchedPaths ?? []),
          ],
    ),
  ).sort();
}

function summarizeAssessments(
  assessments: readonly HumanCompletenessAssessment[],
): HumanCompletenessReview["summary"] {
  return {
    promisesReviewed: assessments.length,
    supported: assessments.filter((item) => item.verdict === "supported").length,
    partiallySupported: assessments.filter(
      (item) => item.verdict === "partially_supported",
    ).length,
    missing: assessments.filter((item) => item.verdict === "missing").length,
    unclear: assessments.filter((item) => item.verdict === "unclear").length,
  };
}

function formatIssue(
  assessment: HumanCompletenessAssessment,
  evidencePaths: readonly string[],
): string {
  const finding = assessment.finding || `${assessment.statement} needs confirmation.`;
  const repair = assessment.repairRecommendation
    ? ` Repair: ${assessment.repairRecommendation}`
    : "";
  const evidence =
    evidencePaths.length > 0 ? ` Evidence: ${evidencePaths.join(", ")}.` : "";
  return `human_completeness:${assessment.id} ${finding}${evidence}${repair}`;
}

function uniquePromises(
  promises: readonly HumanCompletenessPromise[],
): HumanCompletenessPromise[] {
  const byId = new Map<string, HumanCompletenessPromise>();
  for (const promise of promises) {
    let id = promise.id;
    let suffix = 2;
    while (byId.has(id)) id = `${promise.id}-${suffix++}`;
    byId.set(id, { ...promise, id });
  }
  return [...byId.values()];
}

function compactDeterministicReviewEvidence(
  review: PostGenerationReview,
): string {
  const keys =
    review.agentKey === "ui_affordance_reviewer"
      ? [
          "summary",
          "workflows",
          "entities",
          "hiddenRoutes",
          "placeholderRoutes",
          "vagueControls",
        ]
      : review.agentKey === "persistence_handoff_reviewer"
        ? ["summary", "saves", "reloads", "handoffs"]
        : review.agentKey === "acceptance_test_reviewer"
          ? ["summary", "generatedTestFiles", "journeys"]
          : [
              "changedFileCount",
              "pageFiles",
              "missingPageFiles",
              "unitTestFiles",
              "browserTestFiles",
            ];
  const selected = Object.fromEntries(
    keys.filter((key) => key in review.payload).map((key) => [key, review.payload[key]]),
  );
  return truncate(JSON.stringify(selected), 6_000);
}

function promiseSlug(value: string, index: number): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || `promise-${index + 1}`
  );
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
