import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import {
  consumePlatformDataRateLimit,
  deleteMembership,
  membershipRoleSchema,
  platformDataErrorResponse,
  updateMembershipRole,
} from "@/lib/platform/data";
import { getOrCreateCurrentUser } from "@/lib/users";

const paramsSchema = z.object({
  membershipId: z.string().uuid(),
});

const patchBodySchema = z.object({
  role: membershipRoleSchema,
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const { membershipId } = paramsSchema.parse(await params);
    const body = patchBodySchema.parse(await req.json().catch(() => null));
    consumePlatformDataRateLimit(`${user.id}:membership:${membershipId}:update`);
    const membership = await updateMembershipRole(getDb(), {
      membershipId,
      user,
      role: body.role,
    });
    await audit({
      userId: user.id,
      appId: membership.appId,
      action: "platformData.membership.updated",
      payload: { targetUserId: membership.userId, role: membership.role },
    });
    return NextResponse.json({ membership });
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const { membershipId } = paramsSchema.parse(await params);
    consumePlatformDataRateLimit(`${user.id}:membership:${membershipId}:delete`);
    const membership = await deleteMembership(getDb(), { membershipId, user });
    await audit({
      userId: user.id,
      appId: membership.appId,
      action: "platformData.membership.deleted",
      payload: { targetUserId: membership.userId, role: membership.role },
    });
    return NextResponse.json({ membership });
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
