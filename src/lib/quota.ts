import { and, count, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { apps, buildRuns, type User } from "@/db/schema";

/** Per-user monthly build quota (users.monthly_build_limit, default 10). */
export async function checkBuildQuota(
  user: User,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const db = getDb();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [row] = await db
    .select({ used: count() })
    .from(buildRuns)
    .innerJoin(apps, eq(buildRuns.appId, apps.id))
    .where(
      and(eq(apps.ownerId, user.id), gte(buildRuns.createdAt, monthStart)),
    );

  const used = row?.used ?? 0;
  const limit = user.monthlyBuildLimit;
  // Admins are never blocked.
  return { allowed: user.role === "admin" || used < limit, used, limit };
}

/** Auto-fail build runs that have been "active" for too long (crashed server,
 * killed dev process, function timeout…). Called from the status endpoint. */
export async function failStaleRuns(appId: string): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - 25 * 60_000);
  await db
    .update(buildRuns)
    .set({
      status: "failed",
      errorMessage:
        "The build stopped responding and was marked failed (it may have been interrupted). Use “Try building again”.",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(buildRuns.appId, appId),
        inArray(buildRuns.status, [
          "queued",
          "generating",
          "testing",
          "debugging",
        ]),
        // createdAt is set at queue time; active runs update logs constantly,
        // so 25 minutes without finishing means it's dead.
        lte(buildRuns.createdAt, cutoff),
      ),
    );
}
