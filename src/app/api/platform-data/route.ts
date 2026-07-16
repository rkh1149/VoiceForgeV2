import { NextResponse } from "next/server";
import { or, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { apps } from "@/db/schema";
import {
  createRecord,
  consumePlatformDataRateLimit,
  deleteRecord,
  getRecord,
  listEntitySchemas,
  listRecords,
  platformDataErrorResponse,
  updateRecord,
} from "@/lib/platform/data";

/**
 * Public server-to-server endpoint for generated apps. Generated app browsers
 * call their own locked /api/data route; that server route adds the secret
 * token and forwards here. Never call this directly from browser code.
 */

const tokenSchema = z.string().min(20).max(200);

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    token: tokenSchema,
    action: z.literal("listSchemas"),
  }),
  z.object({
    token: tokenSchema,
    action: z.literal("listRecords"),
    entityKey: z.string().min(1).max(80),
    includeDeleted: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    token: tokenSchema,
    action: z.literal("getRecord"),
    recordId: z.string().uuid(),
  }),
  z.object({
    token: tokenSchema,
    action: z.literal("createRecord"),
    entityKey: z.string().min(1).max(80),
    data: z.unknown(),
  }),
  z.object({
    token: tokenSchema,
    action: z.literal("updateRecord"),
    recordId: z.string().uuid(),
    data: z.unknown(),
  }),
  z.object({
    token: tokenSchema,
    action: z.literal("deleteRecord"),
    recordId: z.string().uuid(),
  }),
]);

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const response = platformDataErrorResponse(parsed.error);
    return NextResponse.json(response.body, { status: response.status });
  }

  try {
    const db = getDb();
    const [app] = await db
      .select({
        id: apps.id,
        ownerId: apps.ownerId,
      })
      .from(apps)
      .where(
        or(
          eq(apps.platformToken, parsed.data.token),
          eq(apps.aiToken, parsed.data.token),
        ),
      )
      .limit(1);
    if (!app) {
      return NextResponse.json({ error: "Unknown app" }, { status: 401 });
    }
    consumePlatformDataRateLimit(`${app.id}:server:${parsed.data.action}`);

    const platformUser = { id: app.ownerId, role: "user" as const };
    switch (parsed.data.action) {
      case "listSchemas": {
        const entities = await listEntitySchemas(db, {
          appId: app.id,
          user: platformUser,
        });
        return NextResponse.json({ entities });
      }
      case "listRecords": {
        const records = await listRecords(db, {
          appId: app.id,
          entityKey: parsed.data.entityKey,
          includeDeleted: parsed.data.includeDeleted,
          limit: parsed.data.limit,
          user: platformUser,
        });
        return NextResponse.json({ records });
      }
      case "getRecord": {
        const record = await getRecord(db, {
          recordId: parsed.data.recordId,
          user: platformUser,
        });
        return NextResponse.json({ record });
      }
      case "createRecord": {
        const record = await createRecord(db, {
          appId: app.id,
          entityKey: parsed.data.entityKey,
          data: parsed.data.data,
          user: platformUser,
        });
        return NextResponse.json({ record }, { status: 201 });
      }
      case "updateRecord": {
        const record = await updateRecord(db, {
          recordId: parsed.data.recordId,
          data: parsed.data.data,
          user: platformUser,
        });
        return NextResponse.json({ record });
      }
      case "deleteRecord": {
        const record = await deleteRecord(db, {
          recordId: parsed.data.recordId,
          user: platformUser,
        });
        return NextResponse.json({ record });
      }
    }
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
