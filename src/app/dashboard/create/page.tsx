import Link from "next/link";
import BuildResumeList from "@/components/BuildResumeList";
import PlannerChat from "@/components/PlannerChat";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { approvals, apps, conversations, requirements } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { getConversationMessages } from "@/lib/conversation-history";
import { getResumableBuildsForUser } from "@/lib/build-resume";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CreateAppPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getOrCreateCurrentUser();
  if (!user) return null;

  const params = (await searchParams) ?? {};
  const requestedConversationId = firstParam(params.conversationId);
  const db = getDb();

  const activeConversationId =
    requestedConversationId && UUID_RE.test(requestedConversationId)
      ? requestedConversationId
      : null;

  const activeConversation = activeConversationId
    ? (
        await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, activeConversationId),
              eq(conversations.userId, user.id),
              eq(conversations.channel, "text"),
            ),
          )
          .limit(1)
      )[0]
    : null;

  const initialProposal = activeConversation?.appId
    ? (
        await db
          .select({
            appId: apps.id,
            appName: apps.name,
            requirementId: approvals.requirementId,
            approvalId: approvals.id,
            version: requirements.version,
          })
          .from(approvals)
          .innerJoin(apps, eq(apps.id, approvals.appId))
          .leftJoin(requirements, eq(requirements.id, approvals.requirementId))
          .where(
            and(
              eq(approvals.appId, activeConversation.appId),
              eq(approvals.userId, user.id),
              eq(approvals.type, "build"),
              eq(approvals.status, "pending"),
            ),
          )
          .orderBy(desc(approvals.createdAt))
          .limit(1)
      )[0]
    : null;

  const pendingProposal =
    initialProposal?.requirementId && initialProposal.version
      ? {
          appId: initialProposal.appId,
          appName: initialProposal.appName,
          requirementId: initialProposal.requirementId,
          approvalId: initialProposal.approvalId,
          version: initialProposal.version,
          forceDeepDiagnostic: false,
        }
      : null;

  const resumableBuilds = await getResumableBuildsForUser(user.id, "build");

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-bold text-forge-900">Create a new app</h1>
      <p className="mt-1 mb-6 text-sm text-slate-500">
        {activeConversation
          ? "Continuing a saved planning session. You can keep answering questions or approve the plan when it is ready."
          : "Tell VoiceForge what you want to build. It will ask a few questions, show you a plan, and only build after you approve."}{" "}
        <Link
          href="/dashboard/voice"
          className="font-medium text-forge-600 hover:underline"
        >
          🎤 Prefer talking? Plan by voice
        </Link>
      </p>

      <BuildResumeList
        builds={resumableBuilds}
        title="App builds in progress"
      />

      <PlannerChat
        key={activeConversation?.id ?? "new"}
        initialConversationId={activeConversation?.id ?? null}
        initialMessages={
          activeConversation
            ? getConversationMessages(activeConversation.transcript)
            : []
        }
        initialProposal={pendingProposal}
      />
    </div>
  );
}
