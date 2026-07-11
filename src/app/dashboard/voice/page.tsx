import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apps } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import VoiceChat from "@/components/VoiceChat";

export const dynamic = "force-dynamic";

export default async function VoicePage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string }>;
}) {
  const user = await getOrCreateCurrentUser();
  if (!user) return null;

  const { app: appIdParam } = await searchParams;

  let app = null;
  if (appIdParam) {
    const db = getDb();
    const rows = await db
      .select()
      .from(apps)
      .where(and(eq(apps.id, appIdParam), eq(apps.ownerId, user.id)))
      .limit(1);
    app = rows[0] ?? null;
    if (!app) notFound();
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-forge-900">
        {app ? `Change ${app.name} by voice` : "Plan an app by voice"}
      </h1>
      <p className="mt-1 mb-6 text-sm text-slate-500">
        Talk naturally — VoiceForge asks questions out loud and shows the plan
        on screen. Nothing is built until you press Approve.
      </p>
      <VoiceChat appId={app?.id} appName={app?.name} />
    </div>
  );
}
