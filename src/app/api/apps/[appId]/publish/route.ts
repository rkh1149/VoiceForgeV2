import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { apps, approvals, buildRuns } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { audit } from "@/lib/audit";
import { publishToProduction } from "@/lib/build/publish";

/**
 * The owner pressed "Publish": record a deploy_production approval, then
 * merge the build branch to main and deploy to production.
 */
export async function POST(
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
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.ownerId, user.id)))
    .limit(1);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  // The latest build must be waiting for the user's test.
  const [latestRun] = await db
    .select()
    .from(buildRuns)
    .where(eq(buildRuns.appId, appId))
    .orderBy(desc(buildRuns.createdAt))
    .limit(1);
  if (!latestRun || latestRun.status !== "awaiting_user_test") {
    return NextResponse.json(
      { error: "There is no tested build waiting to be published." },
      { status: 409 },
    );
  }
  if (!latestRun.branch) {
    return NextResponse.json(
      { error: "This build has no branch recorded." },
      { status: 500 },
    );
  }

  // The button press IS the production approval — record it.
  await db.insert(approvals).values({
    appId,
    requirementId: latestRun.requirementId,
    userId: user.id,
    type: "deploy_production",
    status: "approved",
    decidedAt: new Date(),
  });
  await audit({
    userId: user.id,
    appId,
    buildRunId: latestRun.id,
    action: "approval.decided",
    payload: { type: "deploy_production", decision: "approved" },
  });

  await db
    .update(buildRuns)
    .set({ status: "deploying" })
    .where(eq(buildRuns.id, latestRun.id));

  void publishToProduction({
    appId,
    buildRunId: latestRun.id,
    branch: latestRun.branch,
    userId: user.id,
  }).catch((err) => console.error(`Publish crashed for ${appId}:`, err));

  return NextResponse.json({ ok: true });
}
