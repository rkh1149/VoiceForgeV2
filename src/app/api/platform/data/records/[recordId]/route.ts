import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { getDb } from "@/db";
import {
  consumePlatformDataRateLimit,
  deleteRecord,
  getRecord,
  platformDataErrorResponse,
  updateRecord,
} from "@/lib/platform/data";
import { getOrCreateCurrentUser } from "@/lib/users";

const paramsSchema = z.object({
  recordId: z.string().uuid(),
});

const patchBodySchema = z.object({
  data: z.unknown(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const { recordId } = paramsSchema.parse(await params);
    consumePlatformDataRateLimit(`${user.id}:record:${recordId}:read`);
    const record = await getRecord(getDb(), { recordId, user });
    return NextResponse.json({ record });
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const { recordId } = paramsSchema.parse(await params);
    const body = patchBodySchema.parse(await req.json().catch(() => null));
    consumePlatformDataRateLimit(`${user.id}:record:${recordId}:update`);
    const record = await updateRecord(getDb(), {
      recordId,
      user,
      data: body.data,
    });
    await audit({
      userId: user.id,
      appId: record.appId,
      action: "platformData.record.updated",
      payload: {
        recordId: record.id,
        entityKey: record.entityKey,
        version: record.version,
      },
    });
    return NextResponse.json({ record });
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const { recordId } = paramsSchema.parse(await params);
    consumePlatformDataRateLimit(`${user.id}:record:${recordId}:delete`);
    const record = await deleteRecord(getDb(), { recordId, user });
    await audit({
      userId: user.id,
      appId: record.appId,
      action: "platformData.record.deleted",
      payload: { recordId: record.id, entityKey: record.entityKey },
    });
    return NextResponse.json({ record });
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
