import { SignIn } from "@clerk/nextjs";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/db";
import { apps } from "@/db/schema";
import {
  buildPlatformSessionStartPath,
  platformSignInQuerySchema,
} from "@/lib/platform/sign-in-return";

export default async function PlatformSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = platformSignInQuerySchema.safeParse(await searchParams);
  if (!parsed.success) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <h1 className="text-2xl font-bold text-slate-950">This sign-in link is invalid</h1>
        <p className="mt-2 max-w-md text-slate-600">Return to the app and choose its VoiceForge sign-in button again.</p>
        <Link href="/" className="mt-5 font-semibold text-forge-700 underline">Go to VoiceForge</Link>
      </main>
    );
  }

  const [app] = await getDb()
    .select({ name: apps.name })
    .from(apps)
    .where(eq(apps.id, parsed.data.appId))
    .limit(1);
  const continueTo = buildPlatformSessionStartPath(parsed.data);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-10">
      <div className="mb-5 max-w-md text-center">
        <p className="text-sm font-semibold text-forge-700">VoiceForge member access</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-950">Sign in to continue to {app?.name ?? "your app"}</h1>
        <p className="mt-2 text-sm text-slate-600">After your email is verified, you will return to the app automatically.</p>
      </div>
      <SignIn
        path="/platform-sign-in"
        routing="path"
        forceRedirectUrl={continueTo}
        fallbackRedirectUrl={continueTo}
      />
    </main>
  );
}
