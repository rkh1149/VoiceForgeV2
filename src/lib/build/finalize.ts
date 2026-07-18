import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apps, buildRuns, changeRequests, deployments, testResults } from "@/db/schema";
import { audit } from "@/lib/audit";
import { sendVoiceForgeBuildNotification } from "@/lib/platform/notifications";
import { getDeployment, smokeTest } from "@/lib/vercel";

/**
 * Deployment finalizer (Stage 6).
 * The pipeline/publish flows END after creating a Vercel deployment; the
 * status endpoint (already polled by the UI) calls this to check Vercel,
 * run the smoke test, and complete the transition. This keeps serverless
 * function time low so hosted builds fit within plan limits.
 * Idempotent: does nothing unless there's a deployment in "building".
 */
export async function finalizePendingDeployment(appId: string): Promise<void> {
  const db = getDb();

  const [run] = await db
    .select()
    .from(buildRuns)
    .where(eq(buildRuns.appId, appId))
    .orderBy(desc(buildRuns.createdAt))
    .limit(1);
  if (!run || run.status !== "deploying") return;

  const [dep] = await db
    .select()
    .from(deployments)
    .where(
      and(eq(deployments.buildRunId, run.id), eq(deployments.status, "building")),
    )
    .orderBy(desc(deployments.createdAt))
    .limit(1);
  if (!dep?.vercelDeploymentId) return;

  const info = await getDeployment(dep.vercelDeploymentId);
  if (!info) return;
  const { readyState } = info;
  if (readyState !== "READY" && readyState !== "ERROR" && readyState !== "CANCELED") {
    return; // still building — poll again later
  }

  const logLine = async (message: string) => {
    const rows = await db
      .select({ logs: buildRuns.logs })
      .from(buildRuns)
      .where(eq(buildRuns.id, run.id))
      .limit(1);
    const logs = (rows[0]?.logs ?? []) as Array<{ ts: string; message: string }>;
    logs.push({ ts: new Date().toISOString(), message });
    await db.update(buildRuns).set({ logs }).where(eq(buildRuns.id, run.id));
  };

  const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
  if (!app) return;

  // Failure path (either environment).
  if (readyState !== "READY") {
    await db
      .update(deployments)
      .set({ status: "error" })
      .where(eq(deployments.id, dep.id));
    const message = `Vercel ${dep.environment} deployment ended in state ${readyState}`;
    await logLine(message);
    await db
      .update(buildRuns)
      .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
      .where(eq(buildRuns.id, run.id));
    await db
      .update(apps)
      .set({
        status: app.productionUrl ? "deployed" : "failed",
        updatedAt: new Date(),
      })
      .where(eq(apps.id, appId));
    await notifyBuildFailure(db, {
      appId,
      buildRunId: run.id,
      message,
    });
    return;
  }

  if (dep.environment === "preview") {
    const previewUrl = `https://${info.url}`;
    const smoke = await smokeTest(info.url);
    await db.insert(testResults).values({
      buildRunId: run.id,
      suite: "smoke",
      status: smoke.ok ? "passed" : "failed",
      summary: "smoke test against preview",
      details: { output: smoke.detail },
    });
    if (!smoke.ok) {
      await db
        .update(deployments)
        .set({ status: "error", url: previewUrl })
        .where(eq(deployments.id, dep.id));
      const message = `Smoke test failed: ${smoke.detail}`;
      await logLine(message);
      await db
        .update(buildRuns)
        .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
        .where(eq(buildRuns.id, run.id));
      await db
        .update(apps)
        .set({
          status: app.productionUrl ? "deployed" : "failed",
          updatedAt: new Date(),
        })
        .where(eq(apps.id, appId));
      await notifyBuildFailure(db, {
        appId,
        buildRunId: run.id,
        message,
      });
      return;
    }

    await db
      .update(deployments)
      .set({ status: "ready", url: previewUrl })
      .where(eq(deployments.id, dep.id));
    await db
      .update(apps)
      .set({ previewUrl, status: "testing", updatedAt: new Date() })
      .where(eq(apps.id, appId));
    await db
      .update(buildRuns)
      .set({ status: "awaiting_user_test" })
      .where(eq(buildRuns.id, run.id));
    if (run.requirementId) {
      await db
        .update(changeRequests)
        .set({ status: "complete", updatedAt: new Date() })
        .where(eq(changeRequests.requirementId, run.requirementId));
    }
    await audit({
      userId: app.ownerId,
      appId,
      buildRunId: run.id,
      action: "build.previewReady",
      payload: { previewUrl },
    });
    await notifyPreviewReady(db, {
      appId,
      buildRunId: run.id,
      previewUrl,
    });
    await logLine(
      `Preview is live: ${previewUrl} — try the app, then press Publish to put it online for real.`,
    );
    return;
  }

  // Production.
  const alias = info.alias?.find((a) => a.endsWith(".vercel.app"));
  const productionUrl = `https://${alias ?? info.url}`;
  await db
    .update(deployments)
    .set({ status: "ready", url: productionUrl })
    .where(eq(deployments.id, dep.id));
  await db
    .update(apps)
    .set({ productionUrl, status: "deployed", updatedAt: new Date() })
    .where(eq(apps.id, appId));
  await db
    .update(buildRuns)
    .set({ status: "complete", finishedAt: new Date() })
    .where(eq(buildRuns.id, run.id));
  await audit({
    userId: app.ownerId,
    appId,
    buildRunId: run.id,
    action: "app.published",
    payload: { productionUrl },
  });
  await logLine(`Your app is live: ${productionUrl}`);
}

async function notifyPreviewReady(
  db: ReturnType<typeof getDb>,
  input: { appId: string; buildRunId: string; previewUrl: string },
): Promise<void> {
  try {
    await sendVoiceForgeBuildNotification(db, {
      appId: input.appId,
      templateKey: "build_preview_ready",
      title: "Preview ready",
      message: `Your app preview is ready to test: ${input.previewUrl}`,
      payload: {
        buildRunId: input.buildRunId,
        previewUrl: input.previewUrl,
      },
    });
  } catch (error) {
    console.error("Preview-ready notification failed:", error);
  }
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
