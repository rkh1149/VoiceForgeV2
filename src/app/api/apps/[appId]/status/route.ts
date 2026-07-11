import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { apps, buildRuns, testResults } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { failStaleRuns } from "@/lib/quota";
import { finalizePendingDeployment } from "@/lib/build/finalize";

/** Poll endpoint for the app detail page: latest build run + test results.
 * Also advances pending deployments and reaps stale runs (the UI polls this
 * while builds are active, making it a cheap heartbeat). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { appId } = await params;
  if (!z.string().uuid().safeParse(appId).success) {
    return NextResponse.json({ error: "Invalid app id" }, { status: 400 });
  }

  const db = getDb();
  const appRows = await db
    .select()
    .from(apps)
    .where(
      user.role === "admin"
        ? eq(apps.id, appId)
        : and(eq(apps.id, appId), eq(apps.ownerId, user.id)),
    )
    .limit(1);
  const app = appRows[0];
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  // Heartbeat duties: reap dead runs, advance pending deployments.
  try {
    await failStaleRuns(appId);
    await finalizePendingDeployment(appId);
  } catch (err) {
    console.error("Status heartbeat error:", err);
  }

  // Re-read the app: the finalizer may have just updated it.
  const [freshApp] = await db
    .select()
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  const currentApp = freshApp ?? app;

  const runs = await db
    .select()
    .from(buildRuns)
    .where(eq(buildRuns.appId, appId))
    .orderBy(desc(buildRuns.createdAt))
    .limit(1);
  const latestRun = runs[0] ?? null;

  const results = latestRun
    ? await db
        .select({
          suite: testResults.suite,
          status: testResults.status,
          summary: testResults.summary,
          details: testResults.details,
          createdAt: testResults.createdAt,
        })
        .from(testResults)
        .where(eq(testResults.buildRunId, latestRun.id))
        .orderBy(testResults.createdAt)
    : [];

  // Attach output only for the most recent failed check (for diagnosis).
  const lastFailed = [...results].reverse().find((r) => r.status === "failed");
  const failedOutput =
    lastFailed && latestRun?.status === "failed"
      ? ((lastFailed.details as { output?: string } | null)?.output ?? null)
      : null;

  return NextResponse.json({
    app: {
      id: currentApp.id,
      name: currentApp.name,
      description: currentApp.description,
      status: currentApp.status,
      githubRepoUrl: currentApp.githubRepoUrl,
      previewUrl: currentApp.previewUrl,
      productionUrl: currentApp.productionUrl,
    },
    buildRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          errorMessage: latestRun.errorMessage,
          logs: latestRun.logs,
          startedAt: latestRun.startedAt,
          finishedAt: latestRun.finishedAt,
        }
      : null,
    testResults: results.map((r) => ({
      suite: r.suite,
      status: r.status,
      summary: r.summary,
      createdAt: r.createdAt,
    })),
    failedOutput,
  });
}
