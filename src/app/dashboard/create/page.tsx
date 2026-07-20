import Link from "next/link";
import PlannerChat from "@/components/PlannerChat";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { approvals, apps, conversations, requirements } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import {
  getConversationMessages,
  getConversationPreview,
} from "@/lib/conversation-history";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatWhen(value: Date): string {
  return value.toLocaleString("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  });
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

  const recentPlanningSessions = (
    await db
      .select({
        id: conversations.id,
        transcript: conversations.transcript,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, user.id),
          eq(conversations.channel, "text"),
          isNull(conversations.appId),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(6)
  ).filter((session) => session.id !== activeConversation?.id);

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

      {recentPlanningSessions.length > 0 && (
        <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700">
            Saved planning sessions
          </h2>
          <ul className="mt-3 space-y-2">
            {recentPlanningSessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-col gap-1 border-t border-slate-100 pt-2 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="line-clamp-1 text-sm text-slate-700">
                    {getConversationPreview(session.transcript)}
                  </p>
                  <p className="text-xs text-slate-400">
                    Saved {formatWhen(session.updatedAt)}
                  </p>
                </div>
                <Link
                  href={`/dashboard/create?conversationId=${session.id}`}
                  className="text-sm font-medium text-forge-600 hover:underline"
                >
                  Resume planning
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

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
