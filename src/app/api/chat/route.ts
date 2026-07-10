import { NextResponse } from "next/server";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import type { AgentInputItem } from "@openai/agents";
import { getDb } from "@/db";
import {
  apps,
  approvals,
  conversations,
  requirements,
} from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { audit } from "@/lib/audit";
import { runPlanner } from "@/lib/agents/planner";
import { uniqueSlugForOwner } from "@/lib/slug";

// Planning turns can take a while (model + tool call).
export const maxDuration = 60;

const bodySchema = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().min(1).max(2000),
});

const MAX_TRANSCRIPT_ITEMS = 80; // hard cap per conversation (cost control)

export async function POST(req: Request) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured on the server." },
      { status: 500 },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { conversationId, message } = parsed.data;

  const db = getDb();

  // Load or create the conversation (must belong to this user).
  let convo;
  if (conversationId) {
    const rows = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userId, user.id),
        ),
      )
      .limit(1);
    convo = rows[0];
    if (!convo) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 },
      );
    }
  } else {
    const rows = await db
      .insert(conversations)
      .values({ userId: user.id, channel: "text", transcript: [] })
      .returning();
    convo = rows[0];
    await audit({
      userId: user.id,
      action: "conversation.started",
      payload: { conversationId: convo.id },
    });
  }

  const history = (convo.transcript ?? []) as AgentInputItem[];
  if (history.length > MAX_TRANSCRIPT_ITEMS) {
    return NextResponse.json(
      {
        error:
          "This planning conversation has gotten very long. Please start a new one.",
      },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await runPlanner(history, message);
  } catch (err) {
    console.error("Planner run failed:", err);
    return NextResponse.json(
      { error: "The planner hit a problem. Please try again." },
      { status: 502 },
    );
  }

  // Persist the updated transcript.
  await db
    .update(conversations)
    .set({ transcript: result.history, updatedAt: new Date() })
    .where(eq(conversations.id, convo.id));

  // If the model recorded a spec this turn, persist app + requirement +
  // pending approval, all owned by this user.
  let proposalPayload: {
    appId: string;
    appName: string;
    requirementId: string;
    approvalId: string;
    version: number;
  } | null = null;

  if (result.proposal) {
    const spec = result.proposal;

    // Reuse the app row if this conversation already proposed one (revision).
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
        .where(eq(conversations.id, convo.id));
    }

    // Supersede any earlier pending build approval for this app.
    await db
      .update(approvals)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(
        and(
          eq(approvals.appId, appId),
          eq(approvals.type, "build"),
          eq(approvals.status, "pending"),
        ),
      );

    const [requirement] = await db
      .insert(requirements)
      .values({
        appId,
        version,
        spec,
        plainSummary: result.reply,
        createdBy: user.id,
      })
      .returning();

    const [approval] = await db
      .insert(approvals)
      .values({
        appId,
        requirementId: requirement.id,
        userId: user.id,
        type: "build",
        status: "pending",
      })
      .returning();

    await audit({
      userId: user.id,
      appId,
      action: "spec.proposed",
      payload: { requirementId: requirement.id, version, appName: spec.appName },
    });

    proposalPayload = {
      appId,
      appName: spec.appName,
      requirementId: requirement.id,
      approvalId: approval.id,
      version,
    };
  }

  return NextResponse.json({
    conversationId: convo.id,
    reply: result.reply,
    proposal: proposalPayload,
  });
}
