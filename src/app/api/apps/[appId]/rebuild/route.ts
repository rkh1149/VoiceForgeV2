import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { apps, approvals, buildRuns, requirements } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { audit } from "@/lib/audit";
import { startBuildPipeline } from "@/lib/build/pipeline";
import { checkBuildQuota } from "@/lib/quota";
import { runInBackground } from "@/lib/background";

export const maxDuration = 300;

/** Retry a failed build using the latest approved spec. */
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

  // Latest spec version for this app…
  const [latestRequirement] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.appId, appId))
    .orderBy(desc(requirements.version))
    .limit(1);
  if (!latestRequirement) {
    return NextResponse.json(
      { error: "No specification exists for this app." },
      { status: 400 },
    );
  }

  // …which must have an approved build/change approval (no approval, no build).
  const [approval] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.requirementId, latestRequirement.id),
        inArray(approvals.type, ["build", "change"]),
        eq(approvals.status, "approved"),
      ),
    )
    .limit(1);
  if (!approval) {
    return NextResponse.json(
      { error: "The latest plan for this app was never approved." },
      { status: 400 },
    );
  }

  // Refuse if a build is already running.
  const active = await db
    .select({ id: buildRuns.id })
    .from(buildRuns)
    .where(
      and(
        eq(buildRuns.appId, appId),
        inArray(buildRuns.status, [
          "queued",
          "generating",
          "testing",
          "debugging",
          "deploying",
        ]),
      ),
    )
    .limit(1);
  if (active.length > 0) {
    return NextResponse.json(
      { error: "A build is already running for this app." },
      { status: 409 },
    );
  }

  const quota = await checkBuildQuota(user);
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: `You've used all ${quota.limit} builds for this month. Ask Richard if you need more.`,
      },
      { status: 429 },
    );
  }

  const [run] = await db
    .insert(buildRuns)
    .values({
      appId,
      requirementId: latestRequirement.id,
      approvalId: approval.id,
      status: "queued",
    })
    .returning();

  await audit({
    userId: user.id,
    appId,
    buildRunId: run.id,
    action: "build.retried",
    payload: { requirementVersion: latestRequirement.version },
  });

  runInBackground(() => startBuildPipeline(run.id), `build ${run.id}`);

  return NextResponse.json({ ok: true, buildRunId: run.id });
}
