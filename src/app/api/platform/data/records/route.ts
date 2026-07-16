import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import {
  consumePlatformDataRateLimit,
  createRecord,
  listRecords,
  platformDataErrorResponse,
} from "@/lib/platform/data";
import { getOrCreateCurrentUser } from "@/lib/users";

const querySchema = z.object({
  appId: z.string().uuid(),
  entityKey: z.string().min(1).max(80),
  includeDeleted: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const postBodySchema = z.object({
  appId: z.string().uuid(),
  entityKey: z.string().min(1).max(80),
  data: z.unknown(),
});

export async function GET(req: Request) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const query = querySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    consumePlatformDataRateLimit(`${user.id}:${query.appId}:records:list`);
    const records = await listRecords(getDb(), {
      appId: query.appId,
      entityKey: query.entityKey,
      includeDeleted: query.includeDeleted,
      limit: query.limit,
      user,
    });
    return NextResponse.json({ records });
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}

export async function POST(req: Request) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const body = postBodySchema.parse(await req.json().catch(() => null));
    consumePlatformDataRateLimit(`${user.id}:${body.appId}:records:create`);
    const record = await createRecord(getDb(), {
      appId: body.appId,
      entityKey: body.entityKey,
      data: body.data,
      user,
    });
    await audit({
      userId: user.id,
      appId: body.appId,
      action: "platformData.record.created",
      payload: { recordId: record.id, entityKey: record.entityKey },
    });
    return NextResponse.json({ record }, { status: 201 });
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
