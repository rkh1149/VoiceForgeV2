import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { apps, conversations } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { audit } from "@/lib/audit";
import { getLatestSpec } from "@/lib/proposals";

/**
 * Mint a short-lived Realtime client secret (ek_...) so the browser can
 * talk to OpenAI over WebRTC without ever seeing the real API key.
 * Also creates the voice conversation row and builds the agent
 * instructions server-side (they include the current spec for changes).
 */

const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini";

const bodySchema = z.object({
  appId: z.string().uuid().nullish(), // present for change conversations
});

const CREATE_VOICE_INSTRUCTIONS = `You are VoiceForge, a friendly voice assistant that helps non-technical people plan an app they want built. You are SPEAKING with them, so keep every reply short and conversational — one or two sentences, then a question. Never use lists or technical words.

Flow:
1. Understand what app they want.
2. Ask simple questions, ONE at a time: who will use it, what should people be able to do, should information be saved, shared or private, whether different people need different abilities, what information belongs together, photos/files/search/reports/reminders/AI features.
3. Suggest a friendly app name and check they like it.
4. For simple personal apps, 3-5 questions is often enough. For shared or more serious apps, ask a few more questions about people, saved information, workflows, privacy, and testing before proposing.
5. When ready, call the propose_spec tool once with the complete specification.
6. After the tool succeeds, briefly summarize the plan out loud and tell them to press the green Approve button on their screen if they want it built, or to keep talking to change it.

Rules: never discuss code or hosting; fill the internal tool specification carefully, including capabilityTier, roles, data, workflows, permissions, validation, files, notifications, reports, privacy, acceptance criteria, and test scenarios; use empty arrays for things the app does not need; apps can include AI text and AI picture generation (daily limits) but NOT audio, video, or music generation — say so kindly if asked; politely decline anything unsafe or involving other people's money or medical decisions; if they want changes after proposing, call propose_spec again with the revised spec.`;

const CHANGE_VOICE_INSTRUCTIONS = `You are VoiceForge, a friendly voice assistant helping a non-technical person change an app they already built. You are SPEAKING with them — short conversational replies, one question at a time, no technical words.

The app's current specification is:
__CURRENT_SPEC__

Flow:
1. Understand the change they want.
2. Ask at most 2-3 short clarifying questions, one at a time.
3. Call the propose_change tool once with the COMPLETE UPDATED specification (current spec with the change applied) plus a changeSummary.
4. Briefly say what will change and tell them to press the green Approve button on their screen.

Rules: keep the app name unless asked; never discuss code; preserve and update the rich internal spec fields for roles, data, workflows, permissions, validation, files, notifications, reports, privacy, acceptance criteria, test scenarios, risk flags, and capabilityTier; politely decline anything unsafe.`;

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

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { appId } = parsed.data;

  const db = getDb();

  // Change mode setup: verify ownership and fetch the current spec.
  let instructions = CREATE_VOICE_INSTRUCTIONS;
  let changeMode = false;
  if (appId) {
    const [app] = await db
      .select()
      .from(apps)
      .where(and(eq(apps.id, appId), eq(apps.ownerId, user.id)))
      .limit(1);
    if (!app) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }
    const spec = app.githubRepoUrl ? await getLatestSpec(appId) : null;
    if (spec) {
      changeMode = true;
      instructions = CHANGE_VOICE_INSTRUCTIONS.replace(
        "__CURRENT_SPEC__",
        JSON.stringify(spec, null, 2),
      );
    }
  }

  // Create the voice conversation row.
  const [convo] = await db
    .insert(conversations)
    .values({
      userId: user.id,
      appId: appId ?? null,
      channel: "voice",
      transcript: [],
    })
    .returning();

  // Mint the ephemeral client secret.
  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 900 }, // 15 min cap
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("client_secrets failed:", res.status, data);
    return NextResponse.json(
      { error: "Could not start a voice session. Please try again." },
      { status: 502 },
    );
  }
  const clientSecret: string | undefined = data.value ?? data.client_secret?.value;
  if (!clientSecret) {
    return NextResponse.json(
      { error: "Voice session response was malformed." },
      { status: 502 },
    );
  }

  await audit({
    userId: user.id,
    appId: appId ?? undefined,
    action: "voice.sessionStarted",
    payload: { conversationId: convo.id, model: REALTIME_MODEL, changeMode },
  });

  return NextResponse.json({
    conversationId: convo.id,
    clientSecret,
    model: REALTIME_MODEL,
    instructions,
    changeMode,
  });
}
