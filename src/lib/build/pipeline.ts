import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import {
  architecturePlans,
  type App,
  apps,
  buildRuns,
  changeRequests,
  deployments,
  type Requirement,
  requirements,
  testResults,
} from "@/db/schema";
import {
  computeSpecComplexity,
  normalizeAppSpec,
  type AppSpec,
} from "@/lib/spec";
import { runArchitectAgent } from "@/lib/agents/architect";
import {
  createFallbackArchitecturePlan,
  validateArchitecturePlan,
  type ArchitecturePlan,
} from "@/lib/architecture";
import { audit } from "@/lib/audit";
import {
  runCodeAgent,
  runChangeCodeAgent,
  runDebugAgent,
  type CodegenResult,
} from "@/lib/agents/coder";
import { runHumanCompletenessReviewer } from "@/lib/agents/completeness-reviewer";
import { selectChangeWorkflow } from "@/lib/agents/change-workflow";
import {
  canUsePlatformDataStarter,
  generatePlatformDataStarterApp,
} from "@/lib/agents/platform-data-starter";
import {
  createRepoIfMissing,
  createBranch,
  commitFiles,
  getRepoSrcFiles,
} from "@/lib/github";
import {
  ensureProject,
  createDeployment,
  setProjectEnvVars,
} from "@/lib/vercel";
import { getGeneratedAppName } from "@/lib/generated-apps";
import { sendVoiceForgeBuildNotification } from "@/lib/platform/notifications";
import {
  seedPlatformEntitySchemasFromSpec,
  seedPlatformSearchConfigsFromSpec,
} from "@/lib/platform/spec-seeding";
import { randomBytes } from "crypto";
import {
  createDebugBudget,
  hydrateDebugBudget,
  recordDebugAttempt,
  reserveDebugRound,
  serializeDebugBudget,
  type DebugBudget,
  type SerializedDebugBudget,
} from "./debug-budget";
import {
  buildMetricsArtifactStatus,
  buildMetricsPayload,
  categorizeBuildFailure,
  createBuildMetrics,
  recordDebugRoundMetric,
  recordGeneratedPhaseMetrics,
  recordReviewMetrics,
  recordWorkflowRepairMetric,
  setBuildFailureCategory,
  summarizeBuildMetrics,
  type BuildMetrics,
} from "./build-metrics";
import { recordBuildAgentArtifact } from "./agent-artifacts";
import {
  artifactStatusFromIssues,
  summarizeArtifactFiles,
} from "./agent-artifact-utils";
import { runPlanningSpecialistReviews } from "./planning-specialists";
import {
  assessPostGenerationRepair,
  createPostGenerationRepairEvidence,
  getPostGenerationBlockingIssues,
  selectPostGenerationRepairBatch,
  type PostGenerationReview,
  runPostGenerationReviews,
} from "./post-generation-reviews";
import { createPhaseAwareDebugPlan } from "./phase-aware-debug";
import {
  compareFailureFingerprints,
  createFailureFingerprint,
  restoreFileMap,
  shouldEscalateDebugScope,
  type FailureFingerprint,
  type FailureProgress,
} from "./debug-progress";
import { validateGeneratedAppDependencies } from "./dependencies";
import {
  isBuildCheckpointCompatible,
  loadBuildCheckpointById,
  loadLatestBuildCheckpoint,
  saveBuildCheckpoint,
} from "./checkpoints";
import {
  isAgentWritablePath,
  loadTemplate,
  refreshResumedTemplateFiles,
  type FileMap,
} from "./template";
import { createRunner, type Runner, type StepName } from "./runner";
import {
  ensureWorkflowContracts,
  validateWorkflowContracts,
} from "../workflow-contract";
import {
  createHumanCompletenessEvidence,
  humanCompletenessPostGenerationReview,
  type HumanCompletenessSourceContext,
} from "./human-completeness-review";
import { loadHumanCompletenessSourceContext } from "./human-completeness-source";
import {
  assessWorkflowRepairCandidate,
  createWorkflowRepairPackage,
  isWorkflowLinkedFailure,
  restoreWorkflowRepairPackages,
  selectWorkflowRepairIssueCluster,
  validateWorkflowRepairMutationScope,
  type WorkflowRepairPackage,
} from "./workflow-repair";
import {
  applyDeterministicAcceptanceCompiler,
  refreshDeterministicAcceptanceCompiler,
} from "./acceptance-compiler";

/**
 * Build pipeline (Stage 2): approved spec -> generated code -> local test
 * gauntlet with a bounded debug loop -> GitHub repo with a passing commit.
 * All state lives in the database so the UI can poll it.
 */

type PipelineStepName = StepName | "dependencies";

const STEP_ORDER: PipelineStepName[] = [
  "install",
  "dependencies",
  "typecheck",
  "lint",
  "test",
  "build",
  "e2e",
];
const MAX_DEBUG_ROUNDS_PER_STEP = 5;
const MAX_TOTAL_DEBUG_ROUNDS = 12;
const VERCEL_WORKER_RESUME_AFTER_MS = 315_000;
const LOCAL_WORKER_RESUME_AFTER_MS = 15 * 60_000;

type StoredCodegenResult = Pick<
  CodegenResult,
  "deletedFiles" | "filesWritten" | "notes" | "phases"
>;

type DurableBuildMetadata = {
  generated: StoredCodegenResult;
  debugBudget: SerializedDebugBudget;
  debugProgress?: SerializedDebugProgress;
  reviewProgress?: SerializedReviewProgress;
  metrics: BuildMetrics;
  seededPlatformEntities: unknown[];
  workflowRepairs?: WorkflowRepairPackage[];
};

type SerializedReviewProgress = {
  changedFilePaths: string[];
  deletedFilePaths: string[];
  unchangedRoundsByDomain: Record<string, number>;
  changeMode: boolean;
};

type SerializedDebugProgress = {
  ineffectiveRoundsByStep: Record<string, number>;
  lastProgressByStep: Record<string, FailureProgress>;
};

type PendingDebugFix = {
  step: PipelineStepName;
  beforeFiles: FileMap;
  beforeFingerprint: FailureFingerprint;
  filesWritten: string[];
  filesDeleted: string[];
  stepRound: number;
};

class ArchitectureBlockedError extends Error {
  constructor(
    message: string,
    public readonly blockingIssues: string[],
  ) {
    super(message);
    this.name = "ArchitectureBlockedError";
  }
}

const SUITE_FOR_STEP: Record<
  PipelineStepName,
  "typecheck" | "lint" | "unit" | "build" | "e2e" | "security"
> = {
  install: "build",
  dependencies: "security",
  typecheck: "typecheck",
  lint: "lint",
  test: "unit",
  build: "build",
  e2e: "e2e",
};

type LogEntry = { ts: string; message: string };

type RunWithLogs = {
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  logs: unknown;
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function serializeReviewEvidence(evidence: Record<string, unknown>): string {
  const serialized = JSON.stringify(evidence, null, 2);
  const limit = 24_000;
  return serialized.length <= limit
    ? serialized
    : `${serialized.slice(0, limit)}\n... structured evidence truncated at ${limit} characters`;
}

function durableMetadata(input: {
  generated: CodegenResult;
  debugBudget: DebugBudget;
  debugProgress?: SerializedDebugProgress;
  reviewProgress?: SerializedReviewProgress;
  metrics: BuildMetrics;
  seededPlatformEntities: unknown[];
  workflowRepairs?: WorkflowRepairPackage[];
}): Record<string, unknown> {
  const metadata: DurableBuildMetadata = {
    generated: {
      deletedFiles: input.generated.deletedFiles,
      filesWritten: input.generated.filesWritten,
      notes: input.generated.notes,
      phases: input.generated.phases,
    },
    debugBudget: serializeDebugBudget(input.debugBudget),
    debugProgress: input.debugProgress,
    reviewProgress: input.reviewProgress,
    metrics: input.metrics,
    seededPlatformEntities: input.seededPlatformEntities,
    workflowRepairs: input.workflowRepairs ?? [],
  };
  return metadata as unknown as Record<string, unknown>;
}

function restoreGeneratedResult(value: unknown): CodegenResult {
  const generated = isRecord(value) ? value : {};
  return {
    files: {},
    deletedFiles: stringArray(generated.deletedFiles),
    notes: typeof generated.notes === "string" ? generated.notes : "",
    filesWritten: stringArray(generated.filesWritten),
    phases: Array.isArray(generated.phases)
      ? (generated.phases as CodegenResult["phases"])
      : [],
    operations: [],
  };
}

function restoreBuildMetrics(value: unknown): BuildMetrics {
  const base = createBuildMetrics();
  if (!isRecord(value)) return base;
  return {
    generatedFilesByPhase: Array.isArray(value.generatedFilesByPhase)
      ? (value.generatedFilesByPhase as BuildMetrics["generatedFilesByPhase"])
      : base.generatedFilesByPhase,
    reviewWarnings: Array.isArray(value.reviewWarnings)
      ? (value.reviewWarnings as BuildMetrics["reviewWarnings"])
      : base.reviewWarnings,
    reviewFailures: Array.isArray(value.reviewFailures)
      ? (value.reviewFailures as BuildMetrics["reviewFailures"])
      : base.reviewFailures,
    debugRounds: Array.isArray(value.debugRounds)
      ? (value.debugRounds as BuildMetrics["debugRounds"])
      : base.debugRounds,
    debugRoundsByStep: isRecord(value.debugRoundsByStep)
      ? (value.debugRoundsByStep as BuildMetrics["debugRoundsByStep"])
      : base.debugRoundsByStep,
    acceptanceJourneyCoverage: isRecord(value.acceptanceJourneyCoverage)
      ? (value.acceptanceJourneyCoverage as BuildMetrics["acceptanceJourneyCoverage"])
      : base.acceptanceJourneyCoverage,
    humanCompletenessCoverage: isRecord(value.humanCompletenessCoverage)
      ? (value.humanCompletenessCoverage as BuildMetrics["humanCompletenessCoverage"])
      : base.humanCompletenessCoverage,
    workflowRepairs: Array.isArray(value.workflowRepairs)
      ? (value.workflowRepairs as BuildMetrics["workflowRepairs"])
      : base.workflowRepairs,
    failureCategory:
      typeof value.failureCategory === "string"
        ? (value.failureCategory as BuildMetrics["failureCategory"])
        : null,
  };
}

function restoreDebugBudget(value: unknown): DebugBudget {
  return hydrateDebugBudget(
    isSerializedDebugBudget(value) ? value : undefined,
    {
      maxRoundsPerStep: MAX_DEBUG_ROUNDS_PER_STEP,
      maxTotalRounds: MAX_TOTAL_DEBUG_ROUNDS,
    },
  );
}

function restoreDebugProgress(value: unknown): SerializedDebugProgress {
  if (!isRecord(value)) {
    return { ineffectiveRoundsByStep: {}, lastProgressByStep: {} };
  }
  const ineffectiveRoundsByStep = isRecord(value.ineffectiveRoundsByStep)
    ? Object.fromEntries(
        Object.entries(value.ineffectiveRoundsByStep).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ),
      )
    : {};
  const lastProgressByStep = isRecord(value.lastProgressByStep)
    ? (value.lastProgressByStep as Record<string, FailureProgress>)
    : {};
  return { ineffectiveRoundsByStep, lastProgressByStep };
}

function restoreReviewProgress(
  value: unknown,
  generated: CodegenResult,
  changeMode: boolean,
): SerializedReviewProgress {
  if (!isRecord(value)) {
    return {
      changedFilePaths: [...generated.filesWritten],
      deletedFilePaths: [...generated.deletedFiles],
      unchangedRoundsByDomain: {},
      changeMode,
    };
  }
  const unchangedRoundsByDomain = isRecord(value.unchangedRoundsByDomain)
    ? Object.fromEntries(
        Object.entries(value.unchangedRoundsByDomain).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ),
      )
    : {};
  const originallyGeneratedPaths = new Set([
    ...generated.filesWritten,
    ...generated.deletedFiles,
  ]);
  const changedFilePaths = stringArray(value.changedFilePaths).filter(
    (path) =>
      originallyGeneratedPaths.has(path) || isAgentWritablePath(path).ok,
  );
  return {
    // Older resumable checkpoints briefly recorded the complete template as
    // changed. Remove protected/template-only paths unless the generator
    // actually reported touching them, so a resume cannot manufacture review
    // findings from unchanged platform files.
    changedFilePaths,
    deletedFilePaths: stringArray(value.deletedFilePaths),
    unchangedRoundsByDomain,
    changeMode:
      typeof value.changeMode === "boolean" ? value.changeMode : changeMode,
  };
}

