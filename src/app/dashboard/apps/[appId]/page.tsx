import Link from "next/link";
import { notFound } from "next/navigation";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  appEntitySchemas,
  appMemberships,
  appRecords,
  apps,
  approvals,
  buildRuns,
  conversations,
  deployments,
  users,
} from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import BuildStatus from "@/components/BuildStatus";
import ConversationHistory from "@/components/ConversationHistory";
import DeleteAppButton from "@/components/DeleteAppButton";
import PlatformMembersManager from "@/components/PlatformMembersManager";
import VersionHistory from "@/components/VersionHistory";
import { getConversationMessages } from "@/lib/conversation-history";
import { getCurrentProductionDeploymentId } from "@/lib/vercel";

export const dynamic = "force-dynamic";

export default async function AppDetailPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const user = await getOrCreateCurrentUser();
  if (!user) return null;

  const { appId } = await params;
  const db = getDb();
  const rows = await db
    .select()
    .from(apps)
    .where(
      user.role === "admin"
        ? eq(apps.id, appId)
        : and(eq(apps.id, appId), eq(apps.ownerId, user.id)),
    )
    .limit(1);
  const app = rows[0];
  if (!app) notFound();

  const [owner] = await db
    .select({
      email: users.email,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, app.ownerId))
    .limit(1);

  const productionVersions = await db
    .select({
      id: deployments.id,
      url: deployments.url,
      createdAt: deployments.createdAt,
      vercelDeploymentId: deployments.vercelDeploymentId,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.appId, app.id),
        eq(deployments.environment, "production"),
        eq(deployments.status, "ready"),
      ),
    )
    .orderBy(desc(deployments.createdAt))
    .limit(10);

  const runHistory = await db
    .select({
      id: buildRuns.id,
      status: buildRuns.status,
      errorMessage: buildRuns.errorMessage,
      createdAt: buildRuns.createdAt,
    })
    .from(buildRuns)
    .where(eq(buildRuns.appId, app.id))
    .orderBy(desc(buildRuns.createdAt))
    .limit(15);

  const appConversations = await db
    .select({
      id: conversations.id,
      channel: conversations.channel,
      transcript: conversations.transcript,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(eq(conversations.appId, app.id))
    .orderBy(desc(conversations.updatedAt))
    .limit(10);

  const latestTextConversation = appConversations.find(
    (conversation) => conversation.channel === "text",
  );

  const [pendingBuildApproval] =
    app.status === "draft"
      ? await db
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.appId, app.id),
              eq(approvals.userId, user.id),
              eq(approvals.type, "build"),
              eq(approvals.status, "pending"),
            ),
          )
          .orderBy(desc(approvals.createdAt))
          .limit(1)
      : [];

  const [
    [{ dataEntityCount }],
    [{ activeRecordCount }],
    [{ invitedMemberCount }],
  ] = await Promise.all([
    db
      .select({ dataEntityCount: count() })
      .from(appEntitySchemas)
      .where(eq(appEntitySchemas.appId, app.id)),
    db
      .select({ activeRecordCount: count() })
      .from(appRecords)
      .where(and(eq(appRecords.appId, app.id), isNull(appRecords.deletedAt))),
    db
      .select({ invitedMemberCount: count() })
      .from(appMemberships)
      .where(eq(appMemberships.appId, app.id)),
  ]);

  // After a rollback, "current" is not necessarily the newest — ask Vercel.
  const currentDeploymentId =
    app.vercelProjectId && productionVersions.length > 1
      ? await getCurrentProductionDeploymentId(app.vercelProjectId).catch(
          () => null,
        )
      : null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-forge-900">{app.name}</h1>
      {app.description && (
        <p className="mt-1 mb-6 text-sm text-slate-500">{app.description}</p>
      )}

      {pendingBuildApproval && latestTextConversation && (
        <div className="mb-4 rounded-2xl border border-forge-100 bg-forge-50 p-5 shadow-sm">
          <p className="font-semibold text-forge-900">
            This app is waiting for your build approval.
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Return to the saved planning session to approve it or keep refining
            the plan.
          </p>
          <Link
            href={`/dashboard/create?conversationId=${latestTextConversation.id}`}
            className="mt-3 inline-block rounded-xl bg-forge-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-forge-700"
          >
            Continue planning
          </Link>
        </div>
      )}

      <BuildStatus appId={app.id} />

      <ConversationHistory
        conversations={appConversations.map((conversation) => ({
          id: conversation.id,
          channel: conversation.channel,
          updatedAt: conversation.updatedAt,
          messages: getConversationMessages(conversation.transcript),
        }))}
      />

      <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700">
          Platform data
        </h3>
        <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
          <div>
            <dt className="text-xs text-slate-400">Entities</dt>
            <dd className="mt-1 text-xl font-semibold text-forge-900">
              {dataEntityCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Records</dt>
            <dd className="mt-1 text-xl font-semibold text-forge-900">
              {activeRecordCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Members</dt>
            <dd className="mt-1 text-xl font-semibold text-forge-900">
              {invitedMemberCount + 1}
            </dd>
          </div>
        </dl>
      </div>

      {(app.ownerId === user.id || user.role === "admin") &&
        owner &&
        dataEntityCount > 0 && (
          <PlatformMembersManager
            appId={app.id}
            ownerEmail={owner.email}
            ownerName={owner.displayName}
          />
        )}

      {runHistory.length > 1 && (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">
            Build history
          </h3>
          <ul className="mt-2 space-y-1.5">
            {runHistory.map((r, i) => (
              <li
                key={r.id}
                className="flex items-center justify-between text-sm"
              >
                <span className="flex items-center gap-2">
                  <span>
                    {r.status === "failed"
                      ? "❌"
                      : r.status === "complete" ||
                          r.status === "awaiting_user_test"
                        ? "✅"
                        : "⏳"}
                  </span>
                  <Link
                    href={`/dashboard/apps/${app.id}/runs/${r.id}`}
                    className="text-forge-700 hover:underline"
                    suppressHydrationWarning
                  >
                    {r.createdAt.toLocaleString("en-CA", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </Link>
                  {i === 0 && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                      latest
                    </span>
                  )}
                </span>
                <span className="text-xs text-slate-400">{r.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {app.ownerId === user.id && (
        <>
          <VersionHistory
            appId={app.id}
            currentDeploymentId={currentDeploymentId}
            versions={productionVersions.map((v) => ({
              ...v,
              createdAt: v.createdAt.toISOString(),
            }))}
          />
          <DeleteAppButton appId={app.id} appName={app.name} />
        </>
      )}
    </div>
  );
}
