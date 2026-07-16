import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  architecturePlans,
  apps,
  buildRuns,
  changeRequests,
  deployments,
  requirements,
  testResults,
} from "@/db/schema";
import { computeSpecComplexity, normalizeAppSpec } from "@/lib/spec";
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
import { seedPlatformEntitySchemasFromSpec } from "@/lib/platform/spec-seeding";
import { randomBytes } from "crypto";
import { loadTemplate, type FileMap } from "./template";
import { createRunner, type Runner, type StepName } from "./runner";

/**
 * Build pipeline (Stage 2): approved spec -> generated code -> local test
 * gauntlet with a bounded debug loop -> GitHub repo with a passing commit.
 * All state lives in the database so the UI can poll it.
 */

const STEP_ORDER: StepName[] = [
  "install",
  "typecheck",
  "lint",
  "test",
  "build",
  "e2e",
];
const MAX_DEBUG_ROUNDS = 5;

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
  StepName,
  "typecheck" | "lint" | "unit" | "build" | "e2e"
> = {
  install: "build",
  typecheck: "typecheck",
  lint: "lint",
  test: "unit",
  build: "build",
  e2e: "e2e",
};

type LogEntry = { ts: string; message: string };

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

/**
 * Runs the full pipeline. Call without awaiting from request handlers:
 *   void startBuildPipeline(id).catch(...)
 */
