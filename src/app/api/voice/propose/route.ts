import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { conversations } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { appSpecSchema } from "@/lib/spec";
import { persistProposal } from "@/lib/proposals";

/**
 * Called from the browser when the voice agent's propose_spec /
 * propose_change tool fires. Validates the spec server-side and persists
 * it through the same path as text conversations. Also saves the
 * transcript so the voice session is on record.
 */

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  spec: appSpecSchema,
  changeSummary: z.string().max(2000).nullish(),
  plainSummary: z.string().max(8000).default(""),
  transcript: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(8000),
      }),
    )
    .max(400)
    .default([]),
});

export async function POST(req: Request) {
  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { conversationId, spec, changeSummary, plainSummary, transcript } =
    parsed.data;

  const db = getDb();
  const [convo] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, user.id),
        eq(conversations.channel, "voice"),
      ),
    )
    .limit(1);
  if (!convo) {
    return NextResponse.json(
      { error: "Voice conversation not found" },
      { status: 404 },
    );
  }

  await db
    .update(conversations)
    .set({ transcript, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  // Change mode iff the conversation was started against an existing app
  // AND a change summary came with the proposal.
  const changeMode = Boolean(convo.appId && changeSummary);

  const proposal = await persistProposal({
    user,
    conversationId,
    spec,
    plainSummary: plainSummary || (changeSummary ?? spec.purpose),
    changeMode,
    changeSummary: changeSummary ?? null,
  });

  return NextResponse.json({ proposal });
}
