import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import {
  consumePlatformDataRateLimit,
  listEntitySchemas,
  platformDataErrorResponse,
  upsertEntitySchema,
} from "@/lib/platform/data";
import { getOrCreateCurrentUser } from "@/lib/users";

const querySchema = z.object({
  appId: z.string().uuid(),
});

const postBodySchema = z.object({
  appId: z.string().uuid(),
  entity: z.unknown(),
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
    consumePlatformDataRateLimit(`${user.id}:${query.appId}:entities:list`);
    const entities = await listEntitySchemas(getDb(), {
      appId: query.appId,
      user,
    });
    return NextResponse.json({ entities });
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
    consumePlatformDataRateLimit(`${user.id}:${body.appId}:entities:upsert`);
    const entity = await upsertEntitySchema(getDb(), {
      appId: body.appId,
      user,
      entity: body.entity,
    });
    await audit({
      userId: user.id,
      appId: body.appId,
      action: "platformData.entity.upserted",
      payload: { entityKey: entity.entityKey },
    });
    return NextResponse.json({ entity });
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