function restoreSeededPlatformEntities(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isSerializedDebugBudget(
  value: unknown,
): value is SerializedDebugBudget {
  return (
    isRecord(value) &&
    typeof value.maxRoundsPerStep === "number" &&
    typeof value.maxTotalRounds === "number" &&
    typeof value.totalRounds === "number" &&
    isRecord(value.roundsByStep) &&
    isRecord(value.notesByStep)
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastLogDate(run: RunWithLogs): Date {
  const logs = Array.isArray(run.logs) ? (run.logs as LogEntry[]) : [];
  const last = logs.at(-1)?.ts;
  const date = last ? new Date(last) : run.startedAt ?? run.createdAt;
  return Number.isNaN(date.getTime()) ? run.startedAt ?? run.createdAt : date;
}

function shouldResumeAbandonedWorker(run: RunWithLogs): boolean {
  const now = Date.now();
  const startedAt = run.startedAt ?? run.createdAt;
  const resumeAfter = process.env.VERCEL
    ? VERCEL_WORKER_RESUME_AFTER_MS
    : LOCAL_WORKER_RESUME_AFTER_MS;
  return (
    startedAt.getTime() <= now - resumeAfter &&
    lastLogDate(run).getTime() <= now - 30_000
  );
}

async function log(buildRunId: string, message: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ logs: buildRuns.logs })
    .from(buildRuns)
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  const logs = (rows[0]?.logs ?? []) as LogEntry[];
  logs.push({ ts: new Date().toISOString(), message });
  await db
    .update(buildRuns)
    .set({ logs })
    .where(eq(buildRuns.id, buildRunId));
  console.log(`[build ${buildRunId.slice(0, 8)}] ${message}`);
}

async function setStatus(
  buildRunId: string,
  status:
    | "generating"
    | "testing"
    | "debugging"
    | "deploying"
    | "awaiting_user_test"
    | "complete"
    | "failed"
    | "needs_input",
  extra: Partial<{
    errorMessage: string | null;
    commitSha: string;
    branch: string;
    startedAt: Date;
    finishedAt: Date;
  }> = {},
): Promise<void> {
  const db = getDb();
  const errorMessage =
    status === "failed" || status === "needs_input"
      ? extra.errorMessage
      : null;
  await db
    .update(buildRuns)
    .set({ status, errorMessage, ...extra })
    .where(eq(buildRuns.id, buildRunId));
}

function agentVisibleFiles(files: FileMap): FileMap {
  return Object.fromEntries(
    Object.entries(files).filter(
      ([p]) =>
        p.startsWith("src/") ||
        p.startsWith("e2e/") ||
        [
          "package.json",
          "tsconfig.json",
          "next.config.ts",
          "playwright.config.ts",
          "vitest.config.ts",
          "vitest.setup.ts",
        ].includes(p),
    ),
  );
}

function applyCodegenResult(files: FileMap, result: CodegenResult): void {
  for (const deleted of result.deletedFiles) {
    delete files[deleted];
  }
  Object.assign(files, result.files);
}

async function recordPostGenerationReviewArtifacts(input: {
  appId: string;
  buildRunId: string;
  reviews: readonly PostGenerationReview[];
  rerunRound?: number;
}): Promise<void> {
  for (const review of input.reviews) {
    await recordBuildAgentArtifact({
      appId: input.appId,
      buildRunId: input.buildRunId,
      agentKey: review.agentKey,
      phaseKey:
        input.rerunRound === undefined
          ? review.phaseKey
          : `${review.phaseKey}-rerun-${input.rerunRound}`,
      artifactType: review.artifactType,
      status: review.status,
      summary: review.summary,
      payload: {
        ...review.payload,
        ...(input.rerunRound === undefined
          ? {}
          : { rerunRound: input.rerunRound }),
      },
    });
  }

  const interfaceReview = input.reviews.find(
    (review) => review.agentKey === "ui_affordance_reviewer",
  );
  if (interfaceReview) {
    await log(input.buildRunId, interfaceReview.summary);
  }
  const persistenceReview = input.reviews.find(
    (review) => review.agentKey === "persistence_handoff_reviewer",
  );
  if (persistenceReview) {
    await log(input.buildRunId, persistenceReview.summary);
  }
}

async function recordBuildMetricsArtifact(input: {
  appId: string;
  buildRunId: string;
  metrics: BuildMetrics;
}): Promise<void> {
  await recordBuildAgentArtifact({
    appId: input.appId,
    buildRunId: input.buildRunId,
    agentKey: "pipeline_observer",
    phaseKey: "build-metrics",
    artifactType: "metrics",
    status: buildMetricsArtifactStatus(input.metrics),
    summary: summarizeBuildMetrics(input.metrics),
    payload: buildMetricsPayload(input.metrics),
  });
}

function upsertWorkflowRepair(
  repairs: WorkflowRepairPackage[],
  repair: WorkflowRepairPackage,
): void {
  const index = repairs.findIndex((candidate) => candidate.id === repair.id);
  if (index >= 0) repairs[index] = repair;
  else repairs.push(repair);
}

function workflowRepairVisibleFiles(
  files: FileMap,
  repair: WorkflowRepairPackage,
): FileMap {
  const visible = new Set([
    ...repair.scope.inspectionPaths,
    ...repair.scope.mutationPaths,
  ]);
  return Object.fromEntries(
    Object.entries(files).filter(([path]) => visible.has(path)),
  );
}

function workflowRepairOwnsFailure(
  repair: WorkflowRepairPackage,
  fingerprint: FailureFingerprint,
): boolean {
  const latestAttempt = repair.attempts.at(-1);
  const changedPaths = new Set([
    ...(latestAttempt?.filesWritten ?? []),
    ...(latestAttempt?.filesDeleted ?? []),
  ]);
  const sourcePaths = fingerprint.sourceLocations.map((location) =>
    location.replace(/:\d+(?::\d+)?$/, ""),
  );
  if (sourcePaths.some((path) => changedPaths.has(path))) return true;

  const failureText = [
    ...fingerprint.failedTests,
    ...fingerprint.stableKeys,
  ].join("\n");
  if (
    repair.target.journeyId &&
    failureText.includes(repair.target.journeyId)
  ) {
    return true;
  }
  return [...changedPaths].some(
    (path) =>
      path.startsWith("e2e/generated/") && failureText.includes(path),
  );
}

function workflowFocusedFailureFingerprint(
  fingerprint: FailureFingerprint,
  journeyId: string,
): FailureFingerprint {
  if (!journeyId) return fingerprint;
  const failedTests = fingerprint.failedTests.filter((test) =>
    test.includes(journeyId),
  );
  const cases = fingerprint.cases.filter((failureCase) =>
    failureCase.id.includes(journeyId),
  );
  if (failedTests.length === 0 && cases.length === 0) return fingerprint;
  const stableKeys =
    failedTests.length > 0 ? failedTests : cases.map((item) => item.id);
  return {
    ...fingerprint,
    failedTests,
    cases,
    stableKeys,
    summary: `${stableKeys.length} focused failure key(s): ${stableKeys.join(" | ")}`,
  };
}

async function recordWorkflowRepairArtifact(input: {
  appId: string;
  buildRunId: string;
  repair: WorkflowRepairPackage;
  metrics: BuildMetrics;
  summary: string;
}): Promise<void> {
  const latestAttempt = input.repair.attempts.at(-1);
  recordWorkflowRepairMetric(input.metrics, {
    repairId: input.repair.id,
    classification: input.repair.classification.category,
    targetSurface: input.repair.classification.targetSurface,
    outcome: input.repair.status,
    filesChanged: uniqueStrings([
      ...(latestAttempt?.filesWritten ?? []),
      ...(latestAttempt?.filesDeleted ?? []),
    ]),
  });
  await recordBuildAgentArtifact({
    appId: input.appId,
    buildRunId: input.buildRunId,
    agentKey: "workflow_repair_agent",
    phaseKey: input.repair.id,
    artifactType: "workflow_repair",
    status:
      input.repair.status === "accepted"
        ? "passed"
        : input.repair.status === "rolled_back"
          ? "failed"
          : "warning",
    summary: input.summary,
    payload: input.repair as unknown as Record<string, unknown>,
  });
}

function shouldUseArchitectAgent(): boolean {
  const mode = process.env.VOICEFORGE_ARCHITECT_MODE;
  if (mode === "agent") return true;
  if (mode === "fallback") return false;
  // Vercel Hobby has a hard 300s function ceiling. The deterministic
  // architecture plan preserves the capability gate and saves enough time for
  // the hosted build/test/commit/deploy pipeline to complete reliably.
  return !process.env.VERCEL;
}

function shouldUsePlatformDataStarterGenerator(): boolean {
  const mode = process.env.VOICEFORGE_PLATFORM_DATA_GENERATOR;
  if (mode === "agent") return false;
  if (mode === "starter") return true;
  return Boolean(process.env.VERCEL);
}

function architectureUsesPlatformData(architecture: ArchitecturePlan): boolean {
  return (
    architecture.platformServices.some(
      (service) =>
        service.service === "data" &&
        service.required &&
        service.availability === "available",
    ) ||
    architecture.dataModel.some((entity) => entity.storage === "platformData")
  );
}

function architectureUsesPlatformFiles(architecture: ArchitecturePlan): boolean {
  return architecture.platformServices.some(
    (service) =>
      service.service === "files" &&
      service.required &&
      service.availability === "available",
  );
}

function architectureUsesPlatformNotifications(
  architecture: ArchitecturePlan,
): boolean {
  return architecture.platformServices.some(
    (service) =>
      (service.service === "email" || service.service === "jobs") &&
      service.required &&
      service.availability === "available",
  );
}

function architectureUsesPlatformIntegrations(
  architecture: ArchitecturePlan,
): boolean {
  return architecture.platformServices.some(
    (service) =>
      service.service === "integrations" &&
      service.required &&
      service.availability === "available",
  );
}

function architectureUsesPlatformSearchReports(
  architecture: ArchitecturePlan,
): boolean {
  return architecture.platformServices.some(
    (service) =>
      (service.service === "search" || service.service === "reports") &&
      service.required &&
      service.availability === "available",
  );
}

/**
 * Runs the full pipeline. Call without awaiting from request handlers:
 *   void startBuildPipeline(id).catch(...)
 */
export async function startBuildPipeline(buildRunId: string): Promise<void> {
  const db = getDb();

  const [run] = await db
    .select()
    .from(buildRuns)
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  if (!run) throw new Error(`Build run ${buildRunId} not found`);

  const [app] = await db
    .select()
    .from(apps)
    .where(eq(apps.id, run.appId))
    .limit(1);
  if (!app) throw new Error(`App ${run.appId} not found`);

  const [requirement] = run.requirementId
    ? await db
        .select()
        .from(requirements)
        .where(eq(requirements.id, run.requirementId))
        .limit(1)
    : [];
  if (!requirement) throw new Error(`Requirement missing for build ${buildRunId}`);

  const spec = normalizeAppSpec(requirement.spec);
  const complexity = computeSpecComplexity(spec);
  const metrics = createBuildMetrics();

  try {
    await setStatus(buildRunId, "generating", { startedAt: new Date() });
    await db
      .update(apps)
      .set({ status: "building", updatedAt: new Date() })
      .where(eq(apps.id, app.id));
    await audit({
      userId: app.ownerId,
      appId: app.id,
      buildRunId,
      action: "build.started",
      payload: {
        requirementVersion: requirement.version,
        complexity,
      },
    });

    await log(buildRunId, "Creating architecture plan…");
    const usedArchitectAgent = shouldUseArchitectAgent();
    let architecture = ensureWorkflowContracts(
      spec,
      usedArchitectAgent
        ? await runArchitectAgent({ spec, complexity })
        : createFallbackArchitecturePlan(spec, complexity),
    );
    let workflowContractValidation = validateWorkflowContracts(
      spec,
      architecture,
    );
    if (
      usedArchitectAgent &&
      workflowContractValidation.blockingIssues.length > 0
    ) {
      await log(
        buildRunId,
        "Refining incomplete workflow contracts before code generation…",
      );
      architecture = ensureWorkflowContracts(
        spec,
        await runArchitectAgent({
          spec,
          complexity,
          workflowContractFeedback:
            workflowContractValidation.blockingIssues,
        }),
      );
      workflowContractValidation = validateWorkflowContracts(
        spec,
        architecture,
      );
    }
    const architectureValidation = validateArchitecturePlan(architecture, spec);
    const planningReviews = runPlanningSpecialistReviews({
      spec,
      architecture,
      architectureValidation,
    });
    recordReviewMetrics(metrics, planningReviews);
    const planningBlockingIssues = uniqueStrings(
      planningReviews.flatMap((review) => review.blockingIssues),
    );
    const planningWarnings = uniqueStrings(
      planningReviews.flatMap((review) => review.warnings),
    );
    const combinedArchitectureValidation = {
      canBuildNow:
        architectureValidation.canBuildNow &&
        planningBlockingIssues.length === 0 &&
        workflowContractValidation.blockingIssues.length === 0,
      blockingIssues: uniqueStrings([
        ...architectureValidation.blockingIssues,
        ...planningBlockingIssues,
        ...workflowContractValidation.blockingIssues,
      ]),
      warnings: uniqueStrings([
        ...architectureValidation.warnings,
        ...planningWarnings,
        ...workflowContractValidation.warnings,
      ]),
    };
    const architectureForStorage = {
      ...architecture,
      capabilityValidation: {
        ...architecture.capabilityValidation,
        canBuildNow: combinedArchitectureValidation.canBuildNow,
        blockingIssues: combinedArchitectureValidation.blockingIssues,
        warnings: combinedArchitectureValidation.warnings,
      },
    };

    await db.insert(architecturePlans).values({
      appId: app.id,
      requirementId: requirement.id,
      buildRunId,
      capabilityTier: architectureForStorage.implementationTier,
      complexityScore: architectureForStorage.complexityScore,
      canBuildNow: combinedArchitectureValidation.canBuildNow,
      summary: architectureForStorage.summary,
      plan: architectureForStorage,
    });
    await audit({
      userId: app.ownerId,
      appId: app.id,
      buildRunId,
      action: "architecture.created",
      payload: {
        requestedTier: architectureForStorage.requestedTier,
        implementationTier: architectureForStorage.implementationTier,
        complexityScore: architectureForStorage.complexityScore,
        canBuildNow: combinedArchitectureValidation.canBuildNow,
        blockingIssues: combinedArchitectureValidation.blockingIssues,
        warnings: combinedArchitectureValidation.warnings,
        workflowContractVersion: architectureForStorage.workflowContractVersion,
        workflowContractStats: workflowContractValidation.stats,
      },
    });
    await recordBuildAgentArtifact({
      appId: app.id,
      buildRunId,
      agentKey: usedArchitectAgent ? "architect" : "fallback_architect",
      phaseKey: "architecture",
      artifactType: "plan",
      status: artifactStatusFromIssues({
        failed: !combinedArchitectureValidation.canBuildNow,
        warnings: combinedArchitectureValidation.warnings,
      }),
      summary: architectureForStorage.summary,
      payload: {
        requestedTier: architectureForStorage.requestedTier,
        implementationTier: architectureForStorage.implementationTier,
        complexityScore: architectureForStorage.complexityScore,
        canBuildNow: combinedArchitectureValidation.canBuildNow,
        blockingIssues: combinedArchitectureValidation.blockingIssues,
        warnings: combinedArchitectureValidation.warnings,
        pages: architectureForStorage.pageMap.length,
        components: architectureForStorage.componentMap.length,
        dataEntities: architectureForStorage.dataModel.length,
        platformServices: architectureForStorage.platformServices,
        workflowContractVersion: architectureForStorage.workflowContractVersion,
        workflowContractStats: workflowContractValidation.stats,
      },
    });
    await recordBuildAgentArtifact({
      appId: app.id,
      buildRunId,
      agentKey: "workflow_contract_planner",
      phaseKey: "workflow-contracts",
      artifactType: "workflow_contract",
      status: artifactStatusFromIssues({
        failed: workflowContractValidation.blockingIssues.length > 0,
        warnings: workflowContractValidation.warnings,
      }),
      summary: `${workflowContractValidation.stats.workflows} promised workflow(s), ${workflowContractValidation.stats.steps} user step(s), ${workflowContractValidation.stats.savedRecordTransitions} saved-record transition(s), and ${workflowContractValidation.stats.handoffs} downstream handoff(s).`,
      payload: {
        version: architectureForStorage.workflowContractVersion,
        stats: workflowContractValidation.stats,
        blockingIssues: workflowContractValidation.blockingIssues,
        warnings: workflowContractValidation.warnings,
        workflows: architectureForStorage.workflowContracts.map((contract) => ({
          id: contract.id,
          name: contract.name,
          roles: contract.actor.roles,
          start: contract.start,
          controls: contract.controls.map((control) => control.accessibleName),
          saves: contract.expectedSaves.map((save) => ({
            entityKey: save.entityKey,
            operation: save.operation,
            storage: save.storage,
          })),
          handoffs: contract.handoffs.map((handoff) => ({
            produces: handoff.produces,
            consumerWorkflowId: handoff.consumerWorkflowId,
            consumerRoute: handoff.consumerRoute,
          })),
        })),
      },
    });
    for (const review of planningReviews) {
      await recordBuildAgentArtifact({
        appId: app.id,
        buildRunId,
        agentKey: review.agentKey,
        phaseKey: review.phaseKey,
        artifactType: review.artifactType,
        status: review.status,
        summary: review.summary,
        payload: review.payload,
      });
    }
    await log(buildRunId, `Architecture: ${architectureForStorage.summary}`);
    await log(
      buildRunId,
      `Workflow contracts ready: ${workflowContractValidation.stats.workflows} workflows, ${workflowContractValidation.stats.steps} user steps, ${workflowContractValidation.stats.savedRecordTransitions} saved-record transitions, and ${workflowContractValidation.stats.handoffs} cross-workflow handoffs.`,
    );
    if (combinedArchitectureValidation.warnings.length > 0) {
      await log(
        buildRunId,
        `Architecture warnings: ${combinedArchitectureValidation.warnings.join(" ")}`,
      );
    }
    if (!combinedArchitectureValidation.canBuildNow) {
      const workflowContractOnly =
        combinedArchitectureValidation.blockingIssues.length > 0 &&
        combinedArchitectureValidation.blockingIssues.every((issue) =>
          issue.startsWith("workflow_contract:"),
        );
      throw new ArchitectureBlockedError(
        workflowContractOnly
          ? `VoiceForge could not produce a complete workflow plan yet: ${combinedArchitectureValidation.blockingIssues.join(" ")}`
          : `This app needs planning or platform capabilities that are not available in VoiceForge V2 yet: ${combinedArchitectureValidation.blockingIssues.join(" ")}`,
        combinedArchitectureValidation.blockingIssues,
      );
    }

    const usesPlatformData = architectureUsesPlatformData(architectureForStorage);
    const usesPlatformSearchReports =
      architectureUsesPlatformSearchReports(architectureForStorage);
    let seededPlatformEntities: Awaited<
      ReturnType<typeof seedPlatformEntitySchemasFromSpec>
    > = [];
    if (usesPlatformData) {
      await log(buildRunId, "Seeding platform data schemas…");
      const seededEntities = await seedPlatformEntitySchemasFromSpec(db, {
        appId: app.id,
        user: { id: app.ownerId, role: "user" },
        spec,
      });
      seededPlatformEntities = seededEntities;
      await audit({
        userId: app.ownerId,
        appId: app.id,
        buildRunId,
        action: "platformData.schemasSeeded",
        payload: {
          entities: seededEntities.map((entity) => entity.key),
        },
      });
      await log(
        buildRunId,
        `Platform data schemas ready: ${seededEntities.map((entity) => entity.key).join(", ") || "none"}.`,
      );
      if (usesPlatformSearchReports) {
        const configs = await seedPlatformSearchConfigsFromSpec(db, {
          appId: app.id,
          user: { id: app.ownerId, role: "user" },
          spec,
        });
        await audit({
          userId: app.ownerId,
          appId: app.id,
          buildRunId,
          action: "platformData.searchConfigsSeeded",
          payload: {
            entities: configs.map((config) => config.entityKey),
          },
        });
        await log(
          buildRunId,
          `Platform search/report configs ready: ${configs.map((config) => config.entityKey).join(", ") || "none"}.`,
        );
      }
    }

    // Change mode: the app was built before, so modify its current code.
    const changeMode = Boolean(app.githubRepoUrl && requirement.version > 1);
    const [changeRequest] = changeMode
      ? await db
          .select()
          .from(changeRequests)
          .where(eq(changeRequests.requirementId, requirement.id))
          .limit(1)
      : [];
    const priorFailedChangeCount = changeMode
      ? (
          await db
            .select({ id: changeRequests.id })
            .from(changeRequests)
            .where(
              and(
                eq(changeRequests.appId, app.id),
                eq(changeRequests.status, "failed"),
              ),
            )
            .limit(10)
        ).length
      : 0;

    // 1. Assemble files: locked (always-fresh) template + app code.
    await log(buildRunId, "Loading app template…");
    const files = await loadTemplate({
      slug: app.slug,
      name: app.name,
      purpose: spec.purpose,
    });

    let generated: CodegenResult;
    if (changeMode) {
      await log(buildRunId, "Fetching the app's current code from GitHub…");
      const repoName = getGeneratedAppName(app.slug);
      const repo = await createRepoIfMissing({
        name: repoName,
        description: app.description ?? app.name,
        userId: app.ownerId,
        appId: app.id,
      });
      const [sourceRun] = await db
        .select({ branch: buildRuns.branch, status: buildRuns.status })
        .from(buildRuns)
        .where(
          and(
            eq(buildRuns.appId, app.id),
            ne(buildRuns.id, buildRunId),
            isNotNull(buildRuns.branch),
            inArray(buildRuns.status, ["awaiting_user_test", "complete"]),
          ),
        )
        .orderBy(desc(buildRuns.createdAt))
        .limit(1);
      const sourceBranch = sourceRun?.branch ?? repo.defaultBranch;
      await log(
        buildRunId,
        sourceRun?.branch
          ? `Using source from latest successful build branch ${sourceBranch} (${sourceRun.status}).`
          : `Using source from default branch ${sourceBranch}.`,
      );
      const currentSrc = await getRepoSrcFiles({
        repo: repo.repo,
        branch: sourceBranch,
      });
      // Current app code replaces template placeholders; configs stay fresh.
      Object.assign(files, currentSrc);

      await log(
        buildRunId,
        `Applying change: ${changeRequest?.description ?? "updated specification"}`,
      );
      const changeWorkflow = selectChangeWorkflow({
        changeSummary:
          changeRequest?.description ?? "Apply the updated specification.",
        forceDeepDiagnostic: changeRequest?.forceDeepDiagnostic ?? false,
        previousFailedChangeCount: priorFailedChangeCount,
      });
      await log(
        buildRunId,
        changeWorkflow.mode === "deep-diagnostic"
          ? `Change workflow: Deep Diagnostic Change Mode (${changeWorkflow.reasons.join("; ")}).`
          : "Change workflow: standard targeted change mode.",
      );
      generated = await runChangeCodeAgent({
        spec,
        changeSummary:
          changeRequest?.description ?? "Apply the updated specification.",
        currentFiles: agentVisibleFiles(files),
        architecture: architectureForStorage,
        forceDeepDiagnostic: changeRequest?.forceDeepDiagnostic ?? false,
        previousFailedChangeCount: priorFailedChangeCount,
      });
    } else {
      await log(buildRunId, `Generating code for "${app.name}"…`);
      if (
        usesPlatformData &&
        shouldUsePlatformDataStarterGenerator() &&
        canUsePlatformDataStarter({ spec, architecture: architectureForStorage })
      ) {
        await log(
          buildRunId,
          "Using fast platform-data starter generator for this shared app…",
        );
        generated = generatePlatformDataStarterApp({
          spec,
          architecture: architectureForStorage,
        });
      } else {
        generated = await runCodeAgent({
          spec,
          architecture: architectureForStorage,
          baseFiles: agentVisibleFiles(files),
        });
      }
    }
    applyCodegenResult(files, generated);
    const acceptanceCompilation = applyDeterministicAcceptanceCompiler({
      spec,
      architecture: architectureForStorage,
      files,
      generated,
      changeMode,
    });
    recordGeneratedPhaseMetrics(metrics, generated.phases);
    for (const phase of generated.phases) {
      await log(
        buildRunId,
        `Generation phase complete: ${phase.label} [${phase.agentKey}] (${phase.filesWritten.length} changed, ${phase.filesDeleted.length} deleted)${phase.turnContinuations > 0 ? ` after ${phase.turnContinuations} automatic turn continuation (${phase.turnLimit} total-turn limit)` : ""}. ${phase.notes}`,
      );
      await recordBuildAgentArtifact({
        appId: app.id,
        buildRunId,
        agentKey: phase.agentKey,
        phaseKey: phase.id,
        artifactType: "generation_phase",
        status: "passed",
        summary: summarizeArtifactFiles({
          label: phase.label,
          filesWritten: phase.filesWritten,
          filesDeleted: phase.filesDeleted,
        }),
        payload: {
          agentKey: phase.agentKey,
          label: phase.label,
          notes: phase.notes,
          filesWritten: phase.filesWritten,
          filesDeleted: phase.filesDeleted,
          turnContinuations: phase.turnContinuations,
          turnLimit: phase.turnLimit,
        },
      });
    }
    await recordBuildAgentArtifact({
      appId: app.id,
      buildRunId,
      agentKey: "acceptance_compiler",
      phaseKey: "acceptance-manifest",
      artifactType: "acceptance_test_manifest",
      status: artifactStatusFromIssues({
        failed: acceptanceCompilation.blockingIssues.length > 0,
        warnings: acceptanceCompilation.warnings,
      }),
      summary: `Acceptance manifest v${acceptanceCompilation.manifest.version}: ${acceptanceCompilation.manifest.summary.journeys} isolated journey(s), ${acceptanceCompilation.manifest.summary.steps} step(s), ${acceptanceCompilation.manifest.summary.saves} save check(s), ${acceptanceCompilation.manifest.summary.handoffs} handoff check(s), and ${acceptanceCompilation.manifest.summary.prerequisites} visible prerequisite setup(s).`,
      payload: {
        manifest: acceptanceCompilation.manifest,
        blockingIssues: acceptanceCompilation.blockingIssues,
        warnings: acceptanceCompilation.warnings,
      },
    });
    await recordBuildAgentArtifact({
      appId: app.id,
      buildRunId,
      agentKey: "acceptance_compiler",
      phaseKey: "acceptance-compiler",
      artifactType: "acceptance_test_compiler",
      status: artifactStatusFromIssues({
        failed: acceptanceCompilation.blockingIssues.length > 0,
        warnings: acceptanceCompilation.warnings,
      }),
      summary: `Compiled protected Playwright source with hash ${acceptanceCompilation.compilerHash.slice(0, 12)} and ${acceptanceCompilation.manifest.summary.adapterRequirements} app-specific adapter requirement(s).`,
      payload: {
        compilerVersion: acceptanceCompilation.manifest.compilerVersion,
        compilerHash: acceptanceCompilation.compilerHash,
        manifestPath: "e2e/generated/voiceforge-acceptance-manifest.ts",
        compiledSourcePath: "e2e/generated/voiceforge-compiled.spec.ts",
        adapterPath: "e2e/generated/voiceforge-acceptance-adapters.ts",
        lineMap: acceptanceCompilation.lineMap,
        compiledSource: acceptanceCompilation.compiledSource,
        adapterRequirements: acceptanceCompilation.manifest.adapters,
        isolationReview: acceptanceCompilation.isolationReview,
        blockingIssues: acceptanceCompilation.blockingIssues,
        warnings: acceptanceCompilation.warnings,
      },
    });
    await log(
      buildRunId,
      `Acceptance compiler ready: ${acceptanceCompilation.manifest.summary.journeys} self-contained journey(s), ${acceptanceCompilation.manifest.summary.prerequisites} visible prerequisite setup(s), and ${acceptanceCompilation.manifest.summary.parallelSafeJourneys} parallel-safe journey(s) compiled deterministically${acceptanceCompilation.manifest.summary.adapterRequirements > 0 ? `; ${acceptanceCompilation.manifest.summary.adapterRequirements} app-specific adapter(s) required` : " with no app-specific adapters"}.`,
    );
    await log(
      buildRunId,
      `Code agent changed ${generated.filesWritten.length} files: ${generated.filesWritten.join(", ")}`,
    );
    if (generated.deletedFiles.length > 0) {
      await log(
        buildRunId,
        `Code agent deleted ${generated.deletedFiles.length} files: ${generated.deletedFiles.join(", ")}`,
      );
    }
    if (generated.notes) await log(buildRunId, `Code agent notes: ${generated.notes}`);
    if (generated.filesWritten.length === 0) {
      throw new Error("Code agent produced no files");
    }
    const completenessSource = await loadHumanCompletenessSourceContext({
      requirement,
      changeSummary: changeRequest?.description,
    });
    const debugBudget = createDebugBudget({
      maxRoundsPerStep: MAX_DEBUG_ROUNDS_PER_STEP,
      maxTotalRounds: MAX_TOTAL_DEBUG_ROUNDS,
    });
    const workflowRepairs: WorkflowRepairPackage[] = [];
    const reviewProgress: SerializedReviewProgress = {
      changedFilePaths: [...generated.filesWritten],
      deletedFilePaths: [...generated.deletedFiles],
      unchangedRoundsByDomain: {},
      changeMode,
    };
    await saveBuildCheckpoint({
      appId: app.id,
      buildRunId,
      stage: "reviewing",
      files,
      metadata: durableMetadata({
        generated,
        debugBudget,
        reviewProgress,
        metrics,
        seededPlatformEntities,
        workflowRepairs,
      }),
    });
    await log(
      buildRunId,
      `Durable checkpoint saved before workflow reviews (${Object.keys(files).length} files).`,
    );
    await runCheckpointReviewGate({
      app,
      buildRunId,
      spec,
      architecture: architectureForStorage,
      completenessSource,
      files,
      generated,
      debugBudget,
      metrics,
      seededPlatformEntities,
      reviewProgress,
      workflowRepairs,
    });

    await saveBuildCheckpoint({
      appId: app.id,
      buildRunId,
      stage: "testing",
      files,
      metadata: durableMetadata({
        generated,
        debugBudget,
        reviewProgress,
        metrics,
        seededPlatformEntities,
        workflowRepairs,
      }),
    });
    await log(
      buildRunId,
      `Durable checkpoint saved before checks (${Object.keys(files).length} files).`,
    );

    await runTestGauntlet({
      app,
      buildRunId,
      spec,
      architecture: architectureForStorage,
      completenessSource,
      files,
      generated,
      debugBudget,
      metrics,
      seededPlatformEntities,
      workflowRepairs,
      reviewProgress,
    });

    await saveBuildCheckpoint({
      appId: app.id,
      buildRunId,
      stage: "publish_pending",
      files,
      metadata: durableMetadata({
        generated,
        debugBudget,
        reviewProgress,
        metrics,
        seededPlatformEntities,
        workflowRepairs,
      }),
    });
    await log(
      buildRunId,
      `Durable checkpoint saved for publishing (${Object.keys(files).length} files).`,
    );
    await recordBuildMetricsArtifact({
      appId: app.id,
      buildRunId,
      metrics,
    });
    await publishCheckedBuild({
      app,
      buildRunId,
      requirement,
      spec,
      files,
      architecture: architectureForStorage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setBuildFailureCategory(metrics, categorizeBuildFailure(message));
    await recordBuildMetricsArtifact({
      appId: app.id,
      buildRunId,
      metrics,
    });
    if (err instanceof ArchitectureBlockedError) {
      await log(buildRunId, `Build needs input: ${message}`);
      await setStatus(buildRunId, "needs_input", {
        errorMessage: message,
        finishedAt: new Date(),
      });
      await db
        .update(apps)
        .set({
          status: appStatusAfterNeedsInput(app),
          updatedAt: new Date(),
        })
        .where(eq(apps.id, app.id));
      if (run.requirementId) {
        await db
          .update(changeRequests)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(changeRequests.requirementId, run.requirementId));
      }
      await audit({
        userId: app.ownerId,
        appId: app.id,
        buildRunId,
        action: "build.needs_input",
        payload: { error: message, blockingIssues: err.blockingIssues },
      });
      return;
    }
    await log(buildRunId, `Build failed: ${message}`);
    await setStatus(buildRunId, "failed", {
      errorMessage: message,
      finishedAt: new Date(),
    });
    await db
      .update(apps)
      .set({
        status: appStatusAfterBuildFailure(app),
        updatedAt: new Date(),
      })
      .where(eq(apps.id, app.id));
    if (run.requirementId) {
      await db
        .update(changeRequests)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(changeRequests.requirementId, run.requirementId));
    }
    await audit({
      userId: app.ownerId,
      appId: app.id,
      buildRunId,
      action: "build.failed",
      payload: { error: message },
    });
    await notifyBuildFailure(db, {
      appId: app.id,
      buildRunId,
      message,
    });
  }
}

async function runTestGauntlet(input: {
  app: App;
  buildRunId: string;
  spec: AppSpec;
  architecture: ArchitecturePlan;
  completenessSource: HumanCompletenessSourceContext;
  files: FileMap;
  generated: CodegenResult;
  debugBudget: DebugBudget;
  debugProgress?: SerializedDebugProgress;
  metrics: BuildMetrics;
  seededPlatformEntities: unknown[];
  workflowRepairs: WorkflowRepairPackage[];
  reviewProgress: SerializedReviewProgress;
}): Promise<void> {
  const db = getDb();
  let runner: Runner | null = null;
  try {
    runner = await createRunner(input.buildRunId, {
      env:
        input.seededPlatformEntities.length > 0
          ? {
              VOICEFORGE_PLATFORM_SCHEMA_JSON: JSON.stringify(
                input.seededPlatformEntities,
              ),
            }
          : undefined,
    });
    const activeRunner = runner;
    await log(
      input.buildRunId,
      runner.kind === "sandbox"
        ? "Testing in an isolated cloud sandbox…"
        : "Testing on the local build machine…",
    );
    await runner.writeFiles(input.files);
    await setStatus(input.buildRunId, "testing");

    const passedSteps = new Set<PipelineStepName>();
    const ineffectiveRoundsByStep = new Map<PipelineStepName, number>(
      Object.entries(input.debugProgress?.ineffectiveRoundsByStep ?? {}) as [
        PipelineStepName,
        number,
      ][],
    );
    const lastProgressByStep = new Map<PipelineStepName, FailureProgress>(
      Object.entries(input.debugProgress?.lastProgressByStep ?? {}) as [
        PipelineStepName,
        FailureProgress,
      ][],
    );
    let pendingFix: PendingDebugFix | null = null;
    const workflowRepairSnapshots = new Map<string, FileMap>();
    const getPendingFix = (): PendingDebugFix | null => pendingFix;

    const saveTestingCheckpoint = async () => {
      return saveBuildCheckpoint({
        appId: input.app.id,
        buildRunId: input.buildRunId,
        stage: "testing",
        files: input.files,
        metadata: durableMetadata({
          generated: input.generated,
          debugBudget: input.debugBudget,
          debugProgress: {
            ineffectiveRoundsByStep: Object.fromEntries(
              ineffectiveRoundsByStep,
            ),
            lastProgressByStep: Object.fromEntries(lastProgressByStep),
          },
          metrics: input.metrics,
          seededPlatformEntities: input.seededPlatformEntities,
          workflowRepairs: input.workflowRepairs,
          reviewProgress: input.reviewProgress,
        }),
      });
    };

    const currentWorkflowReviews = () => {
      const changedFilePaths = [...input.reviewProgress.changedFilePaths];
      const changedFiles = Object.fromEntries(
        changedFilePaths.flatMap((path) =>
          path in input.files ? [[path, input.files[path]]] : [],
        ),
      );
      return runPostGenerationReviews({
        spec: input.spec,
        architecture: input.architecture,
        allFiles: agentVisibleFiles(input.files),
        changedFiles,
        changedFilePaths,
        deletedFilePaths: [...input.reviewProgress.deletedFilePaths],
        changeMode: input.reviewProgress.changeMode,
      });
    };

    const recordFocusedResult = async (
      label: string,
      result: Awaited<ReturnType<Runner["runFocused"]>>,
    ) => {
      await db.insert(testResults).values({
        buildRunId: input.buildRunId,
        suite: SUITE_FOR_STEP[result.step],
        status: result.ok ? "passed" : "failed",
        summary: `${label} (${Math.round(result.durationMs / 1000)}s)`,
        details: {
          focused: true,
          output: result.output,
          failureFingerprint: result.failureFingerprint,
        },
      });
    };

    const validateFocusedWorkflowRepair = async (
      repair: WorkflowRepairPackage,
    ): Promise<{
      ok: boolean;
      reason: string;
      failedStep?: PipelineStepName;
      failureFingerprint?: FailureFingerprint;
    }> => {
      const candidateReviews = currentWorkflowReviews();
      const candidateIssues = getPostGenerationBlockingIssues(candidateReviews);
      const staticAssessment = assessWorkflowRepairCandidate({
        repair,
        currentBlockingIssues: candidateIssues,
      });
      repair.validation.staticReview = staticAssessment.accepted
        ? "passed"
        : "failed";
      repair.validation.targetResolved = staticAssessment.targetResolved;
      repair.validation.unrelatedFindingsAdded =
        staticAssessment.unrelatedFindingsAdded;
      if (!staticAssessment.accepted) {
        return { ok: false, reason: staticAssessment.reason };
      }

      if (repair.classification.targetSurface === "application_source") {
        const typecheck = await activeRunner.run("typecheck");
        await db.insert(testResults).values({
          buildRunId: input.buildRunId,
          suite: "typecheck",
          status: typecheck.ok ? "passed" : "failed",
          summary: `focused workflow typecheck (${Math.round(typecheck.durationMs / 1000)}s)`,
          details: { focused: true, output: typecheck.output },
        });
        if (!typecheck.ok) {
          return {
            ok: false,
            reason: "The workflow candidate failed focused typecheck.",
            failedStep: "typecheck",
            failureFingerprint:
              typecheck.failureFingerprint ??
              createFailureFingerprint("typecheck", typecheck.output),
          };
        }
      }

      const unitFiles = repair.focusedValidation.unitTestFiles.filter(
        (path) => path in input.files,
      );
      if (unitFiles.length > 0) {
        const unit = await activeRunner.runFocused({
          kind: "unit",
          testFiles: unitFiles,
        });
        await recordFocusedResult("focused workflow unit tests", unit);
        repair.validation.unit = unit.ok ? "passed" : "failed";
        if (!unit.ok) {
          return {
            ok: false,
            reason: `Focused unit validation failed in ${unitFiles.join(", ")}.`,
            failedStep: "test",
            failureFingerprint:
              unit.failureFingerprint ??
              createFailureFingerprint("test", unit.output),
          };
        }
      } else {
        repair.validation.unit = "not_applicable";
      }

      if (repair.focusedValidation.e2eGrep) {
        if (
          repair.classification.targetSurface === "application_source" ||
          !passedSteps.has("build")
        ) {
          const build = await activeRunner.run("build");
          await db.insert(testResults).values({
            buildRunId: input.buildRunId,
            suite: "build",
            status: build.ok ? "passed" : "failed",
            summary: `focused workflow build (${Math.round(build.durationMs / 1000)}s)`,
            details: { focused: true, output: build.output },
          });
          if (!build.ok) {
            return {
              ok: false,
              reason:
                "The workflow candidate could not prepare its focused production build.",
              failedStep: "build",
              failureFingerprint:
                build.failureFingerprint ??
                createFailureFingerprint("build", build.output),
            };
          }
        }
        const browser = await activeRunner.runFocused(
          { kind: "e2e", grep: repair.focusedValidation.e2eGrep },
          {
            onProgress: (progress) =>
              log(input.buildRunId, `Focused ${progress.message}`),
          },
        );
        await recordFocusedResult("focused workflow browser journey", browser);
        repair.validation.browserJourney = browser.ok ? "passed" : "failed";
        if (!browser.ok) {
          return {
            ok: false,
            reason: `Targeted Playwright journey ${repair.focusedValidation.journeyId} still fails.`,
            failedStep: "e2e",
            failureFingerprint:
              browser.failureFingerprint ??
              createFailureFingerprint("e2e", browser.output),
          };
        }
      } else {
        repair.validation.browserJourney = "not_applicable";
      }

      repair.validation.targetResolved = true;
      return {
        ok: true,
        reason:
          "The named workflow finding, affected focused tests, and targeted browser journey passed without adding unrelated findings.",
      };
    };

    const rollbackWorkflowRepairAndRereview = async (inputFailure: {
      repair: WorkflowRepairPackage;
      failedStep: PipelineStepName;
      failureFingerprint: FailureFingerprint;
      reason: string;
      fullGauntlet?: boolean;
    }) => {
      const repair = inputFailure.repair;
      let snapshot = workflowRepairSnapshots.get(repair.id);
      if (!snapshot && repair.rollback?.checkpointId) {
        const checkpoint = await loadBuildCheckpointById(
          repair.rollback.checkpointId,
          input.buildRunId,
        );
        snapshot =
          checkpoint && isBuildCheckpointCompatible(checkpoint.metadata)
            ? checkpoint.files
            : undefined;
      }
      if (!snapshot) {
        await recordWorkflowRepairArtifact({
          appId: input.app.id,
          buildRunId: input.buildRunId,
          repair,
          metrics: input.metrics,
          summary: `Could not load the proven rollback checkpoint for ${repair.target.workflowName}; the candidate source was not published.`,
        });
        throw new Error(
          "A workflow repair failed validation and its durable rollback checkpoint could not be loaded. The candidate source was not published.",
        );
      }

      const removedPaths = restoreFileMap(input.files, snapshot);
      await activeRunner.deleteFiles(removedPaths);
      await activeRunner.writeFiles(input.files);
      workflowRepairSnapshots.delete(repair.id);
      repair.status = "rolled_back";
      if (inputFailure.fullGauntlet) {
        repair.validation.fullGauntlet = "failed";
      }
      const lastAttempt = repair.attempts.at(-1);
      if (lastAttempt) {
        lastAttempt.outcome = "rolled_back";
        lastAttempt.reason = inputFailure.reason;
      }
      upsertWorkflowRepair(input.workflowRepairs, repair);
      await recordWorkflowRepairArtifact({
        appId: input.app.id,
        buildRunId: input.buildRunId,
        repair,
        metrics: input.metrics,
        summary: `Rolled back ${repair.target.workflowName} repair because validation failed at ${inputFailure.failedStep}.`,
      });
      await saveTestingCheckpoint();
      await log(
        input.buildRunId,
        `Workflow repair was rolled back because validation failed at ${inputFailure.failedStep}; the prior proven source is active again and the named workflow will be reviewed before testing resumes.`,
      );
      recordDebugAttempt(
        input.debugBudget,
        `review_gate:${repair.repairDomain}`,
        `The prior scoped repair failed ${inputFailure.failedStep} validation: ${inputFailure.failureFingerprint.summary}`,
      );

      const beforeRereview = { ...input.files };
      input.reviewProgress.unchangedRoundsByDomain = {};
      await runCheckpointReviewGate({
        app: input.app,
        buildRunId: input.buildRunId,
        spec: input.spec,
        architecture: input.architecture,
        files: input.files,
        generated: input.generated,
        debugBudget: input.debugBudget,
        metrics: input.metrics,
        seededPlatformEntities: input.seededPlatformEntities,
        reviewProgress: input.reviewProgress,
        completenessSource: input.completenessSource,
        workflowRepairs: input.workflowRepairs,
        includeCompleteness: true,
      });
      const rereviewDeletedPaths = Object.keys(beforeRereview).filter(
        (path) => !(path in input.files),
      );
      await activeRunner.deleteFiles(rereviewDeletedPaths);
      await activeRunner.writeFiles(input.files);
    };

    const rollbackPendingFix = async (
      failedResultStep: PipelineStepName,
      reason: string,
      progress?: FailureProgress,
    ) => {
      if (!pendingFix) return;
      const rolledBack = pendingFix;
      const removedPaths = restoreFileMap(input.files, rolledBack.beforeFiles);
      await activeRunner.deleteFiles(removedPaths);
      await activeRunner.writeFiles(input.files);
      const ineffectiveRounds =
        (ineffectiveRoundsByStep.get(rolledBack.step) ?? 0) + 1;
      ineffectiveRoundsByStep.set(rolledBack.step, ineffectiveRounds);
      if (progress) lastProgressByStep.set(rolledBack.step, progress);
      await log(
        input.buildRunId,
        `Debug repair for ${rolledBack.step} was rolled back after validation: ${reason} (${ineffectiveRounds} ineffective round(s)).`,
      );
      await recordBuildAgentArtifact({
        appId: input.app.id,
        buildRunId: input.buildRunId,
        agentKey: "debug_agent",
        phaseKey: `debug-${rolledBack.step}`,
        artifactType: "debug_validation",
        status: "warning",
        summary: `Rolled back debug ${rolledBack.step} round ${rolledBack.stepRound}: ${reason}`,
        payload: {
          failedStep: rolledBack.step,
          validationStep: failedResultStep,
          stepRound: rolledBack.stepRound,
          outcome: "rolled_back",
          reason,
          progress,
          beforeFingerprint: rolledBack.beforeFingerprint,
          filesWritten: rolledBack.filesWritten,
          filesDeleted: rolledBack.filesDeleted,
          ineffectiveRounds,
        },
      });
      pendingFix = null;
      await saveTestingCheckpoint();
      await setStatus(input.buildRunId, "testing");
    };

    let stepIdx = 0;
    while (stepIdx < STEP_ORDER.length) {
      const step = STEP_ORDER[stepIdx];

      await log(input.buildRunId, `Running ${step}…`);
      const result =
        step === "dependencies"
          ? runDependencySecurityStep(input.files)
          : await runner.run(step, {
              onProgress:
                step === "e2e"
                  ? (progress) => log(input.buildRunId, progress.message)
                  : undefined,
            });

      await db.insert(testResults).values({
        buildRunId: input.buildRunId,
        suite: SUITE_FOR_STEP[step],
        status: result.ok ? "passed" : "failed",
        summary: `${step} (${Math.round(result.durationMs / 1000)}s)`,
        details: {
          output: result.output,
          failureFingerprint: result.failureFingerprint,
        },
      });

      if (
        !result.ok &&
        result.output.includes("Hosted browser setup failed while installing")
      ) {
        await log(
          input.buildRunId,
          "Hosted browser infrastructure could not be prepared after two attempts; generated app code was left unchanged.",
        );
        throw new Error(
          "Hosted browser infrastructure could not be prepared. Try building again.",
        );
      }

      if (result.ok) {
        if (step === "install") {
          let rereviewed = false;
          for (const repair of input.workflowRepairs.filter(
            (candidate) =>
              candidate.status === "focused_validated" &&
              (candidate.validation.unit === "pending" ||
                candidate.validation.browserJourney === "pending"),
          )) {
            const focused = await validateFocusedWorkflowRepair(repair);
            if (!focused.ok) {
              if (focused.failedStep === "e2e") {
                await recordWorkflowRepairArtifact({
                  appId: input.app.id,
                  buildRunId: input.buildRunId,
                  repair,
                  metrics: input.metrics,
                  summary: `Focused static validation passed for ${repair.target.workflowName}, and the browser journey exposed a concrete test failure. Preserved the improving candidate for workflow-aware E2E repair.`,
                });
                await log(
                  input.buildRunId,
                  "Focused browser validation exposed a concrete journey failure; VoiceForge preserved the static-improving candidate and will repair it from the Playwright evidence.",
                );
                await saveTestingCheckpoint();
                continue;
              }
              await rollbackWorkflowRepairAndRereview({
                repair,
                failedStep: focused.failedStep ?? "e2e",
                failureFingerprint:
                  focused.failureFingerprint ??
                  createFailureFingerprint("e2e", focused.reason),
                reason: focused.reason,
              });
              rereviewed = true;
              break;
            }
            upsertWorkflowRepair(input.workflowRepairs, repair);
            await recordWorkflowRepairArtifact({
              appId: input.app.id,
              buildRunId: input.buildRunId,
              repair,
              metrics: input.metrics,
              summary: `Focused validation passed for ${repair.target.workflowName}; continuing through the complete gauntlet.`,
            });
            await saveTestingCheckpoint();
          }
          if (rereviewed) {
            passedSteps.clear();
            stepIdx = 0;
            continue;
          }
        }
        if (step === "test") {
          input.workflowRepairs
            .filter((repair) => repair.status === "focused_validated")
            .forEach((repair) => {
              if (repair.validation.unit === "pending") {
                repair.validation.unit = "passed";
              }
            });
        }
        if (step === "e2e") {
          for (const repair of input.workflowRepairs.filter(
            (candidate) => candidate.status === "focused_validated",
          )) {
            repair.status = "accepted";
            repair.validation.fullGauntlet = "passed";
            if (repair.validation.browserJourney === "pending") {
              repair.validation.browserJourney = "passed";
            }
            const lastAttempt = repair.attempts.at(-1);
            if (lastAttempt?.outcome === "candidate") {
              lastAttempt.outcome = "accepted";
              lastAttempt.reason =
                "Focused workflow validation and the complete test gauntlet passed.";
            }
            upsertWorkflowRepair(input.workflowRepairs, repair);
            workflowRepairSnapshots.delete(repair.id);
            await recordWorkflowRepairArtifact({
              appId: input.app.id,
              buildRunId: input.buildRunId,
              repair,
              metrics: input.metrics,
              summary: `Accepted ${repair.target.workflowName} repair after focused checks and the complete test gauntlet.`,
            });
          }
          await saveTestingCheckpoint();
        }
        const successfulPendingFix = getPendingFix();
        if (successfulPendingFix?.step === step) {
          const validatedFix = successfulPendingFix;
          const progress = compareFailureFingerprints(
            validatedFix.beforeFingerprint,
            createFailureFingerprint(step, ""),
          );
          lastProgressByStep.set(step, progress);
          ineffectiveRoundsByStep.set(step, 0);
          await recordBuildAgentArtifact({
            appId: input.app.id,
            buildRunId: input.buildRunId,
            agentKey: "debug_agent",
            phaseKey: `debug-${step}`,
            artifactType: "debug_validation",
            status: "passed",
            summary: `Validated debug ${step} round ${validatedFix.stepRound}: failing step now passes.`,
            payload: {
              failedStep: step,
              stepRound: validatedFix.stepRound,
              outcome: "accepted",
              progress,
              beforeFingerprint: validatedFix.beforeFingerprint,
              filesWritten: validatedFix.filesWritten,
              filesDeleted: validatedFix.filesDeleted,
            },
          });
          pendingFix = null;
          await saveTestingCheckpoint();
          await log(
            input.buildRunId,
            `Debug repair for ${step} validated and checkpointed: ${progress.summary}.`,
          );
        }
        passedSteps.add(step);
        await log(input.buildRunId, `${step} passed.`);
        stepIdx++;
        continue;
      }

      const failureFingerprint =
        result.failureFingerprint ??
        createFailureFingerprint(step, result.output);
      const workflowCandidate = [...input.workflowRepairs]
        .reverse()
        .find(
          (repair) =>
            repair.status === "focused_validated" &&
            workflowRepairOwnsFailure(repair, failureFingerprint) &&
            (workflowRepairSnapshots.has(repair.id) ||
              Boolean(repair.rollback?.checkpointId)),
        );
      if (workflowCandidate && step !== "e2e") {
        await rollbackWorkflowRepairAndRereview({
          repair: workflowCandidate,
          failedStep: step,
          failureFingerprint,
          reason: `The candidate introduced or exposed a related failure during full ${step} validation.`,
          fullGauntlet: true,
        });
        passedSteps.clear();
        stepIdx = 0;
        continue;
      }
      const failedPendingFix = getPendingFix();

      if (
        failedPendingFix &&
        failedPendingFix.step !== step &&
        passedSteps.has(step)
      ) {
        const pendingStep = failedPendingFix.step;
        await rollbackPendingFix(
          step,
          `the repair introduced a failure in previously passing ${step}`,
        );
        stepIdx = STEP_ORDER.indexOf(step);
        if (pendingStep === "install") stepIdx = 0;
        continue;
      }

      const sameStepPendingFix = getPendingFix();
      if (sameStepPendingFix?.step === step) {
        const validatedFix = sameStepPendingFix;
        const progress = compareFailureFingerprints(
          validatedFix.beforeFingerprint,
          failureFingerprint,
        );
        lastProgressByStep.set(step, progress);

        if (
          progress.status === "regressed" ||
          progress.status === "unchanged"
        ) {
          await rollbackPendingFix(step, progress.summary, progress);
          continue;
        }

        const ineffectiveRounds =
          progress.status === "improved"
            ? 0
            : (ineffectiveRoundsByStep.get(step) ?? 0) + 1;
        ineffectiveRoundsByStep.set(step, ineffectiveRounds);
        await recordBuildAgentArtifact({
          appId: input.app.id,
          buildRunId: input.buildRunId,
          agentKey: "debug_agent",
          phaseKey: `debug-${step}`,
          artifactType: "debug_validation",
          status: progress.status === "improved" ? "passed" : "warning",
          summary: `Validated debug ${step} round ${validatedFix.stepRound}: ${progress.summary}.`,
          payload: {
            failedStep: step,
            stepRound: validatedFix.stepRound,
            outcome: "accepted_with_remaining_failures",
            progress,
            beforeFingerprint: validatedFix.beforeFingerprint,
            afterFingerprint: failureFingerprint,
            filesWritten: validatedFix.filesWritten,
            filesDeleted: validatedFix.filesDeleted,
            ineffectiveRounds,
          },
        });
        pendingFix = null;
        await saveTestingCheckpoint();
        await log(
          input.buildRunId,
          `Debug repair for ${step} made ${progress.status} progress and was checkpointed: ${progress.summary}.`,
        );
      }

      const ineffectiveRounds = ineffectiveRoundsByStep.get(step) ?? 0;
      const forceFullScope = shouldEscalateDebugScope(ineffectiveRounds);
      const priorProgress = lastProgressByStep.get(step);
      const escalationReason = forceFullScope
        ? `${ineffectiveRounds} earlier repair(s) failed to reduce the ${step} failure set. Inspect the complete source workflow and its tests together.`
        : undefined;
      const debugErrorOutput = [
        result.output,
        `STRUCTURED FAILURE FINGERPRINT: ${JSON.stringify(failureFingerprint)}`,
        priorProgress
          ? `PRIOR REPAIR PROGRESS: ${priorProgress.summary}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      let workflowRepair: WorkflowRepairPackage | null = null;
      if (
        step === "e2e" &&
        (isWorkflowLinkedFailure(debugErrorOutput) ||
          /e2e\/generated\/.+\.spec\.[tj]s/i.test(debugErrorOutput))
      ) {
        const workflowReviews = currentWorkflowReviews();
        workflowRepair = createWorkflowRepairPackage({
          spec: input.spec,
          architecture: input.architecture,
          files: agentVisibleFiles(input.files),
          failedStep: step,
          errorOutput: debugErrorOutput,
          repairDomain: "acceptance",
          blockingIssues: [],
          reviews: workflowReviews,
          previousAttempts: [],
          failureFingerprint,
          source: input.completenessSource,
        });
        const priorRepair = input.workflowRepairs.find(
          (candidate) => candidate.id === workflowRepair?.id,
        );
        if (priorRepair) {
          workflowRepair.attempts = [...priorRepair.attempts];
        }
      }
      const debugBudgetStep = workflowRepair
        ? `${step}:${workflowRepair.id}`
        : step;
      const { stepRound, previousAttempts } = reserveDebugRound(
        input.debugBudget,
        debugBudgetStep,
      );
      if (workflowRepair) {
        workflowRepair.evidence.previousAttempts = [...previousAttempts];
        upsertWorkflowRepair(input.workflowRepairs, workflowRepair);
        await recordWorkflowRepairArtifact({
          appId: input.app.id,
          buildRunId: input.buildRunId,
          repair: workflowRepair,
          metrics: input.metrics,
          summary: `Classified browser failure in ${workflowRepair.target.workflowName}: ${workflowRepair.classification.category.replaceAll("_", " ")} / ${workflowRepair.classification.subtype.replaceAll("_", " ")}.`,
        });
        if (
          workflowRepair.classification.targetSurface ===
          "external_environment"
        ) {
          workflowRepair.attempts.push({
            round: stepRound,
            strategy: "Preserve generated source and retry the provider later.",
            suspectedRootCause:
              workflowRepair.classification.reasons.join(" "),
            filesInspected: [],
            filesWritten: [],
            filesDeleted: [],
            outcome: "external_retry",
            reason:
              "The failure came from an external service; source editing was deliberately skipped.",
          });
          upsertWorkflowRepair(input.workflowRepairs, workflowRepair);
          await saveTestingCheckpoint();
          await recordWorkflowRepairArtifact({
            appId: input.app.id,
            buildRunId: input.buildRunId,
            repair: workflowRepair,
            metrics: input.metrics,
            summary:
              "External service failure preserved generated source; retry when the provider is available.",
          });
          throw new Error(
            "An external service failed during the workflow journey. VoiceForge preserved the generated app without speculative rewrites; try building again when the provider is available.",
          );
        }
      }
      const debugFiles = workflowRepair
        ? workflowRepairVisibleFiles(input.files, workflowRepair)
        : agentVisibleFiles(input.files);
      const debugPlan = createPhaseAwareDebugPlan({
        spec: input.spec,
        files: debugFiles,
        failedStep: step,
        errorOutput: debugErrorOutput,
        generatedPhases: input.generated.phases,
        forceFullScope: workflowRepair ? false : forceFullScope,
        escalationReason,
      });
      recordDebugRoundMetric(input.metrics, {
        step,
        domain: debugPlan.classification.domain,
        focus: debugPlan.classification.focus,
        responsiblePhaseId: debugPlan.responsiblePhase.id,
        responsibleAgentKey: debugPlan.responsiblePhase.agentKey,
      });
      // Keep the last proven source durable while this AI repair is in flight.
      const rollbackCheckpointId = await saveTestingCheckpoint();
      if (workflowRepair) {
        workflowRepair.rollback = {
          checkpointId: rollbackCheckpointId,
          checkpointStage: "testing",
        };
        upsertWorkflowRepair(input.workflowRepairs, workflowRepair);
      }

      await setStatus(input.buildRunId, "debugging");
      await log(
        input.buildRunId,
        workflowRepair
          ? `${step} failed — workflow-aware repair round ${stepRound}/${MAX_DEBUG_ROUNDS_PER_STEP}: ${workflowRepair.classification.category.replaceAll("_", " ")} in ${workflowRepair.target.workflowName}. Scope: ${workflowRepair.scope.mutationPaths.length} mutable and ${workflowRepair.scope.protectedPaths.length} protected files.`
          : `${step} failed — phase-aware debug round ${stepRound}/${MAX_DEBUG_ROUNDS_PER_STEP} for ${debugPlan.classification.domainLabel} (${input.debugBudget.totalRounds}/${MAX_TOTAL_DEBUG_ROUNDS} total). Responsible phase: ${debugPlan.responsiblePhase.label}. Scope: ${debugPlan.scope.visibleFileCount}/${debugPlan.scope.fullFileCount} files${forceFullScope ? " (escalated after repeated ineffective repairs)" : ""}.`,
      );
      const beforeFiles = { ...input.files };
      const fix = await runDebugAgent({
        spec: input.spec,
        currentFiles: debugFiles,
        failedStep: step,
        errorOutput: debugErrorOutput,
        previousAttempts,
        debugContext: debugPlan.context,
        workflowRepair: workflowRepair ?? undefined,
      });
      recordDebugAttempt(
        input.debugBudget,
        debugBudgetStep,
        fix.debugDiagnostics.suspectedRootCause ||
          fix.notes ||
          `(rewrote ${fix.filesWritten.join(", ")})`,
      );
      if (fix.filesWritten.length === 0 && fix.deletedFiles.length === 0) {
        const progress = compareFailureFingerprints(
          failureFingerprint,
          failureFingerprint,
        );
        const ineffectiveRounds =
          (ineffectiveRoundsByStep.get(step) ?? 0) + 1;
        ineffectiveRoundsByStep.set(step, ineffectiveRounds);
        lastProgressByStep.set(step, progress);
        if (workflowRepair) {
          workflowRepair.status = "rolled_back";
          workflowRepair.attempts.push({
            round: stepRound,
            strategy: fix.notes || "Diagnosis only",
            suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
            filesInspected: fix.debugDiagnostics.filesInspected,
            filesWritten: [],
            filesDeleted: [],
            outcome: "rolled_back",
            reason:
              "The workflow diagnosis produced no actionable scoped patch.",
          });
          upsertWorkflowRepair(input.workflowRepairs, workflowRepair);
          await recordWorkflowRepairArtifact({
            appId: input.app.id,
            buildRunId: input.buildRunId,
            repair: workflowRepair,
            metrics: input.metrics,
            summary: `No workflow patch was accepted for ${workflowRepair.target.workflowName}; the proven checkpoint remains active.`,
          });
        }
        await recordBuildAgentArtifact({
          appId: input.app.id,
          buildRunId: input.buildRunId,
          agentKey: "debug_agent",
          phaseKey: `debug-${step}`,
          artifactType: "debug_fix",
          status: "warning",
          summary: `Debug ${step} diagnosed the failure but produced no file changes; the diagnosis will be supplied to the next round.`,
          payload: {
            failedStep: step,
            failedDomain: debugPlan.classification.domain,
            domainLabel: debugPlan.classification.domainLabel,
            focus: debugPlan.classification.focus,
            responsiblePhase: debugPlan.responsiblePhase,
            stepRound,
            totalRounds: input.debugBudget.totalRounds,
            previousAttempts,
            failureFingerprint,
            priorProgress,
            forceFullScope,
            escalationReason,
            suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
            filesInspected: fix.debugDiagnostics.filesInspected,
            preferredInspectionPaths:
              fix.debugDiagnostics.preferredInspectionPaths,
            visibleFileCount: fix.debugDiagnostics.visibleFileCount,
            fullFileCount: fix.debugDiagnostics.fullFileCount,
            strategyChangedFromPriorAttempts:
              fix.debugDiagnostics.strategyChangedFromPriorAttempts,
            ineffectiveRounds,
            progress,
            notes: fix.notes,
          },
        });
        await log(
          input.buildRunId,
          `Debug ${step} round ${stepRound} produced a diagnosis but no patch; preserved the checkpoint and will retry with that diagnosis (${ineffectiveRounds} ineffective round(s)).`,
        );
        await saveTestingCheckpoint();
        await setStatus(input.buildRunId, "testing");
        continue;
      }
      if (workflowRepair) {
        const scopeAssessment = validateWorkflowRepairMutationScope({
          repair: workflowRepair,
          filesWritten: fix.filesWritten,
          filesDeleted: fix.deletedFiles,
        });
        if (!scopeAssessment.ok) {
          workflowRepair.status = "rolled_back";
          workflowRepair.attempts.push({
            round: stepRound,
            strategy: fix.notes,
            suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
            filesInspected: fix.debugDiagnostics.filesInspected,
            filesWritten: fix.filesWritten,
            filesDeleted: fix.deletedFiles,
            outcome: "rolled_back",
            reason: scopeAssessment.reason,
          });
          upsertWorkflowRepair(input.workflowRepairs, workflowRepair);
          ineffectiveRoundsByStep.set(step, ineffectiveRounds + 1);
          await recordWorkflowRepairArtifact({
            appId: input.app.id,
            buildRunId: input.buildRunId,
            repair: workflowRepair,
            metrics: input.metrics,
            summary: `Rejected out-of-scope repair for ${workflowRepair.target.workflowName}: ${scopeAssessment.reason}`,
          });
          await saveTestingCheckpoint();
          await setStatus(input.buildRunId, "testing");
          continue;
        }

        await saveTestingCheckpoint();
        applyCodegenResult(input.files, fix);
        await activeRunner.deleteFiles(fix.deletedFiles);
        await activeRunner.writeFiles(fix.files);
        const focused = await validateFocusedWorkflowRepair(workflowRepair);
        const focusedProgress =
          !focused.ok &&
          focused.failedStep === "e2e" &&
          focused.failureFingerprint
            ? compareFailureFingerprints(
                workflowFocusedFailureFingerprint(
                  failureFingerprint,
                  workflowRepair.target.journeyId,
                ),
                focused.failureFingerprint,
              )
            : null;
        const focusedImproved =
          focusedProgress?.status === "improved" ||
          focusedProgress?.status === "changed";
        workflowRepair.attempts.push({
          round: stepRound,
          strategy: fix.notes,
          suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
          filesInspected: fix.debugDiagnostics.filesInspected,
          filesWritten: fix.filesWritten,
          filesDeleted: fix.deletedFiles,
          outcome: focused.ok || focusedImproved ? "candidate" : "rolled_back",
          reason: focusedImproved && focusedProgress
            ? `${focused.reason} ${focusedProgress.summary}`
            : focused.reason,
        });

        if (!focused.ok) {
          if (focusedImproved && focusedProgress) {
            workflowRepair.status = "candidate";
            workflowRepair.validation.fullGauntlet = "pending";
            ineffectiveRoundsByStep.set(step, 0);
            lastProgressByStep.set(step, focusedProgress);
            upsertWorkflowRepair(input.workflowRepairs, workflowRepair);
            await recordWorkflowRepairArtifact({
              appId: input.app.id,
              buildRunId: input.buildRunId,
              repair: workflowRepair,
              metrics: input.metrics,
              summary: `Checkpointed improving browser repair for ${workflowRepair.target.workflowName}: ${focusedProgress.summary}`,
            });
            await log(
              input.buildRunId,
              `Focused browser repair made progress and was checkpointed: ${focusedProgress.summary}. VoiceForge will continue from the new failure evidence.`,
            );
            await saveTestingCheckpoint();
            await setStatus(input.buildRunId, "testing");
            continue;
          }
          const removedPaths = restoreFileMap(input.files, beforeFiles);
          await activeRunner.deleteFiles(removedPaths);
          await activeRunner.writeFiles(input.files);
          workflowRepair.status = "rolled_back";
          workflowRepair.validation.fullGauntlet = "pending";
          ineffectiveRoundsByStep.set(step, ineffectiveRounds + 1);
          upsertWorkflowRepair(input.workflowRepairs, workflowRepair);
          await recordWorkflowRepairArtifact({
            appId: input.app.id,
            buildRunId: input.buildRunId,
            repair: workflowRepair,
            metrics: input.metrics,
            summary: `Rolled back ${workflowRepair.target.workflowName} repair after focused validation: ${focused.reason}`,
          });
          await log(
            input.buildRunId,
            `Workflow repair was rolled back before the full gauntlet: ${focused.reason}`,
          );
          await saveTestingCheckpoint();
          await setStatus(input.buildRunId, "testing");
          continue;
        }

        workflowRepair.status = "focused_validated";
        workflowRepair.validation.fullGauntlet = "pending";
        ineffectiveRoundsByStep.set(step, 0);
        workflowRepairSnapshots.set(workflowRepair.id, beforeFiles);
        upsertWorkflowRepair(input.workflowRepairs, workflowRepair);
        await recordWorkflowRepairArtifact({
          appId: input.app.id,
          buildRunId: input.buildRunId,
          repair: workflowRepair,
          metrics: input.metrics,
          summary: `Focused validation passed for ${workflowRepair.target.workflowName}; starting the complete gauntlet from the proven candidate checkpoint.`,
        });
        await log(
          input.buildRunId,
          `Focused workflow validation passed: ${focused.reason}`,
        );
        await saveTestingCheckpoint();
        await setStatus(input.buildRunId, "testing");
        passedSteps.clear();
        stepIdx = 0;
        continue;
      }
      await saveTestingCheckpoint();
      applyCodegenResult(input.files, fix);
      await runner.deleteFiles(fix.deletedFiles);
      await runner.writeFiles(fix.files);
      pendingFix = {
        step,
        beforeFiles,
        beforeFingerprint: failureFingerprint,
        filesWritten: fix.filesWritten,
        filesDeleted: fix.deletedFiles,
        stepRound,
      };
      await log(
        input.buildRunId,
        `Debug agent changed: ${fix.filesWritten.join(", ")}${fix.deletedFiles.length > 0 ? `; deleted: ${fix.deletedFiles.join(", ")}` : ""}. The repair remains uncheckpointed until the failing step proves progress. ${fix.notes}`,
      );
      await recordBuildAgentArtifact({
        appId: input.app.id,
        buildRunId: input.buildRunId,
        agentKey: "debug_agent",
        phaseKey: `debug-${step}`,
        artifactType: "debug_fix",
        status: "warning",
        summary: summarizeArtifactFiles({
          label: `Debug ${step}`,
          filesWritten: fix.filesWritten,
          filesDeleted: fix.deletedFiles,
        }),
        payload: {
          failedStep: step,
          failedDomain: debugPlan.classification.domain,
          domainLabel: debugPlan.classification.domainLabel,
          focus: debugPlan.classification.focus,
          responsiblePhase: debugPlan.responsiblePhase,
          stepRound,
          totalRounds: input.debugBudget.totalRounds,
          previousAttempts,
          failureFingerprint,
          priorProgress,
          forceFullScope,
          escalationReason,
          suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
          filesInspected: fix.debugDiagnostics.filesInspected,
          inspectionOperations: fix.debugDiagnostics.inspectionOperations,
          preferredInspectionPaths: fix.debugDiagnostics.preferredInspectionPaths,
          visibleFilePaths: fix.debugDiagnostics.visibleFilePaths,
          visibleFileCount: fix.debugDiagnostics.visibleFileCount,
          fullFileCount: fix.debugDiagnostics.fullFileCount,
          limitedScope: fix.debugDiagnostics.limitedScope,
          scopeReason: fix.debugDiagnostics.scopeReason,
          strategyChangedFromPriorAttempts:
            fix.debugDiagnostics.strategyChangedFromPriorAttempts,
          notes: fix.notes,
          filesWritten: fix.filesWritten,
          filesDeleted: fix.deletedFiles,
        },
      });
      await setStatus(input.buildRunId, "testing");
      // Re-run from typecheck (install output can't be affected by src changes).
      stepIdx = Math.min(stepIdx, 1);
      if (step === "install") stepIdx = 0;
    }
  } finally {
    await runner?.dispose();
  }
}

async function publishCheckedBuild(input: {
  app: App;
  buildRunId: string;
  requirement: Requirement;
  spec: AppSpec;
  architecture: ArchitecturePlan;
  files: FileMap;
}): Promise<void> {
  const db = getDb();
  const [existingDeployment] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(eq(deployments.buildRunId, input.buildRunId))
    .orderBy(desc(deployments.createdAt))
    .limit(1);
  if (existingDeployment) return;

  const usesPlatformData = architectureUsesPlatformData(input.architecture);
  const usesPlatformFiles = architectureUsesPlatformFiles(input.architecture);
  const usesPlatformNotifications = architectureUsesPlatformNotifications(
    input.architecture,
  );
  const usesPlatformIntegrations = architectureUsesPlatformIntegrations(
    input.architecture,
  );

  await setStatus(input.buildRunId, "deploying");
  await log(input.buildRunId, "All checks passed. Creating GitHub repo…");
  const repoName = getGeneratedAppName(input.app.slug);
  const repo = await createRepoIfMissing({
    name: repoName,
    description: `${input.app.name} — built by VoiceForge V2. ${input.spec.purpose}`,
    userId: input.app.ownerId,
    appId: input.app.id,
  });

  const branch = `build-${input.buildRunId.slice(0, 8)}`;
  await createBranch({
    repo: repo.repo,
    branch,
    fromBranch: repo.defaultBranch,
  });
  const { commitSha } = await commitFiles({
    repo: repo.repo,
    branch,
    files: input.files,
    message: `VoiceForge V2 build (spec v${input.requirement.version}): ${input.app.name}`,
    userId: input.app.ownerId,
    appId: input.app.id,
  });
  await log(
    input.buildRunId,
    `Committed ${commitSha.slice(0, 7)} to branch ${branch} (${repo.htmlUrl})`,
  );
  await db
    .update(apps)
    .set({ githubRepoUrl: repo.htmlUrl, updatedAt: new Date() })
    .where(eq(apps.id, input.app.id));

  await setStatus(input.buildRunId, "deploying", { commitSha, branch });
  await log(input.buildRunId, "Creating preview deployment on Vercel…");
  const project = await ensureProject({
    name: repoName,
    githubRepo: `${repo.owner}/${repo.repo}`,
    userId: input.app.ownerId,
    appId: input.app.id,
  });
  await db
    .update(apps)
    .set({ vercelProjectId: project.id, updatedAt: new Date() })
    .where(eq(apps.id, input.app.id));

  // Platform-enabled apps: provision server-side env vars on the app's own
  // Vercel project. Secrets never appear in generated browser code.
  if (
    input.spec.aiFeatures.length > 0 ||
    usesPlatformData ||
    usesPlatformFiles ||
    usesPlatformNotifications ||
    usesPlatformIntegrations
  ) {
    let platformToken = input.app.platformToken ?? input.app.aiToken;
    if (!platformToken) platformToken = randomBytes(24).toString("hex");
    const tokenUpdate: {
      platformToken: string;
      updatedAt: Date;
      aiToken?: string;
    } = {
      platformToken,
      updatedAt: new Date(),
    };
    if (input.spec.aiFeatures.length > 0 && !input.app.aiToken) {
      tokenUpdate.aiToken = platformToken;
    }
    await db.update(apps).set(tokenUpdate).where(eq(apps.id, input.app.id));

    const publicUrl = process.env.VOICEFORGE_PUBLIC_URL;
    const vars: Record<string, string> = {
      VOICEFORGE_APP_ID: input.app.id,
      VOICEFORGE_APP_TOKEN: platformToken,
      VOICEFORGE_REQUIRE_SIGN_IN: input.spec.needsLogin ? "1" : "0",
      VOICEFORGE_SHARING_MODEL: input.spec.sharingModel,
      ...(publicUrl ? { VOICEFORGE_PUBLIC_URL: publicUrl } : {}),
    };
    if (input.spec.aiFeatures.length > 0) {
      Object.assign(vars, {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
        AI_MODEL: process.env.OPENAI_GENAPP_MODEL ?? "gpt-5.6-terra",
        AI_IMAGE_MODEL: process.env.OPENAI_GENAPP_IMAGE_MODEL ?? "gpt-image-2",
      });
    }
    await setProjectEnvVars({
      projectId: project.id,
      vars,
      userId: input.app.ownerId,
      appId: input.app.id,
    });
    if (usesPlatformData) {
      await log(input.buildRunId, "Platform data is enabled for this generated app.");
    }
    if (usesPlatformFiles) {
      await log(input.buildRunId, "Platform files are enabled for this generated app.");
    }
    if (usesPlatformNotifications) {
      await log(
        input.buildRunId,
        "Platform notifications and scheduled job metadata are enabled for this generated app.",
      );
    }
    if (usesPlatformIntegrations) {
      await log(
        input.buildRunId,
        "Approved platform integrations are enabled for this generated app.",
      );
    }
    if (input.spec.aiFeatures.length > 0) {
      await log(
        input.buildRunId,
        `AI features enabled (daily limit: ${input.app.aiDailyRequestLimit} requests).` +
          (publicUrl
            ? ""
            : " Warning: VOICEFORGE_PUBLIC_URL is not set, so platform callbacks are INACTIVE for this app."),
      );
    } else if (!publicUrl) {
      await log(
        input.buildRunId,
        "Warning: VOICEFORGE_PUBLIC_URL is not set, so platform data/files/notifications/integrations will not work in the deployed app.",
      );
    }
  }

  const deployment = await createDeployment({
    projectName: repoName,
    githubRepoId: repo.repoId,
    ref: branch,
    production: false,
    userId: input.app.ownerId,
    appId: input.app.id,
  });
  await db.insert(deployments).values({
    appId: input.app.id,
    buildRunId: input.buildRunId,
    environment: "preview",
    vercelDeploymentId: deployment.id,
    status: "building",
  });

  // The run stays in "deploying"; the status endpoint finalizes it
  // (smoke test + awaiting_user_test) once Vercel reports READY.
  await log(
    input.buildRunId,
    "Vercel is building the preview — this page will update when it's ready.",
  );
}

async function runCheckpointReviewGate(input: {
  app: App;
  buildRunId: string;
  spec: AppSpec;
  architecture: ArchitecturePlan;
  files: FileMap;
  generated: CodegenResult;
  debugBudget: DebugBudget;
  metrics: BuildMetrics;
  seededPlatformEntities: unknown[];
  reviewProgress: SerializedReviewProgress;
  completenessSource: HumanCompletenessSourceContext;
  workflowRepairs: WorkflowRepairPackage[];
  includeCompleteness?: boolean;
}): Promise<void> {
  let changedFilePaths = [...input.reviewProgress.changedFilePaths];
  let deletedFilePaths = [...input.reviewProgress.deletedFilePaths];
  const changedFiles: FileMap = Object.fromEntries(
    changedFilePaths.flatMap((path) =>
      path in input.files ? [[path, input.files[path]]] : [],
    ),
  );
  const unchangedRounds = new Map(
    Object.entries(input.reviewProgress.unchangedRoundsByDomain),
  );
  const reviewProgress = (): SerializedReviewProgress => ({
    changedFilePaths: [...changedFilePaths],
    deletedFilePaths: [...deletedFilePaths],
    unchangedRoundsByDomain: Object.fromEntries(unchangedRounds),
    changeMode: input.reviewProgress.changeMode,
  });
  const syncReviewProgress = (): SerializedReviewProgress => {
    const current = reviewProgress();
    input.reviewProgress.changedFilePaths = current.changedFilePaths;
    input.reviewProgress.deletedFilePaths = current.deletedFilePaths;
    input.reviewProgress.unchangedRoundsByDomain =
      current.unchangedRoundsByDomain;
    input.reviewProgress.changeMode = current.changeMode;
    return current;
  };
  const saveReviewCheckpoint = async () => {
    return saveBuildCheckpoint({
      appId: input.app.id,
      buildRunId: input.buildRunId,
      stage: "reviewing",
      files: input.files,
      metadata: durableMetadata({
        generated: input.generated,
        debugBudget: input.debugBudget,
        reviewProgress: syncReviewProgress(),
        metrics: input.metrics,
        seededPlatformEntities: input.seededPlatformEntities,
        workflowRepairs: input.workflowRepairs,
      }),
    });
  };

  let reviews = runPostGenerationReviews({
    spec: input.spec,
    architecture: input.architecture,
    allFiles: agentVisibleFiles(input.files),
    changedFiles,
    changedFilePaths,
    deletedFilePaths,
    changeMode: input.reviewProgress.changeMode,
  });
  await recordPostGenerationReviewArtifacts({
    appId: input.app.id,
    buildRunId: input.buildRunId,
    reviews,
  });
  recordReviewMetrics(input.metrics, reviews);
  const initialWarnings = uniqueStrings(
    reviews.flatMap((review) => review.warnings),
  );
  if (initialWarnings.length > 0) {
    await log(
      input.buildRunId,
      `Generated app review warnings: ${initialWarnings.join(" ")}`,
    );
  }
  let blockingIssues = getPostGenerationBlockingIssues(reviews);

  while (blockingIssues.length > 0) {
    const repairBatch = selectPostGenerationRepairBatch(blockingIssues);
    if (!repairBatch) break;
    const repairIssues = selectWorkflowRepairIssueCluster(repairBatch.issues);
    const budgetStep = `review_gate:${repairBatch.domain}`;
    const priorUnchanged = unchangedRounds.get(repairBatch.domain) ?? 0;
    const { stepRound, previousAttempts } = reserveDebugRound(
      input.debugBudget,
      budgetStep,
    );
    const evidence = createPostGenerationRepairEvidence({
      domain: repairBatch.domain,
      issues: repairIssues,
      reviews,
    });
    const errorOutput = `${repairIssues.join("\n")}\n\nSTRUCTURED REVIEW EVIDENCE:\n${serializeReviewEvidence(evidence)}`;
    const repair = createWorkflowRepairPackage({
      spec: input.spec,
      architecture: input.architecture,
      files: agentVisibleFiles(input.files),
      failedStep: "review_gate",
      errorOutput,
      repairDomain: repairBatch.domain,
      blockingIssues: repairIssues,
      reviews,
      previousAttempts,
      source: input.completenessSource,
    });
    const priorRepair = input.workflowRepairs.find(
      (candidate) => candidate.id === repair.id,
    );
    if (priorRepair) repair.attempts = [...priorRepair.attempts];
    upsertWorkflowRepair(input.workflowRepairs, repair);
    await recordWorkflowRepairArtifact({
      appId: input.app.id,
      buildRunId: input.buildRunId,
      repair,
      metrics: input.metrics,
      summary: `Classified ${repair.target.workflowName}: ${repair.classification.category.replaceAll("_", " ")} (${repair.classification.confidence} confidence).`,
    });
    if (repair.classification.targetSurface === "external_environment") {
      await saveReviewCheckpoint();
      throw new Error(
        "A workflow review depends on an external service that is currently unavailable. Generated source was preserved; retry when the provider is available.",
      );
    }
    repair.rollback = {
      checkpointId: await saveReviewCheckpoint(),
      checkpointStage: "reviewing",
    };
    upsertWorkflowRepair(input.workflowRepairs, repair);
    const repairFiles = workflowRepairVisibleFiles(input.files, repair);
    const debugPlan = createPhaseAwareDebugPlan({
      spec: input.spec,
      files: repairFiles,
      failedStep: "review_gate",
      errorOutput,
      generatedPhases: input.generated.phases,
      changedFilePaths,
      forceFullScope: false,
      escalationReason:
        priorUnchanged > 0
          ? "A prior workflow-scoped candidate did not improve the named finding. Change strategy inside the same producer-consumer graph; unrelated files remain protected."
          : undefined,
    });
    recordDebugRoundMetric(input.metrics, {
      step: "review_gate",
      domain: debugPlan.classification.domain,
      focus: debugPlan.classification.focus,
      responsiblePhaseId: debugPlan.responsiblePhase.id,
      responsibleAgentKey: debugPlan.responsiblePhase.agentKey,
    });
    await setStatus(input.buildRunId, "debugging");
    await log(
      input.buildRunId,
      `Workflow repair round ${stepRound}/${MAX_DEBUG_ROUNDS_PER_STEP}: ${repair.classification.category.replaceAll("_", " ")} in ${repair.target.workflowName}. Scope: ${repair.scope.mutationPaths.length} mutable and ${repair.scope.protectedPaths.length} protected files.`,
    );
    const fix = await runDebugAgent({
      spec: input.spec,
      currentFiles: repairFiles,
      failedStep: "review_gate",
      errorOutput,
      previousAttempts,
      debugContext: debugPlan.context,
      workflowRepair: repair,
    });
    recordDebugAttempt(
      input.debugBudget,
      budgetStep,
      fix.debugDiagnostics.suspectedRootCause ||
        fix.notes ||
        "The resumed review repair produced no useful source change.",
    );

    const scopeAssessment = validateWorkflowRepairMutationScope({
      repair,
      filesWritten: fix.filesWritten,
      filesDeleted: fix.deletedFiles,
    });
    if (
      (fix.filesWritten.length === 0 && fix.deletedFiles.length === 0) ||
      !scopeAssessment.ok
    ) {
      const rounds = priorUnchanged + 1;
      unchangedRounds.set(repairBatch.domain, rounds);
      repair.status = "rolled_back";
      repair.attempts.push({
        round: stepRound,
        strategy: fix.notes || "No source patch was produced.",
        suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
        filesInspected: fix.debugDiagnostics.filesInspected,
        filesWritten: fix.filesWritten,
        filesDeleted: fix.deletedFiles,
        outcome: "rolled_back",
        reason: scopeAssessment.ok
          ? "The workflow diagnosis produced no actionable source change."
          : scopeAssessment.reason,
      });
      upsertWorkflowRepair(input.workflowRepairs, repair);
      await saveReviewCheckpoint();
      await recordWorkflowRepairArtifact({
        appId: input.app.id,
        buildRunId: input.buildRunId,
        repair,
        metrics: input.metrics,
        summary: `Rolled back ${repair.target.workflowName} repair: ${repair.attempts.at(-1)?.reason}`,
      });
      if (rounds >= 2) {
        throw new Error(
          `${repairBatch.domain} static review still could not identify an actionable repair. VoiceForge preserved the best checkpoint; this likely needs a reviewer-rule improvement.`,
        );
      }
      continue;
    }

    const beforeFiles: FileMap = { ...input.files };
    const beforeChangedFiles: FileMap = { ...changedFiles };
    const beforeChangedPaths = [...changedFilePaths];
    const beforeDeletedPaths = [...deletedFilePaths];
    applyCodegenResult(input.files, fix);
    Object.assign(changedFiles, fix.files);
    fix.deletedFiles.forEach((path) => delete changedFiles[path]);
    changedFilePaths = uniqueStrings([
      ...changedFilePaths,
      ...fix.filesWritten,
    ]);
    deletedFilePaths = uniqueStrings([
      ...deletedFilePaths,
      ...fix.deletedFiles,
    ]);
    const candidateReviews = runPostGenerationReviews({
      spec: input.spec,
      architecture: input.architecture,
      allFiles: agentVisibleFiles(input.files),
      changedFiles,
      changedFilePaths,
      deletedFilePaths,
      changeMode: input.reviewProgress.changeMode,
    });
    const candidateIssues = getPostGenerationBlockingIssues(candidateReviews);
    const assessment = assessWorkflowRepairCandidate({
      repair,
      currentBlockingIssues: candidateIssues,
    });
    const candidateProgressed = assessment.accepted || assessment.improved;
    const rounds = candidateProgressed ? 0 : priorUnchanged + 1;
    unchangedRounds.set(repairBatch.domain, rounds);

    if (candidateProgressed) {
      repair.status = assessment.accepted ? "focused_validated" : "candidate";
      repair.validation.staticReview = assessment.accepted
        ? "passed"
        : "pending";
      repair.validation.targetResolved = assessment.targetResolved;
      repair.validation.unrelatedFindingsAdded =
        assessment.unrelatedFindingsAdded;
      reviews = candidateReviews;
      blockingIssues = candidateIssues;
      await recordPostGenerationReviewArtifacts({
        appId: input.app.id,
        buildRunId: input.buildRunId,
        reviews,
        rerunRound: stepRound,
      });
      recordReviewMetrics(input.metrics, reviews);
      const acceptedWarnings = uniqueStrings(
        reviews.flatMap((review) => review.warnings),
      );
      if (acceptedWarnings.length > 0) {
        await log(
          input.buildRunId,
          `Generated app review warnings: ${acceptedWarnings.join(" ")}`,
        );
      }
    } else {
      repair.status = "rolled_back";
      repair.validation.staticReview = "failed";
      repair.validation.targetResolved = assessment.targetResolved;
      repair.validation.unrelatedFindingsAdded =
        assessment.unrelatedFindingsAdded;
      restoreFileMap(input.files, beforeFiles);
      restoreFileMap(changedFiles, beforeChangedFiles);
      changedFilePaths = beforeChangedPaths;
      deletedFilePaths = beforeDeletedPaths;
    }
    repair.attempts.push({
      round: stepRound,
      strategy: fix.notes,
      suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
      filesInspected: fix.debugDiagnostics.filesInspected,
      filesWritten: fix.filesWritten,
      filesDeleted: fix.deletedFiles,
      outcome: candidateProgressed ? "candidate" : "rolled_back",
      reason: assessment.reason,
    });
    upsertWorkflowRepair(input.workflowRepairs, repair);
    await recordWorkflowRepairArtifact({
      appId: input.app.id,
      buildRunId: input.buildRunId,
      repair,
      metrics: input.metrics,
      summary: assessment.accepted
        ? `Focused static validation passed for ${repair.target.workflowName}; the candidate remains subject to targeted tests and the full gauntlet.`
        : assessment.improved
          ? `Checkpointed improving ${repair.target.workflowName} repair: ${assessment.reason}`
          : `Rolled back ${repair.target.workflowName} repair: ${assessment.reason}`,
    });
    await log(
      input.buildRunId,
      assessment.accepted
        ? `Accepted and checkpointed resumed ${repairBatch.domain} repair: ${assessment.reason}`
        : assessment.improved
          ? `Checkpointed partial ${repairBatch.domain} progress and will continue from it: ${assessment.reason}`
          : `Rolled back resumed ${repairBatch.domain} repair: ${assessment.reason}`,
    );
    await saveReviewCheckpoint();
    if (!candidateProgressed && rounds >= 2) {
      throw new Error(
        `${repairBatch.domain} static review could not validate an improving repair after two resumed attempts. VoiceForge preserved the best generated source; this may be a reviewer limitation.`,
      );
    }
  }

  if (input.includeCompleteness === false) {
    if (
      reviews
        .flatMap((review) => review.warnings)
        .some((warning) =>
          warning.startsWith("acceptance_test:browser_arbitration"),
        )
    ) {
      await log(
        input.buildRunId,
        "Static acceptance review deferred helper-based evidence to the generated Playwright journeys; the e2e result will arbitrate it.",
      );
    }
    await log(
      input.buildRunId,
      "Updated deterministic workflow reviews passed before resumed checks.",
    );
    syncReviewProgress();
    return;
  }

  const runCompletenessReview = async (
    deterministicReviews: readonly PostGenerationReview[],
  ) => {
    const evidence = createHumanCompletenessEvidence({
      spec: input.spec,
      architecture: input.architecture,
      files: agentVisibleFiles(input.files),
      source: input.completenessSource,
      changedFilePaths,
      deletedFilePaths,
      phases: input.generated.phases,
      deterministicReviews,
    });
    return runHumanCompletenessReviewer({
      evidence,
      files: agentVisibleFiles(input.files),
    });
  };

  let completenessReport = await runCompletenessReview(reviews);
  let completenessReview = humanCompletenessPostGenerationReview(
    completenessReport,
  );
  await recordPostGenerationReviewArtifacts({
    appId: input.app.id,
    buildRunId: input.buildRunId,
    reviews: [completenessReview],
  });
  recordReviewMetrics(input.metrics, [completenessReview]);
  await log(input.buildRunId, completenessReview.summary);

  while (completenessReview.blockingIssues.length > 0) {
    const domain = "completeness" as const;
    const budgetStep = `review_gate:${domain}`;
    const priorUnchanged = unchangedRounds.get(domain) ?? 0;
    const { stepRound, previousAttempts } = reserveDebugRound(
      input.debugBudget,
      budgetStep,
    );
    const allReviews = [...reviews, completenessReview];
    const repairIssues = selectWorkflowRepairIssueCluster(
      completenessReview.blockingIssues,
    );
    const evidence = createPostGenerationRepairEvidence({
      domain,
      issues: repairIssues,
      reviews: allReviews,
    });
    const errorOutput = `${repairIssues.join("\n")}\n\nSTRUCTURED PRODUCT COMPLETENESS EVIDENCE:\n${serializeReviewEvidence(evidence)}`;
    const repair = createWorkflowRepairPackage({
      spec: input.spec,
      architecture: input.architecture,
      files: agentVisibleFiles(input.files),
      failedStep: "review_gate",
      errorOutput,
      repairDomain: domain,
      blockingIssues: repairIssues,
      reviews: allReviews,
      previousAttempts,
      source: input.completenessSource,
    });
    const priorRepair = input.workflowRepairs.find(
      (candidate) => candidate.id === repair.id,
    );
    if (priorRepair) repair.attempts = [...priorRepair.attempts];
    upsertWorkflowRepair(input.workflowRepairs, repair);
    await recordWorkflowRepairArtifact({
      appId: input.app.id,
      buildRunId: input.buildRunId,
      repair,
      metrics: input.metrics,
      summary: `Classified product-promise repair for ${repair.target.workflowName}: ${repair.classification.category.replaceAll("_", " ")}.`,
    });
    const repairFiles = workflowRepairVisibleFiles(input.files, repair);
    const debugPlan = createPhaseAwareDebugPlan({
      spec: input.spec,
      files: repairFiles,
      failedStep: "review_gate",
      errorOutput,
      generatedPhases: input.generated.phases,
      changedFilePaths,
      forceFullScope: false,
      escalationReason:
        priorUnchanged > 0
          ? "A prior product-completeness repair did not improve the promised user outcome. Trace the named workflow through its route, components, persistence path, and generated acceptance journey before changing strategy."
          : undefined,
    });
    recordDebugRoundMetric(input.metrics, {
      step: budgetStep,
      domain: debugPlan.classification.domain,
      focus: debugPlan.classification.focus,
      responsiblePhaseId: debugPlan.responsiblePhase.id,
      responsibleAgentKey: debugPlan.responsiblePhase.agentKey,
    });
    repair.rollback = {
      checkpointId: await saveReviewCheckpoint(),
      checkpointStage: "reviewing",
    };
    upsertWorkflowRepair(input.workflowRepairs, repair);
    await setStatus(input.buildRunId, "debugging");
    await log(
      input.buildRunId,
      `Product workflow repair round ${stepRound}/${MAX_DEBUG_ROUNDS_PER_STEP}; ${repair.scope.mutationPaths.length} files may change and ${repair.scope.protectedPaths.length} remain protected.`,
    );
    const fix = await runDebugAgent({
      spec: input.spec,
      currentFiles: repairFiles,
      failedStep: "review_gate",
      errorOutput,
      previousAttempts,
      debugContext: debugPlan.context,
      workflowRepair: repair,
    });
    recordDebugAttempt(
      input.debugBudget,
      budgetStep,
      fix.debugDiagnostics.suspectedRootCause ||
        fix.notes ||
        "The product-completeness repair produced no useful source change.",
    );

    const scopeAssessment = validateWorkflowRepairMutationScope({
      repair,
      filesWritten: fix.filesWritten,
      filesDeleted: fix.deletedFiles,
    });
    if (
      (fix.filesWritten.length === 0 && fix.deletedFiles.length === 0) ||
      !scopeAssessment.ok
    ) {
      const rounds = priorUnchanged + 1;
      unchangedRounds.set(domain, rounds);
      repair.status = "rolled_back";
      repair.attempts.push({
        round: stepRound,
        strategy: fix.notes || "No source patch was produced.",
        suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
        filesInspected: fix.debugDiagnostics.filesInspected,
        filesWritten: fix.filesWritten,
        filesDeleted: fix.deletedFiles,
        outcome: "rolled_back",
        reason: scopeAssessment.ok
          ? "The product workflow diagnosis produced no source change."
          : scopeAssessment.reason,
      });
      upsertWorkflowRepair(input.workflowRepairs, repair);
      await saveReviewCheckpoint();
      await recordWorkflowRepairArtifact({
        appId: input.app.id,
        buildRunId: input.buildRunId,
        repair,
        metrics: input.metrics,
        summary: `Rolled back product workflow repair: ${repair.attempts.at(-1)?.reason}`,
      });
      await recordBuildAgentArtifact({
        appId: input.app.id,
        buildRunId: input.buildRunId,
        agentKey: "pipeline_observer",
        phaseKey: "review-repair-completeness",
        artifactType: "review_gate",
        status: rounds >= 2 ? "failed" : "warning",
        summary:
          "Product completeness repair produced no source changes; the best checkpoint remains active.",
        payload: {
          outcome: "possible_reviewer_limitation",
          stepRound,
          unchangedRounds: rounds,
          evidence,
          suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
          filesInspected: fix.debugDiagnostics.filesInspected,
        },
      });
      if (rounds >= 2) {
        throw new Error(
          "Product completeness review still could not identify an actionable repair. VoiceForge preserved the best checkpoint; this likely needs a reviewer-rule improvement.",
        );
      }
      continue;
    }

    const beforeFiles: FileMap = { ...input.files };
    const beforeChangedFiles: FileMap = { ...changedFiles };
    const beforeChangedPaths = [...changedFilePaths];
    const beforeDeletedPaths = [...deletedFilePaths];
    applyCodegenResult(input.files, fix);
    Object.assign(changedFiles, fix.files);
    fix.deletedFiles.forEach((path) => delete changedFiles[path]);
    changedFilePaths = uniqueStrings([
      ...changedFilePaths,
      ...fix.filesWritten,
    ]);
    deletedFilePaths = uniqueStrings([
      ...deletedFilePaths,
      ...fix.deletedFiles,
    ]);

    const candidateReviews = runPostGenerationReviews({
      spec: input.spec,
      architecture: input.architecture,
      allFiles: agentVisibleFiles(input.files),
      changedFiles,
      changedFilePaths,
      deletedFilePaths,
      changeMode: input.reviewProgress.changeMode,
    });
    const candidateStaticIssues = getPostGenerationBlockingIssues(
      candidateReviews,
    );
    const candidateCompletenessReport =
      candidateStaticIssues.length === 0
        ? await runCompletenessReview(candidateReviews)
        : completenessReport;
    const candidateCompletenessReview =
      humanCompletenessPostGenerationReview(candidateCompletenessReport);
    const candidateCompletenessIssues = candidateCompletenessReport.available
      ? candidateCompletenessReview.blockingIssues
      : completenessReview.blockingIssues;
    const assessment = assessPostGenerationRepair({
      domain,
      previousIssues: completenessReview.blockingIssues,
      currentIssues: [
        ...candidateStaticIssues,
        ...candidateCompletenessIssues,
      ],
    });
    const rounds = assessment.accepted ? 0 : priorUnchanged + 1;
    unchangedRounds.set(domain, rounds);

    if (assessment.accepted) {
      repair.status = "focused_validated";
      repair.validation.staticReview = "passed";
      repair.validation.targetResolved = true;
      reviews = candidateReviews;
      blockingIssues = candidateStaticIssues;
      completenessReport = candidateCompletenessReport;
      completenessReview = candidateCompletenessReview;
      await recordPostGenerationReviewArtifacts({
        appId: input.app.id,
        buildRunId: input.buildRunId,
        reviews: [...reviews, completenessReview],
        rerunRound: stepRound,
      });
      recordReviewMetrics(input.metrics, [...reviews, completenessReview]);
    } else {
      repair.status = "rolled_back";
      repair.validation.staticReview = "failed";
      restoreFileMap(input.files, beforeFiles);
      restoreFileMap(changedFiles, beforeChangedFiles);
      changedFilePaths = beforeChangedPaths;
      deletedFilePaths = beforeDeletedPaths;
    }
    repair.attempts.push({
      round: stepRound,
      strategy: fix.notes,
      suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
      filesInspected: fix.debugDiagnostics.filesInspected,
      filesWritten: fix.filesWritten,
      filesDeleted: fix.deletedFiles,
      outcome: assessment.accepted ? "candidate" : "rolled_back",
      reason: assessment.reason,
    });
    upsertWorkflowRepair(input.workflowRepairs, repair);
    await saveReviewCheckpoint();
    await recordWorkflowRepairArtifact({
      appId: input.app.id,
      buildRunId: input.buildRunId,
      repair,
      metrics: input.metrics,
      summary: assessment.accepted
        ? `Focused product-workflow review passed for ${repair.target.workflowName}; tests remain pending.`
        : `Rolled back product-workflow repair: ${assessment.reason}`,
    });
    await recordBuildAgentArtifact({
      appId: input.app.id,
      buildRunId: input.buildRunId,
      agentKey: "pipeline_observer",
      phaseKey: "review-repair-completeness",
      artifactType: "review_gate",
      status: assessment.accepted ? "passed" : rounds >= 2 ? "failed" : "warning",
      summary: assessment.accepted
        ? `Accepted product completeness repair: ${assessment.reason}`
        : `Rolled back product completeness repair: ${assessment.reason}`,
      payload: {
        outcome: assessment.accepted ? "accepted" : "rolled_back",
        stepRound,
        assessment,
        evidence,
        suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
        filesInspected: fix.debugDiagnostics.filesInspected,
        filesWritten: fix.filesWritten,
        filesDeleted: fix.deletedFiles,
      },
    });
    await log(
      input.buildRunId,
      assessment.accepted
        ? `Accepted and checkpointed product completeness repair: ${assessment.reason}`
        : `Rolled back product completeness repair: ${assessment.reason}`,
    );
    if (!assessment.accepted && rounds >= 2) {
      throw new Error(
        "Product completeness review could not validate an improving repair after two attempts. VoiceForge preserved the best generated source; this may be a reviewer limitation.",
      );
    }
  }

  if (
    reviews
      .flatMap((review) => review.warnings)
      .some((warning) =>
        warning.startsWith("acceptance_test:browser_arbitration"),
      )
  ) {
    await log(
      input.buildRunId,
      "Static acceptance review deferred helper-based evidence to the generated Playwright journeys; the e2e result will arbitrate it.",
    );
  }
  syncReviewProgress();
  await log(input.buildRunId, "Generated app workflow reviews passed.");
}

export async function resumeBuildPipelineContinuation(
  appId: string,
  options?: {
    buildRunId?: string;
    force?: boolean;
    resetDebugBudget?: boolean;
  },
): Promise<void> {
  const db = getDb();
  const [run] = options?.buildRunId
    ? await db
        .select()
        .from(buildRuns)
        .where(
          and(
            eq(buildRuns.id, options.buildRunId),
            eq(buildRuns.appId, appId),
          ),
        )
        .limit(1)
    : await db
        .select()
        .from(buildRuns)
        .where(eq(buildRuns.appId, appId))
        .orderBy(desc(buildRuns.createdAt))
        .limit(1);
  if (
    !run ||
    (!options?.force &&
      (!["testing", "debugging", "deploying"].includes(run.status) ||
        !shouldResumeAbandonedWorker(run)))
  ) {
    return;
  }

  const checkpoint = await loadLatestBuildCheckpoint<DurableBuildMetadata>(
    run.id,
  );
  if (!checkpoint) return;

  const [existingDeployment] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(eq(deployments.buildRunId, run.id))
    .orderBy(desc(deployments.createdAt))
    .limit(1);
  if (existingDeployment) return;

  const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
  if (!app) return;
  if (!isBuildCheckpointCompatible(checkpoint.metadata)) {
    await markBuildFailed({
      app,
      buildRunId: run.id,
      requirementId: run.requirementId,
      message:
        "This build checkpoint was created by an older VoiceForge pipeline. Use Build again to start a clean build with the current generator.",
    });
    return;
  }
  const [requirement] = run.requirementId
    ? await db
        .select()
        .from(requirements)
        .where(eq(requirements.id, run.requirementId))
        .limit(1)
    : [];
  if (!requirement) return;
  const [sourceChangeRequest] = await db
    .select({ description: changeRequests.description })
    .from(changeRequests)
    .where(eq(changeRequests.requirementId, requirement.id))
    .limit(1);
  const completenessSource = await loadHumanCompletenessSourceContext({
    requirement,
    changeSummary: sourceChangeRequest?.description,
  });
  const [architectureRow] = await db
    .select()
    .from(architecturePlans)
    .where(eq(architecturePlans.buildRunId, run.id))
    .limit(1);
  if (!architectureRow) return;

  const spec = normalizeAppSpec(requirement.spec);
  const storedArchitecture = architectureRow.plan as ArchitecturePlan;
  const architecture = ensureWorkflowContracts(
    spec,
    storedArchitecture,
  );
  if (
    storedArchitecture.workflowContractVersion !==
      architecture.workflowContractVersion ||
    !storedArchitecture.workflowContracts?.length
  ) {
    await db
      .update(architecturePlans)
      .set({ plan: architecture })
      .where(eq(architecturePlans.id, architectureRow.id));
  }

  try {
    if (checkpoint.stage === "publish_pending") {
      await log(
        run.id,
        "Resuming durable publishing from the saved source checkpoint…",
      );
      await publishCheckedBuild({
        app,
        buildRunId: run.id,
        requirement,
        spec,
        architecture,
        files: checkpoint.files,
      });
      return;
    }

    const refreshedTemplateFiles = await refreshResumedTemplateFiles(
      checkpoint.files,
      {
        slug: app.slug,
        name: app.name,
        purpose: spec.purpose,
      },
    );
    if (refreshedTemplateFiles.length > 0) {
      await log(
        run.id,
        `Refreshed locked testing helpers in the durable checkpoint: ${refreshedTemplateFiles.join(", ")}.`,
      );
    }

    await log(
      run.id,
      checkpoint.stage === "reviewing"
        ? "Resuming workflow reviews from the best saved source checkpoint…"
        : "Resuming checks from the saved source checkpoint…",
    );
    const metadata = checkpoint.metadata;
    const generated = restoreGeneratedResult(metadata.generated);
    const refreshedAcceptance = refreshDeterministicAcceptanceCompiler({
      spec,
      architecture,
      files: checkpoint.files,
      generated,
      changeMode: Boolean(app.githubRepoUrl && requirement.version > 1),
    });
    if (refreshedAcceptance.refreshedPaths.length > 0) {
      await log(
        run.id,
        `Recompiled deterministic acceptance artifacts in the durable checkpoint: ${refreshedAcceptance.refreshedPaths.join(", ")}.`,
      );
    }
    const metrics = restoreBuildMetrics(metadata.metrics);
    const debugBudget = options?.resetDebugBudget
      ? createDebugBudget({
          maxRoundsPerStep: MAX_DEBUG_ROUNDS_PER_STEP,
          maxTotalRounds: MAX_TOTAL_DEBUG_ROUNDS,
        })
      : restoreDebugBudget(metadata.debugBudget);
    const debugProgress = options?.resetDebugBudget
      ? undefined
      : restoreDebugProgress(metadata.debugProgress);
    const seededPlatformEntities = restoreSeededPlatformEntities(
      metadata.seededPlatformEntities,
    );
    const workflowRepairs = restoreWorkflowRepairPackages(
      metadata.workflowRepairs,
    );
    const changeMode = Boolean(app.githubRepoUrl && requirement.version > 1);
    const reviewProgress = restoreReviewProgress(
      metadata.reviewProgress,
      generated,
      changeMode,
    );
    if (options?.resetDebugBudget) {
      reviewProgress.unchangedRoundsByDomain = {};
    }
    const recheckTestingCheckpoint =
      checkpoint.stage === "testing" && options?.resetDebugBudget === true;
    if (checkpoint.stage === "reviewing" || recheckTestingCheckpoint) {
      if (recheckTestingCheckpoint) {
        await log(
          run.id,
          "Rechecking the saved source with the latest deterministic workflow and acceptance rules before resuming browser tests…",
        );
      }
      await runCheckpointReviewGate({
        app,
        buildRunId: run.id,
        spec,
        architecture,
        files: checkpoint.files,
        generated,
        debugBudget,
        metrics,
        seededPlatformEntities,
        reviewProgress,
        completenessSource,
        workflowRepairs,
        includeCompleteness: !recheckTestingCheckpoint,
      });
      await saveBuildCheckpoint({
        appId: app.id,
        buildRunId: run.id,
        stage: "testing",
        files: checkpoint.files,
        metadata: durableMetadata({
          generated,
          debugBudget,
          reviewProgress,
          metrics,
          seededPlatformEntities,
          workflowRepairs,
        }),
      });
      await log(
        run.id,
        `Workflow reviews passed; durable testing checkpoint saved (${Object.keys(checkpoint.files).length} files).`,
      );
    }

    await runTestGauntlet({
      app,
      buildRunId: run.id,
      spec,
      architecture,
      completenessSource,
      files: checkpoint.files,
      generated,
      debugBudget,
      debugProgress,
      metrics,
      seededPlatformEntities,
      workflowRepairs,
      reviewProgress,
    });
    await saveBuildCheckpoint({
      appId: app.id,
      buildRunId: run.id,
      stage: "publish_pending",
      files: checkpoint.files,
      metadata: durableMetadata({
        generated,
        debugBudget,
        reviewProgress,
        metrics,
        seededPlatformEntities,
        workflowRepairs,
      }),
    });
    await log(
      run.id,
      `Durable checkpoint saved for publishing (${Object.keys(checkpoint.files).length} files).`,
    );
    await recordBuildMetricsArtifact({
      appId: app.id,
      buildRunId: run.id,
      metrics,
    });
    await publishCheckedBuild({
      app,
      buildRunId: run.id,
      requirement,
      spec,
      architecture,
      files: checkpoint.files,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markBuildFailed({
      app,
      buildRunId: run.id,
      requirementId: run.requirementId,
      message,
    });
  }
}

async function markBuildFailed(input: {
  app: App;
  buildRunId: string;
  requirementId: string | null;
  message: string;
}): Promise<void> {
  const db = getDb();
  await log(input.buildRunId, `Build failed: ${input.message}`);
  await setStatus(input.buildRunId, "failed", {
    errorMessage: input.message,
    finishedAt: new Date(),
  });
  await db
    .update(apps)
    .set({
      status: appStatusAfterBuildFailure(input.app),
      updatedAt: new Date(),
    })
    .where(eq(apps.id, input.app.id));
  if (input.requirementId) {
    await db
      .update(changeRequests)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(changeRequests.requirementId, input.requirementId));
  }
  await audit({
    userId: input.app.ownerId,
    appId: input.app.id,
    buildRunId: input.buildRunId,
    action: "build.failed",
    payload: { error: input.message },
  });
  await notifyBuildFailure(db, {
    appId: input.app.id,
    buildRunId: input.buildRunId,
    message: input.message,
  });
}

function appStatusAfterNeedsInput(app: App): App["status"] {
  if (app.productionUrl) return "deployed";
  if (app.previewUrl) return "testing";
  return "spec_approved";
}

function appStatusAfterBuildFailure(app: App): App["status"] {
  if (app.productionUrl) return "deployed";
  if (app.previewUrl) return "testing";
  return "failed";
}

async function notifyBuildFailure(
  db: ReturnType<typeof getDb>,
  input: { appId: string; buildRunId: string; message: string },
): Promise<void> {
  try {
    await sendVoiceForgeBuildNotification(db, {
      appId: input.appId,
      templateKey: "build_failed",
      title: "Build failed",
      message: `Your app build failed: ${input.message}`,
      payload: {
        buildRunId: input.buildRunId,
        error: input.message,
      },
    });
  } catch (error) {
    console.error("Build failure notification failed:", error);
  }
}

function runDependencySecurityStep(files: FileMap): {
  step: "dependencies";
  ok: boolean;
  output: string;
  durationMs: number;
  failureFingerprint?: FailureFingerprint;
} {
  const started = Date.now();
  const result = validateGeneratedAppDependencies(files);
  const output = result.ok
    ? "Generated app dependency check passed."
    : result.problems
        .map((problem) => `${problem.path}: ${problem.message}`)
        .join("\n");
  return {
    step: "dependencies",
    ok: result.ok,
    output,
    durationMs: Date.now() - started,
    failureFingerprint: result.ok
      ? undefined
      : createFailureFingerprint("dependencies", output),
  };
}
