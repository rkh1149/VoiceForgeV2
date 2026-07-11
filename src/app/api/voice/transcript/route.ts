import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { conversations } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";

/** Save the transcript when a voice session ends without a proposal. */

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  transcript: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(8000),
      }),
    )
    .max(400),
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

  const db = getDb();
  const updated = await db
    .update(conversations)
    .set({ transcript: parsed.data.transcript, updatedAt: new Date() })
    .where(
      and(
        eq(conversations.id, parsed.data.conversationId),
        eq(conversations.userId, user.id),
        eq(conversations.channel, "voice"),
      ),
    )
    .returning({ id: conversations.id });

  if (updated.length === 0) {
    return NextResponse.json(
      { error: "Voice conversation not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
