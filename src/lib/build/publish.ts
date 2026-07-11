import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apps, buildRuns, deployments } from "@/db/schema";
import { audit } from "@/lib/audit";
import { createRepoIfMissing, mergeToDefault } from "@/lib/github";
import { createDeployment } from "@/lib/vercel";

/**
 * Production publish (Stage 3): merge the approved build branch to main and
 * create a production deployment. Runs async; progress via buildRun status.
 */
export async function publishToProduction(opts: {
  appId: string;
  buildRunId: string;
  branch: string;
  userId: string;
}): Promise<void> {
  const db = getDb();
  const { appId, buildRunId, branch, userId } = opts;

  const logLine = async (message: string) => {
    const rows = await db
      .select({ logs: buildRuns.logs })
      .from(buildRuns)
      .where(eq(buildRuns.id, buildRunId))
      .limit(1);
    const logs = (rows[0]?.logs ?? []) as Array<{ ts: string; message: string }>;
    logs.push({ ts: new Date().toISOString(), message });
    await db.update(buildRuns).set({ logs }).where(eq(buildRuns.id, buildRunId));
  };

  try {
    const [app] = await db
      .select()
      .from(apps)
      .where(eq(apps.id, appId))
      .limit(1);
    if (!app) throw new Error("App not found");

    const repoName = `voiceforge-${app.slug}`;
    const repo = await createRepoIfMissing({
      name: repoName,
      description: app.description ?? app.name,
      userId,
      appId,
    });

    await logLine(`Publishing: merging ${branch} into ${repo.defaultBranch}…`);
    await mergeToDefault({
      repo: repo.repo,
      branch,
      defaultBranch: repo.defaultBranch,
      message: `Publish ${app.name} (approved by owner)`,
      userId,
      appId,
    });

    await logLine("Creating production deployment on Vercel…");
    const deployment = await createDeployment({
      projectName: repoName,
      githubRepoId: repo.repoId,
      ref: repo.defaultBranch,
      production: true,
      userId,
      appId,
    });
    await db.insert(deployments).values({
      appId,
      buildRunId,
      environment: "production",
      vercelDeploymentId: deployment.id,
      status: "building",
    });

    // The run stays in "deploying"; the status endpoint finalizes it
    // (live URL + "deployed") once Vercel reports READY.
    await logLine(
      "Vercel is building the production version — this page will update when it's live.",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logLine(`Publish failed: ${message}`);
    await db
      .update(buildRuns)
      .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
      .where(eq(buildRuns.id, buildRunId));
    await audit({
      userId,
      appId,
      buildRunId,
      action: "app.publishFailed",
      payload: { error: message },
    });
  }
}
