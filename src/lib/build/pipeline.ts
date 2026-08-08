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
  comparePostGenerationIssueSets,
  getPostGenerationBlockingIssues,
  shouldStopUnchangedInterfaceRepairs,
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
  loadLatestBuildCheckpoint,
  saveBuildCheckpoint,
} from "./checkpoints";
import { loadTemplate, type FileMap } from "./template";
import { createRunner, type Runner, type StepName } from "./runner";
import {
  ensureWorkflowContracts,
  validateWorkflowContracts,
} from "../workflow-contract";

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
  metrics: BuildMetrics;
  seededPlatformEntities: unknown[];
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

function durableMetadata(input: {
  generated: CodegenResult;
  debugBudget: DebugBudget;
  debugProgress?: SerializedDebugProgress;
  metrics: BuildMetrics;
  seededPlatformEntities: unknown[];
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
    metrics: input.metrics,
    seededPlatformEntities: input.seededPlatformEntities,
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
    errorMessage: string;
    commitSha: string;
    branch: string;
    startedAt: Date;
    finishedAt: Date;
  }> = {},
): Promise<void> {
  const db = getDb();
  await db
    .update(buildRuns)
    .set({ status, ...extra })
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
    recordGeneratedPhaseMetrics(metrics, generated.phases);
    for (const phase of generated.phases) {
      await log(
        buildRunId,
        `Generation phase complete: ${phase.label} [${phase.agentKey}] (${phase.filesWritten.length} changed, ${phase.filesDeleted.length} deleted). ${phase.notes}`,
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
        },
      });
    }
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
    const debugBudget = createDebugBudget({
      maxRoundsPerStep: MAX_DEBUG_ROUNDS_PER_STEP,
      maxTotalRounds: MAX_TOTAL_DEBUG_ROUNDS,
    });
    const reviewChangedFiles: FileMap = { ...generated.files };
    let reviewChangedFilePaths = [...generated.filesWritten];
    let reviewDeletedFilePaths = [...generated.deletedFiles];
    let postGenerationReviews = runPostGenerationReviews({
      spec,
      architecture: architectureForStorage,
      allFiles: agentVisibleFiles(files),
      changedFiles: reviewChangedFiles,
      changedFilePaths: reviewChangedFilePaths,
      deletedFilePaths: reviewDeletedFilePaths,
      changeMode,
    });
    await recordPostGenerationReviewArtifacts({
      appId: app.id,
      buildRunId,
      reviews: postGenerationReviews,
    });
    recordReviewMetrics(metrics, postGenerationReviews);
    let postGenerationWarnings = uniqueStrings(
      postGenerationReviews.flatMap((review) => review.warnings),
    );
    if (postGenerationWarnings.length > 0) {
      await log(
        buildRunId,
        `Generated app review warnings: ${postGenerationWarnings.join(" ")}`,
      );
    }
    let postGenerationBlockingIssues =
      getPostGenerationBlockingIssues(postGenerationReviews);
    let previousPostGenerationBlockingIssues = [
      ...postGenerationBlockingIssues,
    ];
    let consecutiveUnchangedContractRounds = 0;
    while (postGenerationBlockingIssues.length > 0) {
      const step = "review_gate";
      const { stepRound, previousAttempts } = reserveDebugRound(
        debugBudget,
        step,
      );
      const errorOutput = postGenerationBlockingIssues.join("\n");
      const debugPlan = createPhaseAwareDebugPlan({
        spec,
        files: agentVisibleFiles(files),
        failedStep: step,
        errorOutput,
        generatedPhases: generated.phases,
        changedFilePaths: reviewChangedFilePaths,
        forceFullScope: consecutiveUnchangedContractRounds > 0,
        escalationReason:
          consecutiveUnchangedContractRounds > 0
            ? "The prior repair left the interface or persistence contract findings unchanged. Trace the complete contracted workflow, including its visible control, exact save payload, fresh-load path, and downstream consumer. Avoid changing authentication unless the finding is specifically about role reachability."
            : undefined,
      });
      recordDebugRoundMetric(metrics, {
        step,
        domain: debugPlan.classification.domain,
        focus: debugPlan.classification.focus,
        responsiblePhaseId: debugPlan.responsiblePhase.id,
        responsibleAgentKey: debugPlan.responsiblePhase.agentKey,
      });

      await setStatus(buildRunId, "debugging");
      await log(
        buildRunId,
        `Generated app review failed — phase-aware debug round ${stepRound}/${MAX_DEBUG_ROUNDS_PER_STEP} for ${debugPlan.classification.domainLabel} (${debugBudget.totalRounds}/${MAX_TOTAL_DEBUG_ROUNDS} total). Responsible phase: ${debugPlan.responsiblePhase.label}. Scope: ${debugPlan.scope.visibleFileCount}/${debugPlan.scope.fullFileCount} files.`,
      );
      const fix = await runDebugAgent({
        spec,
        currentFiles: debugPlan.scope.scopedFiles,
        failedStep: step,
        errorOutput,
        previousAttempts,
        debugContext: debugPlan.context,
      });
      if (fix.filesWritten.length === 0) {
        await recordBuildAgentArtifact({
          appId: app.id,
          buildRunId,
          agentKey: "debug_agent",
          phaseKey: `debug-${step}`,
          artifactType: "debug_fix",
          status: "failed",
          summary: `Phase-aware debug ${step} produced no file changes.`,
          payload: {
            failedStep: step,
            failedDomain: debugPlan.classification.domain,
            domainLabel: debugPlan.classification.domainLabel,
            focus: debugPlan.classification.focus,
            responsiblePhase: debugPlan.responsiblePhase,
            stepRound,
            totalRounds: debugBudget.totalRounds,
            previousAttempts,
            suspectedRootCause: fix.debugDiagnostics.suspectedRootCause,
            filesInspected: fix.debugDiagnostics.filesInspected,
            preferredInspectionPaths:
              fix.debugDiagnostics.preferredInspectionPaths,
            visibleFileCount: fix.debugDiagnostics.visibleFileCount,
            fullFileCount: fix.debugDiagnostics.fullFileCount,
            strategyChangedFromPriorAttempts:
              fix.debugDiagnostics.strategyChangedFromPriorAttempts,
            notes: fix.notes,
          },
        });
        throw new Error(`Debug agent could not produce a fix for ${step}`);
      }
      recordDebugAttempt(
        debugBudget,
        step,
        fix.debugDiagnostics.suspectedRootCause ||
          fix.notes ||
          `(rewrote ${fix.filesWritten.join(", ")})`,
      );
      applyCodegenResult(files, fix);
      Object.assign(reviewChangedFiles, fix.files);
      for (const deleted of fix.deletedFiles) {
        delete reviewChangedFiles[deleted];
      }
      reviewChangedFilePaths = uniqueStrings([
        ...reviewChangedFilePaths,
        ...fix.filesWritten,
      ]);
      reviewDeletedFilePaths = uniqueStrings([
        ...reviewDeletedFilePaths,
        ...fix.deletedFiles,
      ]);
      await log(
        buildRunId,
        `Debug agent changed: ${fix.filesWritten.join(", ")}${fix.deletedFiles.length > 0 ? `; deleted: ${fix.deletedFiles.join(", ")}` : ""}. ${fix.notes}`,
      );
      await recordBuildAgentArtifact({
        appId: app.id,
        buildRunId,
        agentKey: "debug_agent",
        phaseKey: `debug-${step}`,
        artifactType: "debug_fix",
        status: "warning",
        summary: summarizeArtifactFiles({
          label: `Phase-aware debug ${step}`,
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
          totalRounds: debugBudget.totalRounds,
          previousAttempts,
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

      postGenerationReviews = runPostGenerationReviews({
        spec,
        architecture: architectureForStorage,
        allFiles: agentVisibleFiles(files),
        changedFiles: reviewChangedFiles,
        changedFilePaths: reviewChangedFilePaths,
        deletedFilePaths: reviewDeletedFilePaths,
        changeMode,
      });
      await recordPostGenerationReviewArtifacts({
        appId: app.id,
        buildRunId,
        reviews: postGenerationReviews,
        rerunRound: stepRound,
      });
      recordReviewMetrics(metrics, postGenerationReviews);
      postGenerationWarnings = uniqueStrings(
        postGenerationReviews.flatMap((review) => review.warnings),
      );
      if (postGenerationWarnings.length > 0) {
        await log(
          buildRunId,
          `Generated app review warnings: ${postGenerationWarnings.join(" ")}`,
        );
      }
      const nextPostGenerationBlockingIssues =
        getPostGenerationBlockingIssues(postGenerationReviews);
      const issueProgress = comparePostGenerationIssueSets(
        previousPostGenerationBlockingIssues,
        nextPostGenerationBlockingIssues,
      );
      const contractReviewOnly = nextPostGenerationBlockingIssues.every(
        (issue) =>
          issue.startsWith("ui_affordance:") ||
          issue.startsWith("persistence_handoff:"),
      );
      consecutiveUnchangedContractRounds =
        contractReviewOnly && issueProgress.status === "unchanged"
          ? consecutiveUnchangedContractRounds + 1
          : 0;
      if (nextPostGenerationBlockingIssues.length > 0) {
        await log(
          buildRunId,
          `Generated review repair progress: ${issueProgress.status}; ${previousPostGenerationBlockingIssues.length} -> ${nextPostGenerationBlockingIssues.length} blocking issue(s).`,
        );
      }
      if (
        shouldStopUnchangedInterfaceRepairs(
          consecutiveUnchangedContractRounds,
        )
      ) {
        await recordBuildAgentArtifact({
          appId: app.id,
          buildRunId,
          agentKey: "pipeline_observer",
          phaseKey: "workflow-contract-review-stagnation",
          artifactType: "review_gate",
          status: "failed",
          summary:
            "Stopped generated-app rewrites because the interface/persistence review findings were unchanged after two consecutive repair rounds.",
          payload: {
            stepRound,
            outcome: "stopped_unchanged_contract_repairs",
            unchangedRounds: consecutiveUnchangedContractRounds,
            blockingIssues: nextPostGenerationBlockingIssues,
            filesWritten: fix.filesWritten,
            filesDeleted: fix.deletedFiles,
          },
        });
        throw new Error(
          "Interface/persistence review findings were unchanged after two consecutive repair rounds; stopped rewriting the generated app.",
        );
      }
      previousPostGenerationBlockingIssues = [
        ...nextPostGenerationBlockingIssues,
      ];
      postGenerationBlockingIssues = nextPostGenerationBlockingIssues;
    }
    await log(buildRunId, "Generated app reviews passed.");

    await saveBuildCheckpoint({
      appId: app.id,
      buildRunId,
      stage: "testing",
      files,
      metadata: durableMetadata({
        generated,
        debugBudget,
        metrics,
        seededPlatformEntities,
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
      files,
      generated,
      debugBudget,
      metrics,
      seededPlatformEntities,
    });

    await saveBuildCheckpoint({
      appId: app.id,
      buildRunId,
      stage: "publish_pending",
      files,
      metadata: durableMetadata({
        generated,
        debugBudget,
        metrics,
        seededPlatformEntities,
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
  files: FileMap;
  generated: CodegenResult;
  debugBudget: DebugBudget;
  debugProgress?: SerializedDebugProgress;
  metrics: BuildMetrics;
  seededPlatformEntities: unknown[];
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
    const getPendingFix = (): PendingDebugFix | null => pendingFix;

    const saveTestingCheckpoint = async () => {
      await saveBuildCheckpoint({
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
        }),
      });
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

      // Browser tests need Chromium, which isn't available in the cloud
      // sandbox image yet — record as skipped there rather than failing.
      if (step === "e2e" && runner.kind === "sandbox") {
        await db.insert(testResults).values({
          buildRunId: input.buildRunId,
          suite: "e2e",
          status: "skipped",
          summary: "browser tests (skipped on cloud builds)",
        });
        await log(input.buildRunId, "Skipping browser tests on cloud build.");
        stepIdx++;
        continue;
      }

      await log(input.buildRunId, `Running ${step}…`);
      const result =
        step === "dependencies"
          ? runDependencySecurityStep(input.files)
          : await runner.run(step);

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

      if (result.ok) {
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

      const { stepRound, previousAttempts } = reserveDebugRound(
        input.debugBudget,
        step,
      );
      const debugPlan = createPhaseAwareDebugPlan({
        spec: input.spec,
        files: agentVisibleFiles(input.files),
        failedStep: step,
        errorOutput: debugErrorOutput,
        generatedPhases: input.generated.phases,
        forceFullScope,
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
      await saveTestingCheckpoint();

      await setStatus(input.buildRunId, "debugging");
      await log(
        input.buildRunId,
        `${step} failed — phase-aware debug round ${stepRound}/${MAX_DEBUG_ROUNDS_PER_STEP} for ${debugPlan.classification.domainLabel} (${input.debugBudget.totalRounds}/${MAX_TOTAL_DEBUG_ROUNDS} total). Responsible phase: ${debugPlan.responsiblePhase.label}. Scope: ${debugPlan.scope.visibleFileCount}/${debugPlan.scope.fullFileCount} files${forceFullScope ? " (escalated after repeated ineffective repairs)" : ""}.`,
      );
      const beforeFiles = { ...input.files };
      const fix = await runDebugAgent({
        spec: input.spec,
        currentFiles: debugPlan.scope.scopedFiles,
        failedStep: step,
        errorOutput: debugErrorOutput,
        previousAttempts,
        debugContext: debugPlan.context,
      });
      if (fix.filesWritten.length === 0) {
        await recordBuildAgentArtifact({
          appId: input.app.id,
          buildRunId: input.buildRunId,
          agentKey: "debug_agent",
          phaseKey: `debug-${step}`,
          artifactType: "debug_fix",
          status: "failed",
          summary: `Debug ${step} produced no file changes.`,
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
            notes: fix.notes,
          },
        });
        throw new Error(`Debug agent could not produce a fix for ${step}`);
      }
      recordDebugAttempt(
        input.debugBudget,
        step,
        fix.debugDiagnostics.suspectedRootCause ||
          fix.notes ||
          `(rewrote ${fix.filesWritten.join(", ")})`,
      );
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

export async function resumeBuildPipelineContinuation(
  appId: string,
): Promise<void> {
  const db = getDb();
  const [run] = await db
    .select()
    .from(buildRuns)
    .where(eq(buildRuns.appId, appId))
    .orderBy(desc(buildRuns.createdAt))
    .limit(1);
  if (
    !run ||
    !["testing", "debugging", "deploying"].includes(run.status) ||
    !shouldResumeAbandonedWorker(run)
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
  const [requirement] = run.requirementId
    ? await db
        .select()
        .from(requirements)
        .where(eq(requirements.id, run.requirementId))
        .limit(1)
    : [];
  if (!requirement) return;
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

    await log(run.id, "Resuming checks from the saved source checkpoint…");
    const metadata = checkpoint.metadata;
    const generated = restoreGeneratedResult(metadata.generated);
    const metrics = restoreBuildMetrics(metadata.metrics);
    const debugBudget = restoreDebugBudget(metadata.debugBudget);
    const debugProgress = restoreDebugProgress(metadata.debugProgress);
    const seededPlatformEntities = restoreSeededPlatformEntities(
      metadata.seededPlatformEntities,
    );

    await runTestGauntlet({
      app,
      buildRunId: run.id,
      spec,
      files: checkpoint.files,
      generated,
      debugBudget,
      debugProgress,
      metrics,
      seededPlatformEntities,
    });
    await saveBuildCheckpoint({
      appId: app.id,
      buildRunId: run.id,
      stage: "publish_pending",
      files: checkpoint.files,
      metadata: durableMetadata({
        generated,
        debugBudget,
        metrics,
        seededPlatformEntities,
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
