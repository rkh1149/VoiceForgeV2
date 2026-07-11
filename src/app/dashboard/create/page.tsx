import Link from "next/link";
import PlannerChat from "@/components/PlannerChat";

export default function CreateAppPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-forge-900">Create a new app</h1>
      <p className="mt-1 mb-6 text-sm text-slate-500">
        Tell VoiceForge what you want to build. It will ask a few questions,
        show you a plan, and only build after you approve.{" "}
        <Link
          href="/dashboard/voice"
          className="font-medium text-forge-600 hover:underline"
        >
          🎤 Prefer talking? Plan by voice
        </Link>
      </p>
      <PlannerChat />
    </div>
  );
}
