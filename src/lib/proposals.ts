import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  apps,
  approvals,
  changeRequests,
  conversations,
  requirements,
} from "@/db/schema";
import type { AppSpec } from "@/lib/spec";
import type { User } from "@/db/schema";
import { audit } from "@/lib/audit";
import { uniqueSlugForOwner } from "@/lib/slug";

export type ProposalPayload = {
  appId: string;
  appName: string;
  requirementId: string;
  approvalId: string;
  version: number;
};

/**
 * Persist a proposed spec from a planning conversation (text or voice):
 * app row (created or updated), versioned requirement, pending approval,
 * change_request when it's a change, audit entries. Shared by /api/chat
 * and /api/voice/propose.
 */
export async function persistProposal(opts: {
  user: User;
  conversationId: string;
  spec: AppSpec;
  plainSummary: string;
  changeMode: boolean;
  changeSummary?: string | null;
}): Promise<ProposalPayload> {
  const { user, conversationId, spec, plainSummary, changeMode } = opts;
  const db = getDb();

  const [convo] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!convo) throw new Error("Conversation not found");

  // Reuse the app row if this conversation already targets one.
  let appId = convo.appId;
  let version = 1;
  if (appId) {
    const prev = await db
      .select({ version: requirements.version })
      .from(requirements)
      .where(eq(requirements.appId, appId))
      .orderBy(desc(requirements.version))
      .limit(1);
    version = (prev[0]?.version ?? 0) + 1;
    await db
      .update(apps)
      .set({
        name: spec.appName,
        description: spec.purpose,
        updatedAt: new Date(),
      })
      .where(eq(apps.id, appId));
  } else {
    const slug = await uniqueSlugForOwner(user.id, spec.appName);
    const inserted = await db
      .insert(apps)
      .values({
        ownerId: user.id,
        name: spec.appName,
        slug,
        description: spec.purpose,
        status: "draft",
      })
      .returning();
    appId = inserted[0].id;
    await db
      .update(conversations)
      .set({ appId })
      .where(eq(conversations.id, conversationId));
  }

  // Supersede any earlier pending approval of the same type for this app.
  await db
    .update(approvals)
    .set({ status: "rejected", decidedAt: new Date() })
    .where(
      and(
        eq(approvals.appId, appId),
        eq(approvals.type, changeMode ? "change" : "build"),
        eq(approvals.status, "pending"),
      ),
    );

  const [requirement] = await db
    .insert(requirements)
    .values({
      appId,
      version,
      spec,
      plainSummary,
      createdBy: user.id,
    })
    .returning();

  const [approval] = await db
    .insert(approvals)
    .values({
      appId,
      requirementId: requirement.id,
      userId: user.id,
      type: changeMode ? "change" : "build",
      status: "pending",
    })
    .returning();

  if (changeMode && opts.changeSummary) {
    await db.insert(changeRequests).values({
      appId,
      userId: user.id,
      description: opts.changeSummary,
      status: "awaiting_approval",
      requirementId: requirement.id,
    });
  }

  await audit({
    userId: user.id,
    appId,
    action: changeMode ? "change.proposed" : "spec.proposed",
    payload: { requirementId: requirement.id, version, appName: spec.appName },
  });

  return {
    appId,
    appName: spec.appName,
    requirementId: requirement.id,
    approvalId: approval.id,
    version,
  };
}

/** Latest spec for an app (null when it has none). */
export async function getLatestSpec(appId: string): Promise<AppSpec | null> {
  const db = getDb();
  const [latest] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.appId, appId))
    .orderBy(desc(requirements.version))
    .limit(1);
  return latest ? (latest.spec as AppSpec) : null;
}