export async function startBuildPipeline(buildRunId: string): Promise<void> {
  const db = getDb();
  let runner: Runner | null = null;

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
    const architecture = shouldUseArchitectAgent()
      ? await runArchitectAgent({ spec, complexity })
      : createFallbackArchitecturePlan(spec, complexity);
    const architectureValidation = validateArchitecturePlan(architecture);
    const architectureForStorage = {
      ...architecture,
      capabilityValidation: {
        ...architecture.capabilityValidation,
        canBuildNow: architectureValidation.canBuildNow,
        blockingIssues: architectureValidation.blockingIssues,
        warnings: architectureValidation.warnings,
      },
    };

    await db.insert(architecturePlans).values({
      appId: app.id,
      requirementId: requirement.id,
      buildRunId,
      capabilityTier: architectureForStorage.implementationTier,
      complexityScore: architectureForStorage.complexityScore,
      canBuildNow: architectureValidation.canBuildNow,
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
        canBuildNow: architectureValidation.canBuildNow,
        blockingIssues: architectureValidation.blockingIssues,
        warnings: architectureValidation.warnings,
      },
    });
    await log(buildRunId, `Architecture: ${architectureForStorage.summary}`);
    if (architectureValidation.warnings.length > 0) {
      await log(
        buildRunId,
        `Architecture warnings: ${architectureValidation.warnings.join(" ")}`,
      );
    }
    if (!architectureValidation.canBuildNow) {
      throw new ArchitectureBlockedError(
        `This app needs platform capabilities that are not available in VoiceForge V2 yet: ${architectureValidation.blockingIssues.join(" ")}`,
        architectureValidation.blockingIssues,
      );
    }

    const usesPlatformData = architectureUsesPlatformData(architectureForStorage);
    if (usesPlatformData) {
      await log(buildRunId, "Seeding platform data schemas…");
      const seededEntities = await seedPlatformEntitySchemasFromSpec(db, {
        appId: app.id,
        user: { id: app.ownerId, role: "user" },
        spec,
      });
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
      const currentSrc = await getRepoSrcFiles({
        repo: repo.repo,
        branch: repo.defaultBranch,
      });
      // Current app code replaces template placeholders; configs stay fresh.
      Object.assign(files, currentSrc);

      await log(
        buildRunId,
        `Applying change: ${changeRequest?.description ?? "updated specification"}`,
      );
      generated = await runChangeCodeAgent({
        spec,
        changeSummary:
          changeRequest?.description ?? "Apply the updated specification.",
        currentFiles: agentVisibleFiles(files),
        architecture: architectureForStorage,
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
    for (const phase of generated.phases) {
      await log(
        buildRunId,
        `Generation phase complete: ${phase.label} (${phase.filesWritten.length} changed, ${phase.filesDeleted.length} deleted). ${phase.notes}`,
      );
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

    // 2. Test gauntlet with bounded debug loop.
    runner = await createRunner(buildRunId);
    await log(
      buildRunId,
      runner.kind === "sandbox"
        ? "Testing in an isolated cloud sandbox…"
        : "Testing on the local build machine…",
    );
    await runner.writeFiles(files);
    await setStatus(buildRunId, "testing");

    let debugRounds = 0;
    let stepIdx = 0;
    const debugNotes: string[] = [];
    while (stepIdx < STEP_ORDER.length) {
      const step = STEP_ORDER[stepIdx];

      // Browser tests need Chromium, which isn't available in the cloud
      // sandbox image yet — record as skipped there rather than failing.
      if (step === "e2e" && runner.kind === "sandbox") {
        await db.insert(testResults).values({
          buildRunId,
          suite: "e2e",
          status: "skipped",
          summary: "browser tests (skipped on cloud builds)",
        });
        await log(buildRunId, "Skipping browser tests on cloud build.");
        stepIdx++;
        continue;
      }

      await log(buildRunId, `Running ${step}…`);
      const result = await runner.run(step);

      await db.insert(testResults).values({
        buildRunId,
        suite: SUITE_FOR_STEP[step],
        status: result.ok ? "passed" : "failed",
        summary: `${step} (${Math.round(result.durationMs / 1000)}s)`,
        details: { output: result.output },
      });

      if (result.ok) {
        await log(buildRunId, `${step} passed.`);
        stepIdx++;
        continue;
      }

      debugRounds++;
      if (debugRounds > MAX_DEBUG_ROUNDS) {
        throw new Error(
          `${step} still failing after ${MAX_DEBUG_ROUNDS} debug rounds`,
        );
      }

      await setStatus(buildRunId, "debugging");
      await log(
        buildRunId,
        `${step} failed — debug round ${debugRounds}/${MAX_DEBUG_ROUNDS}…`,
      );
      const fix = await runDebugAgent({
        spec,
        currentFiles: agentVisibleFiles(files),
        failedStep: step,
        errorOutput: result.output,
        previousAttempts: debugNotes,
      });
      if (fix.filesWritten.length === 0) {
        throw new Error(`Debug agent could not produce a fix for ${step}`);
      }
      debugNotes.push(fix.notes || `(rewrote ${fix.filesWritten.join(", ")})`);
      applyCodegenResult(files, fix);
      await runner.deleteFiles(fix.deletedFiles);
      await runner.writeFiles(fix.files);
      await log(
        buildRunId,
        `Debug agent changed: ${fix.filesWritten.join(", ")}${fix.deletedFiles.length > 0 ? `; deleted: ${fix.deletedFiles.join(", ")}` : ""}. ${fix.notes}`,
      );
      await setStatus(buildRunId, "testing");
      // Re-run from typecheck (install output can't be affected by src changes).
      stepIdx = Math.min(stepIdx, 1);
      if (step === "install") stepIdx = 0;
    }

    // 3. Push the passing code to a build branch on GitHub.
    await log(buildRunId, "All checks passed. Creating GitHub repo…");
    const repoName = getGeneratedAppName(app.slug);
    const repo = await createRepoIfMissing({
      name: repoName,
      description: `${app.name} — built by VoiceForge V2. ${spec.purpose}`,
      userId: app.ownerId,
      appId: app.id,
    });

    const branch = `build-${buildRunId.slice(0, 8)}`;
    await createBranch({
      repo: repo.repo,
      branch,
      fromBranch: repo.defaultBranch,
    });
    const { commitSha } = await commitFiles({
      repo: repo.repo,
      branch,
      files,
      message: `VoiceForge V2 build (spec v${requirement.version}): ${app.name}`,
      userId: app.ownerId,
      appId: app.id,
    });
    await log(
      buildRunId,
      `Committed ${commitSha.slice(0, 7)} to branch ${branch} (${repo.htmlUrl})`,
    );
    await db
      .update(apps)
      .set({ githubRepoUrl: repo.htmlUrl, updatedAt: new Date() })
      .where(eq(apps.id, app.id));

    // 4. Preview deployment on Vercel + smoke test.
    await setStatus(buildRunId, "deploying", { commitSha, branch });
    await log(buildRunId, "Creating preview deployment on Vercel…");
    const project = await ensureProject({
      name: repoName,
      githubRepo: `${repo.owner}/${repo.repo}`,
      userId: app.ownerId,
      appId: app.id,
    });
    await db
      .update(apps)
      .set({ vercelProjectId: project.id, updatedAt: new Date() })
      .where(eq(apps.id, app.id));

    // Platform-enabled apps: provision server-side env vars on the app's own
    // Vercel project. Secrets never appear in generated browser code.
    if (spec.aiFeatures.length > 0 || usesPlatformData) {
      let platformToken = app.platformToken ?? app.aiToken;
      if (!platformToken) platformToken = randomBytes(24).toString("hex");
      const tokenUpdate: {
        platformToken: string;
        updatedAt: Date;
        aiToken?: string;
      } = {
        platformToken,
        updatedAt: new Date(),
      };
      if (spec.aiFeatures.length > 0 && !app.aiToken) {
        tokenUpdate.aiToken = platformToken;
      }
      await db.update(apps).set(tokenUpdate).where(eq(apps.id, app.id));

      const publicUrl = process.env.VOICEFORGE_PUBLIC_URL;
      const vars: Record<string, string> = {
        VOICEFORGE_APP_ID: app.id,
        VOICEFORGE_APP_TOKEN: platformToken,
        ...(publicUrl ? { VOICEFORGE_PUBLIC_URL: publicUrl } : {}),
      };
      if (spec.aiFeatures.length > 0) {
        Object.assign(vars, {
          OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
          AI_MODEL: process.env.OPENAI_GENAPP_MODEL ?? "gpt-5.6-terra",
          AI_IMAGE_MODEL: process.env.OPENAI_GENAPP_IMAGE_MODEL ?? "gpt-image-2",
        });
      }
      await setProjectEnvVars({
        projectId: project.id,
        vars,
        userId: app.ownerId,
        appId: app.id,
      });
      if (usesPlatformData) {
        await log(buildRunId, "Platform data is enabled for this generated app.");
      }
      if (spec.aiFeatures.length > 0) {
        await log(
          buildRunId,
          `AI features enabled (daily limit: ${app.aiDailyRequestLimit} requests).` +
            (publicUrl
              ? ""
              : " Warning: VOICEFORGE_PUBLIC_URL is not set, so platform callbacks are INACTIVE for this app."),
        );
      } else if (!publicUrl) {
        await log(
          buildRunId,
          "Warning: VOICEFORGE_PUBLIC_URL is not set, so platform data will not work in the deployed app.",
        );
      }
    }

    const deployment = await createDeployment({
      projectName: repoName,
      githubRepoId: repo.repoId,
      ref: branch,
      production: false,
      userId: app.ownerId,
      appId: app.id,
    });
    await db.insert(deployments).values({
      appId: app.id,
      buildRunId,
      environment: "preview",
      vercelDeploymentId: deployment.id,
      status: "building",
    });

    // The run stays in "deploying"; the status endpoint finalizes it
    // (smoke test + awaiting_user_test) once Vercel reports READY.
    await log(
      buildRunId,
      "Vercel is building the preview — this page will update when it's ready.",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ArchitectureBlockedError) {
      await log(buildRunId, `Build needs input: ${message}`);
      await setStatus(buildRunId, "needs_input", {
        errorMessage: message,
        finishedAt: new Date(),
      });
      await db
        .update(apps)
        .set({
          status: app.productionUrl ? "deployed" : "spec_approved",
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
    // A failed change build must not mark a live app as failed.
    await db
      .update(apps)
      .set({
        status: app.productionUrl ? "deployed" : "failed",
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
  } finally {
    await runner?.dispose();
  }
}
