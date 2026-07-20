import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apps, conversations } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import { getConversationPreview } from "@/lib/conversation-history";

export const dynamic = "force-dynamic";

const statusLabels: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-slate-100 text-slate-600" },
  spec_approved: { label: "Approved", className: "bg-blue-100 text-blue-700" },
  building: { label: "Building", className: "bg-amber-100 text-amber-700" },
  testing: { label: "Preview ready", className: "bg-blue-100 text-blue-700" },
  deployed: { label: "Live", className: "bg-green-100 text-green-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
  archived: { label: "Archived", className: "bg-slate-100 text-slate-500" },
};

export default async function MyAppsPage() {
  const user = await getOrCreateCurrentUser();
  if (!user) return null; // middleware guarantees sign-in

  const db = getDb();
  const myApps = await db
    .select()
    .from(apps)
    .where(eq(apps.ownerId, user.id))
    .orderBy(desc(apps.updatedAt));

  const planningSessions = await db
    .select({
      id: conversations.id,
      appId: conversations.appId,
      transcript: conversations.transcript,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(and(eq(conversations.userId, user.id), eq(conversations.channel, "text")))
    .orderBy(desc(conversations.updatedAt))
    .limit(100);

  const unlinkedPlanningSessions = planningSessions
    .filter((session) => session.appId === null)
    .slice(0, 3);
  const planningSessionByAppId = new Map<string, string>();
  for (const session of planningSessions) {
    if (session.appId && !planningSessionByAppId.has(session.appId)) {
      planningSessionByAppId.set(session.appId, session.id);
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-forge-900">
            {user.displayName ? `${user.displayName}’s apps` : "My apps"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Every app you create with VoiceForge lives here.
          </p>
        </div>
        <Link
          href="/dashboard/create"
          className="rounded-xl bg-forge-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-forge-700"
        >
          + New app
        </Link>
      </div>

      {unlinkedPlanningSessions.length > 0 && (
        <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700">
            In-progress planning
          </h2>
          <ul className="mt-3 space-y-2">
            {unlinkedPlanningSessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-col gap-1 border-t border-slate-100 pt-2 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="line-clamp-1 text-sm text-slate-700">
                    {getConversationPreview(session.transcript)}
                  </p>
                  <p className="text-xs text-slate-400">
                    Updated{" "}
                    {session.updatedAt.toLocaleString("en-CA", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
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

      {myApps.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
          <p className="text-4xl">🛠️</p>
          <h2 className="mt-4 text-lg font-semibold text-slate-800">
            No apps yet
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-slate-500">
            Describe the app you want and VoiceForge will plan it with you,
            build it, test it, and put it online.
          </p>
          <Link
            href="/dashboard/create"
            className="mt-6 inline-block rounded-xl bg-forge-600 px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-forge-700"
          >
            Create your first app
          </Link>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {myApps.map((app) => {
            const status = statusLabels[app.status] ?? statusLabels.draft;
            const planningSessionId = planningSessionByAppId.get(app.id);
            const primaryHref =
              app.status === "draft" && planningSessionId
                ? `/dashboard/create?conversationId=${planningSessionId}`
                : `/dashboard/apps/${app.id}`;
            return (
              <li
                key={app.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <Link
                    href={primaryHref}
                    className="font-semibold text-slate-900 hover:text-forge-600 hover:underline"
                  >
                    {app.name}
                  </Link>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.className}`}
                  >
                    {status.label}
                  </span>
                </div>
                {app.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-slate-500">
                    {app.description}
                  </p>
                )}
                <div className="mt-4 flex gap-3 text-sm">
                  {app.status === "draft" && planningSessionId && (
                    <Link
                      href={`/dashboard/create?conversationId=${planningSessionId}`}
                      className="font-medium text-forge-600 hover:underline"
                    >
                      Resume planning
                    </Link>
                  )}
                  {["spec_approved", "building", "testing", "failed"].includes(
                    app.status,
                  ) && (
                    <Link
                      href={`/dashboard/apps/${app.id}`}
                      className="font-medium text-forge-600 hover:underline"
                    >
                      View build
                    </Link>
                  )}
                  {app.productionUrl && (
                    <a
                      href={app.productionUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-forge-600 hover:underline"
                    >
                      Open app ↗
                    </a>
                  )}
                  {app.previewUrl && (
                    <a
                      href={app.previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-slate-500 hover:underline"
                    >
                      Preview ↗
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
