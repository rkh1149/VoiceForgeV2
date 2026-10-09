import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  appEntitySchemas,
  appMemberships,
  appRecordEvents,
  appRecordSearchConfigs,
  appRecords,
  appRecordVersions,
  appSavedRecordFilters,
  apps,
  users,
} from "../../db/schema";
import {
  createRecord,
  exportPlatformRecordsCsv,
  listRecords,
  PlatformDataError,
  runPlatformRecordReport,
  saveRecordFilter,
  searchPlatformRecords,
  updateRecord,
  upsertEntitySchema,
  upsertRecordSearchConfig,
} from "../platform/data";

export type Stage15DatabaseGoldenResult = {
  appId: string;
  createdRecordId: string;
  viewerReadCount: number;
  searchCount: number;
  reportCount: number;
  csvRowCount: number;
  viewerWriteRejected: boolean;
  invalidFieldRejected: boolean;
};

/**
 * Runs one isolated platform-data lifecycle against Neon and removes every
 * synthetic row in a finally block. This is opt-in and never runs in `npm test`.
 */
export async function runStage15DatabaseGolden(): Promise<Stage15DatabaseGoldenResult> {
  const db = getDb();
  const namespace = `vf-stage15-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let appId = "";
  let ownerId = "";
  let viewerId = "";
  let createdRecordId = "";
  try {
    const [owner] = await db
      .insert(users)
      .values({
        clerkUserId: `${namespace}-owner`,
        email: `${namespace}-owner@example.test`,
        displayName: "Stage 15 Owner",
      })
      .returning();
    ownerId = owner.id;
    const [viewer] = await db
      .insert(users)
      .values({
        clerkUserId: `${namespace}-viewer`,
        email: `${namespace}-viewer@example.test`,
        displayName: "Stage 15 Viewer",
      })
      .returning();
    viewerId = viewer.id;
    const [app] = await db
      .insert(apps)
      .values({
        ownerId,
        name: "Stage 15 Database Golden",
        slug: namespace,
        description: "Disposable Stage 15 platform-data verification.",
      })
      .returning();
    appId = app.id;
    await db.insert(appMemberships).values({
      appId,
      userId: viewerId,
      role: "viewer",
      invitedBy: ownerId,
    });
    const ownerUser = { id: ownerId, role: owner.role };
    const viewerUser = { id: viewerId, role: viewer.role };

    await upsertEntitySchema(db, {
      appId,
      user: ownerUser,
      entity: {
        key: "work_item",
        name: "Work Item",
        description: "Stage 15 disposable record.",
        fields: [
          { key: "title", label: "Title", type: "text", required: true },
          {
            key: "status",
            label: "Status",
            type: "select",
            required: true,
            options: ["planned", "done"],
          },
          { key: "due_date", label: "Due date", type: "date", required: true },
        ],
        relationships: [],
      },
    });
    await upsertRecordSearchConfig(db, {
      appId,
      entityKey: "work_item",
      user: ownerUser,
      indexedFields: ["title", "status"],
      defaultSort: [{ fieldKey: "due_date", direction: "asc" }],
    });
    const created = await createRecord(db, {
      appId,
      entityKey: "work_item",
      user: ownerUser,
      data: {
        title: `${namespace} durable item`,
        status: "planned",
        due_date: "2030-05-10",
      },
    });
    createdRecordId = created.id;
    await updateRecord(db, {
      recordId: created.id,
      user: ownerUser,
      data: { status: "done" },
    });

    const viewerRecords = await listRecords(db, {
      appId,
      entityKey: "work_item",
      user: viewerUser,
    });
    const search = await searchPlatformRecords(db, {
      appId,
      entityKey: "work_item",
      user: viewerUser,
      query: { query: namespace, fields: ["title"] },
    });
    await saveRecordFilter(db, {
      appId,
      entityKey: "work_item",
      user: ownerUser,
      name: `${namespace} completed`,
      definition: {
        filters: [{ fieldKey: "status", operator: "equals", value: "done" }],
        fields: ["title", "status"],
        sort: [{ fieldKey: "due_date", direction: "asc" }],
      },
    });
    const report = await runPlatformRecordReport(db, {
      appId,
      entityKey: "work_item",
      user: viewerUser,
      report: { groupByFieldKey: "status", metric: "count" },
    });
    const csv = await exportPlatformRecordsCsv(db, {
      appId,
      entityKey: "work_item",
      user: viewerUser,
      query: { fields: ["title", "status", "due_date"] },
      fileName: "stage15-work-items",
    });

    let viewerWriteRejected = false;
    try {
      await createRecord(db, {
        appId,
        entityKey: "work_item",
        user: viewerUser,
        data: { title: "Not allowed", status: "planned", due_date: "2030-05-11" },
      });
    } catch (error) {
      viewerWriteRejected =
        error instanceof PlatformDataError && error.status === 403;
    }
    let invalidFieldRejected = false;
    try {
      await updateRecord(db, {
        recordId: created.id,
        user: ownerUser,
        data: { displayTitle: "Wrong key" },
      });
    } catch (error) {
      invalidFieldRejected =
        error instanceof PlatformDataError && error.code === "invalid_record";
    }

    return {
      appId,
      createdRecordId,
      viewerReadCount: viewerRecords.length,
      searchCount: search.total,
      reportCount: report.totalRecords,
      csvRowCount: csv.rowCount,
      viewerWriteRejected,
      invalidFieldRejected,
    };
  } finally {
    if (appId) {
      await db.delete(appRecordEvents).where(eq(appRecordEvents.appId, appId));
      await db.delete(appRecordVersions).where(eq(appRecordVersions.appId, appId));
      await db.delete(appSavedRecordFilters).where(eq(appSavedRecordFilters.appId, appId));
      await db.delete(appRecordSearchConfigs).where(eq(appRecordSearchConfigs.appId, appId));
      await db.delete(appRecords).where(eq(appRecords.appId, appId));
      await db.delete(appEntitySchemas).where(eq(appEntitySchemas.appId, appId));
      await db.delete(appMemberships).where(eq(appMemberships.appId, appId));
      await db.delete(apps).where(eq(apps.id, appId));
    }
    if (viewerId) await db.delete(users).where(eq(users.id, viewerId));
    if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
    if (appId) {
      const [remainingApp] = await db
        .select({ id: apps.id })
        .from(apps)
        .where(eq(apps.id, appId))
        .limit(1);
      if (remainingApp) throw new Error("Stage 15 database golden cleanup failed.");
    }
  }
}
