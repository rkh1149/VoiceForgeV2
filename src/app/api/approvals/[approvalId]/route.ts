import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { approvals, apps } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { audit } from "@/lib/audit";

const bodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ approvalId: string }> },
) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { approvalId } = await params;
  if (!z.string().uuid().safeParse(approvalId).success) {
    return NextResponse.json({ error: "Invalid approval id" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { decision } = parsed.data;

  const db = getDb();

  // The approval must belong to this user and still be pending.
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.userId, user.id)))
    .limit(1);
  const approval = rows[0];
  if (!approval) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }
  if (approval.status !== "pending") {
    return NextResponse.json(
      { error: `This request was already ${approval.status}.` },
      { status: 409 },
    );
  }

  await db
    .update(approvals)
    .set({ status: decision, decidedAt: new Date() })
    .where(eq(approvals.id, approvalId));

  if (decision === "approved" && approval.type === "build") {
    await db
      .update(apps)
      .set({ status: "spec_approved", updatedAt: new Date() })
      .where(eq(apps.id, approval.appId));
  }

  await audit({
    userId: user.id,
    appId: approval.appId,
    action: "approval.decided",
    payload: { approvalId, type: approval.type, decision },
  });

  return NextResponse.json({ ok: true, decision });
}
