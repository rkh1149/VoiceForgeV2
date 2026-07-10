import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  apps,
  buildRuns,
  requirements,
  testResults,
} from "@/db/schema";
import type { AppSpec } from "@/lib/spec";
import { audit } from "@/lib/audit";
import { runCodeAgent, runDebugAgent } from "@/lib/agents/coder";
import { createRepoIfMissing, commitFiles } from "@/lib/github";
import { loadTemplate, type FileMap } from "./template";
import { runStep, workspaceDir, writeWorkspace, type StepName } from "./runner";

/**
 * Build pipeline (Stage 2): approved spec -> generated code -> local test
 * gauntlet with a bounded debug loop -> GitHub repo with a passing commit.
 * All state lives in the database so the UI can poll it.
 */

const STEP_ORDER: StepName[] = ["install", "typecheck", "lint", "test", "build"];
const MAX_DEBUG_ROUNDS = 5;

const SUITE_FOR_STEP: Record<StepName, "typecheck" | "lint" | "unit" | "build"> =
  {
    install: "build",
    typecheck: "typecheck",
    lint: "lint",
    test: "unit",
    build: "build",
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
    | "complete"
    | "failed",
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

function srcOnly(files: FileMap): FileMap {
  return Object.fromEntries(
    Object.entries(files).filter(([p]) => p.startsWith("src/")),
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

  const spec = requirement.spec as AppSpec;

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
      payload: { requirementVersion: requirement.version },
    });

    // 1. Assemble files: locked template + generated code.
    await log(buildRunId, "Loading app template…");
    const files = await loadTemplate({
      slug: app.slug,
      name: app.name,
      purpose: spec.purpose,
    });

    await log(buildRunId, `Generating code for "${app.name}"…`);
    const generated = await runCodeAgent(spec);
    Object.assign(files, generated.files);
    await log(
      buildRunId,
      `Code agent wrote ${generated.filesWritten.length} files: ${generated.filesWritten.join(", ")}`,
    );
    if (generated.notes) await log(buildRunId, `Code agent notes: ${generated.notes}`);
    if (generated.filesWritten.length === 0) {
      throw new Error("Code agent produced no files");
    }

    // 2. Test gauntlet with bounded debug loop.
    const dir = workspaceDir(buildRunId);
    await writeWorkspace(dir, files);
    await setStatus(buildRunId, "testing");

    let debugRounds = 0;
    let stepIdx = 0;
    const debugNotes: string[] = [];
    while (stepIdx < STEP_ORDER.length) {
      const step = STEP_ORDER[stepIdx];
      await log(buildRunId, `Running ${step}…`);
      const result = await runStep(dir, step);

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
        currentFiles: srcOnly(files),
        failedStep: step,
        errorOutput: result.output,
        previousAttempts: debugNotes,
      });
      if (fix.filesWritten.length === 0) {
        throw new Error(`Debug agent could not produce a fix for ${step}`);
      }
      debugNotes.push(fix.notes || `(rewrote ${fix.filesWritten.join(", ")})`);
      Object.assign(files, fix.files);
      await writeWorkspace(dir, fix.files);
      await log(
        buildRunId,
        `Debug agent rewrote: ${fix.filesWritten.join(", ")}. ${fix.notes}`,
      );
      await setStatus(buildRunId, "testing");
      // Re-run from typecheck (install output can't be affected by src changes).
      stepIdx = Math.min(stepIdx, 1);
      if (step === "install") stepIdx = 0;
    }

    // 3. Push the passing code to GitHub.
    await log(buildRunId, "All checks passed. Creating GitHub repo…");
    const repoName = `voiceforge-${app.slug}`;
    const repo = await createRepoIfMissing({
      name: repoName,
      description: `${app.name} — built by VoiceForge. ${spec.purpose}`,
      userId: app.ownerId,
      appId: app.id,
    });

    const { commitSha } = await commitFiles({
      repo: repo.repo,
      branch: repo.defaultBranch,
      files,
      message: `VoiceForge build (spec v${requirement.version}): ${app.name}`,
      userId: app.ownerId,
      appId: app.id,
    });
    await log(buildRunId, `Committed ${commitSha.slice(0, 7)} to ${repo.htmlUrl}`);

    await db
      .update(apps)
      .set({
        githubRepoUrl: repo.htmlUrl,
        status: "testing",
        updatedAt: new Date(),
      })
      .where(eq(apps.id, app.id));
    await setStatus(buildRunId, "complete", {
      commitSha,
      branch: repo.defaultBranch,
      finishedAt: new Date(),
    });
    await audit({
      userId: app.ownerId,
      appId: app.id,
      buildRunId,
      action: "build.completed",
      payload: { commitSha, repo: repo.htmlUrl },
    });
    await log(buildRunId, "Build complete. Deployment comes in Stage 3.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(buildRunId, `Build failed: ${message}`);
    await setStatus(buildRunId, "failed", {
      errorMessage: message,
      finishedAt: new Date(),
    });
    await db
      .update(apps)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(apps.id, app.id));
    await audit({
      userId: app.ownerId,
      appId: app.id,
      buildRunId,
      action: "build.failed",
      payload: { error: message },
    });
  }
}
