import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { approvals, apps, buildRuns } from "@/db/schema";

const RESUMABLE_RUN_STATUSES = [
  "queued",
  "generating",
  "testing",
  "debugging",
  "deploying",
  "awaiting_user_test",
  "needs_input",
  "failed",
] as const;

const RESUMABLE_APP_STATUSES = [
  "spec_approved",
  "building",
  "testing",
  "failed",
] as const;

export type ResumableBuild = {
  appId: string;
  appName: string;
  appDescription: string | null;
  runId: string;
  runStatus: string;
  updatedAt: Date;
};

export async function getResumableBuildsForUser(
  userId: string,
  type: "build" | "change",
  limit = 6,
): Promise<ResumableBuild[]> {
  const db = getDb();
  const rows = await db
    .select({
      appId: apps.id,
      appName: apps.name,
      appDescription: apps.description,
      runId: buildRuns.id,
      runStatus: buildRuns.status,
      updatedAt: buildRuns.createdAt,
    })
    .from(buildRuns)
    .innerJoin(apps, eq(apps.id, buildRuns.appId))
    .innerJoin(approvals, eq(approvals.id, buildRuns.approvalId))
    .where(
      and(
        eq(apps.ownerId, userId),
        eq(approvals.type, type),
        inArray(apps.status, RESUMABLE_APP_STATUSES),
        inArray(buildRuns.status, RESUMABLE_RUN_STATUSES),
      ),
    )
    .orderBy(desc(buildRuns.createdAt))
    .limit(limit * 4);

  const seenAppIds = new Set<string>();
  const newestByApp: ResumableBuild[] = [];
  for (const row of rows) {
    if (seenAppIds.has(row.appId)) continue;
    seenAppIds.add(row.appId);
    newestByApp.push(row);
    if (newestByApp.length >= limit) break;
  }
  return newestByApp;
}
