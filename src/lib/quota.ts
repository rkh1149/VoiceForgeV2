import { and, count, eq, gte, inArray } from "drizzle-orm";
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
  const now = Date.now();
  const activeRuns = await db
    .select({
      id: buildRuns.id,
      status: buildRuns.status,
      createdAt: buildRuns.createdAt,
      logs: buildRuns.logs,
    })
    .from(buildRuns)
    .where(
      and(
        eq(buildRuns.appId, appId),
        inArray(buildRuns.status, [
          "queued",
          "generating",
          "testing",
          "debugging",
        ]),
      ),
    );
  const staleRunIds = activeRuns
    .filter((run) => {
      const logs = (run.logs ?? []) as Array<{ ts?: string }>;
      const lastLogAt = logs.at(-1)?.ts
        ? new Date(logs.at(-1)?.ts ?? run.createdAt)
        : run.createdAt;
      return (
        run.createdAt.getTime() <= now - staleHardLimitMs(run.status) ||
        lastLogAt.getTime() <= now - staleHeartbeatLimitMs(run.status)
      );
    })
    .map((run) => run.id);
  if (staleRunIds.length === 0) return;

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
        inArray(buildRuns.id, staleRunIds),
      ),
    );
  const [app] = await db
    .select({ productionUrl: apps.productionUrl })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  await db
    .update(apps)
    .set({
      status: app?.productionUrl ? "deployed" : "failed",
      updatedAt: new Date(),
    })
    .where(eq(apps.id, appId));
}

function staleHardLimitMs(status: string): number {
  if (status === "generating" || status === "debugging") return 45 * 60_000;
  return 25 * 60_000;
}

function staleHeartbeatLimitMs(status: string): number {
  if (status === "debugging") return 20 * 60_000;
  if (status === "generating") return 15 * 60_000;
  return 8 * 60_000;
}
