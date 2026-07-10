import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SignInButton } from "@clerk/nextjs";

export default async function LandingPage() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-forge-600 text-3xl text-white shadow-lg">
        ⚒
      </div>
      <h1 className="text-4xl font-bold tracking-tight text-forge-900 sm:text-5xl">
        VoiceForge
      </h1>
      <p className="mt-4 max-w-md text-lg text-slate-600">
        Describe the app you want. VoiceForge plans it with you, builds it,
        tests it, and puts it online.
      </p>
      <div className="mt-8">
        <SignInButton mode="modal">
          <button className="rounded-xl bg-forge-600 px-8 py-3 text-lg font-semibold text-white shadow-md transition hover:bg-forge-700">
            Sign in to get started
          </button>
        </SignInButton>
      </div>
      <p className="mt-6 text-sm text-slate-500">
        Invite-only. Ask Richard for access.
      </p>
      <p className="mt-10 text-xs text-slate-400">
        <Link href="/sign-in" className="underline">
          Trouble with the pop-up? Use the sign-in page.
        </Link>
      </p>
    </main>
  );
}
