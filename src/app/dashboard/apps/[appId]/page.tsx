import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apps, deployments } from "@/db/schema";
import { getOrCreateCurrentUser } from "@/lib/users";
import BuildStatus from "@/components/BuildStatus";
import DeleteAppButton from "@/components/DeleteAppButton";
import VersionHistory from "@/components/VersionHistory";
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
      <BuildStatus appId={app.id} />
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
