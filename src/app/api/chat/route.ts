import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentInputItem } from "@openai/agents";
import { getDb } from "@/db";
import { apps, conversations } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { audit } from "@/lib/audit";
import { runPlanner, runChangePlanner } from "@/lib/agents/planner";
import type { AppSpec } from "@/lib/spec";
import {
  persistProposal,
  getLatestSpec,
  type ProposalPayload,
} from "@/lib/proposals";
import { CHAT_MESSAGE_MAX_LENGTH } from "@/lib/chat-limits";

// Planning turns can take a while, especially with larger prompts and tool calls.
export const maxDuration = 300;

const bodySchema = z.object({
  conversationId: z.string().uuid().nullish(),
  // Present when the user is changing an existing app (change flow).
  appId: z.string().uuid().nullish(),
  forceDeepDiagnostic: z.boolean().default(false),
  message: z.string().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
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
  const {
    conversationId,
    appId: requestedAppId,
    forceDeepDiagnostic,
    message,
  } = parsed.data;

  const db = getDb();

  // Change flow: verify the target app belongs to this user.
  if (requestedAppId) {
    const owned = await db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.id, requestedAppId), eq(apps.ownerId, user.id)))
      .limit(1);
    if (owned.length === 0) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }
  }

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
      .values({
        userId: user.id,
        appId: requestedAppId ?? null,
        channel: "text",
        transcript: [],
      })
      .returning();
    convo = rows[0];
    await audit({
      userId: user.id,
      appId: requestedAppId ?? undefined,
      action: "conversation.started",
      payload: {
        conversationId: convo.id,
        mode: requestedAppId ? "change" : "create",
      },
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

  // Change mode when the conversation targets an app that has been built.
  let changeMode = false;
  let currentSpec: AppSpec | null = null;
  if (convo.appId) {
    const [targetApp] = await db
      .select()
      .from(apps)
      .where(eq(apps.id, convo.appId))
      .limit(1);
    if (targetApp?.githubRepoUrl) {
      currentSpec = await getLatestSpec(convo.appId);
      changeMode = currentSpec !== null;
    }
  }

  let result;
  let changeSummary: string | null = null;
  try {
    if (changeMode && currentSpec) {
      const changeResult = await runChangePlanner(history, message, currentSpec);
      if (changeResult.proposal) {
        const { changeSummary: summary, ...spec } = changeResult.proposal;
        changeSummary = summary;
        result = { ...changeResult, proposal: spec as AppSpec };
      } else {
        result = { ...changeResult, proposal: null };
      }
    } else {
      result = await runPlanner(history, message);
    }
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

  let proposalPayload: ProposalPayload | null = null;
  if (result.proposal) {
    proposalPayload = await persistProposal({
      user,
      conversationId: convo.id,
      spec: result.proposal,
      plainSummary: result.reply,
      changeMode,
      changeSummary,
      forceDeepDiagnostic: changeMode ? forceDeepDiagnostic : false,
    });
  }

  return NextResponse.json({
    conversationId: convo.id,
    reply: result.reply,
    proposal: proposalPayload,
  });
}
