import Link from "next/link";
import type { ResumableBuild } from "@/lib/build-resume";

const statusLabels: Record<string, string> = {
  queued: "Waiting to start",
  generating: "Writing code",
  testing: "Testing",
  debugging: "Fixing test issues",
  deploying: "Deploying",
  awaiting_user_test: "Ready to try",
  needs_input: "Needs input",
  failed: "Failed",
};

function formatWhen(value: Date): string {
  return value.toLocaleString("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function BuildResumeList({
  builds,
  title,
}: {
  builds: ResumableBuild[];
  title: string;
}) {
  if (builds.length === 0) return null;

  return (
    <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      <ul className="mt-3 space-y-2">
        {builds.map((build) => (
          <li
            key={build.runId}
            className="flex flex-col gap-2 border-t border-slate-100 pt-2 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="line-clamp-1 text-sm font-medium text-slate-800">
                {build.appName}
              </p>
              {build.appDescription && (
                <p className="line-clamp-1 text-sm text-slate-500">
                  {build.appDescription}
                </p>
              )}
              <p className="text-xs text-slate-400">
                {statusLabels[build.runStatus] ?? build.runStatus} since{" "}
                {formatWhen(build.updatedAt)}
              </p>
            </div>
            <Link
              href={`/dashboard/apps/${build.appId}`}
              className="text-sm font-medium text-forge-600 hover:underline"
            >
              Resume building
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
