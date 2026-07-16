import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import {
  consumePlatformDataRateLimit,
  listMemberships,
  membershipRoleSchema,
  platformDataErrorResponse,
  upsertMembershipByEmail,
} from "@/lib/platform/data";
import { getOrCreateCurrentUser } from "@/lib/users";

const querySchema = z.object({
  appId: z.string().uuid(),
});

const postBodySchema = z.object({
  appId: z.string().uuid(),
  email: z.string().email().max(320),
  role: membershipRoleSchema,
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
    consumePlatformDataRateLimit(`${user.id}:${query.appId}:memberships:list`);
    const memberships = await listMemberships(getDb(), {
      appId: query.appId,
      user,
    });
    return NextResponse.json({ memberships });
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
    consumePlatformDataRateLimit(`${user.id}:${body.appId}:memberships:upsert`);
    const membership = await upsertMembershipByEmail(getDb(), {
      appId: body.appId,
      user,
      email: body.email,
      role: body.role,
    });
    await audit({
      userId: user.id,
      appId: body.appId,
      action: "platformData.membership.upserted",
      payload: { targetUserId: membership.userId, role: membership.role },
    });
    return NextResponse.json({ membership });
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
