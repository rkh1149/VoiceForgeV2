import type { AgentArtifactItem } from "@/components/AgentArtifactsList";
import type { WorkflowRepairPackage } from "@/lib/build/workflow-repair";

const statusStyles: Record<AgentArtifactItem["status"], string> = {
  passed: "bg-green-100 text-green-700",
  warning: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
  skipped: "bg-slate-100 text-slate-600",
};

function readable(value: string | undefined): string {
  return (value ?? "Unknown").replaceAll("_", " ");
}

function latestRepairs(
  artifacts: AgentArtifactItem[],
): Array<{ artifact: AgentArtifactItem; repair: WorkflowRepairPackage }> {
  const byId = new Map<
    string,
    { artifact: AgentArtifactItem; repair: WorkflowRepairPackage }
  >();
  for (const artifact of artifacts) {
    const repair = artifact.payload as unknown as WorkflowRepairPackage;
    if (!repair?.id || !repair.classification || !repair.target) continue;
    byId.set(repair.id, { artifact, repair });
  }
  return [...byId.values()];
}

function validationLabel(
  value: "pending" | "passed" | "failed" | "not_applicable",
): string {
  if (value === "not_applicable") return "Not needed";
  return value[0].toUpperCase() + value.slice(1);
}

export default function WorkflowRepairReport({
  artifacts,
}: {
  artifacts: AgentArtifactItem[];
}) {
  const repairs = latestRepairs(artifacts);
  if (repairs.length === 0) return null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">
          Workflow repairs
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Focused repairs tied to a promised user journey, with unrelated files
          protected.
        </p>
      </div>

      <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
        {repairs.map(({ artifact, repair }) => {
          const latestAttempt = repair.attempts.at(-1);
          const applicationFiles = [
            ...(latestAttempt?.filesWritten ?? []),
            ...(latestAttempt?.filesDeleted ?? []),
          ].filter((path) => path.startsWith("src/"));
          const testFiles = [
            ...(latestAttempt?.filesWritten ?? []),
            ...(latestAttempt?.filesDeleted ?? []),
          ].filter((path) => path.startsWith("e2e/generated/"));

          return (
            <article key={repair.id} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800">
                    {repair.target.workflowName}
                  </p>
                  <p className="mt-0.5 text-xs capitalize text-slate-500">
                    {readable(repair.classification.category)} ·{" "}
                    {readable(repair.classification.subtype)}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusStyles[artifact.status]}`}
                >
                  {readable(repair.status)}
                </span>
              </div>

              <p className="mt-2 text-sm text-slate-600">
                {repair.promise.statement}
              </p>

              <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-slate-400">Repair target</dt>
                  <dd className="mt-0.5 capitalize text-slate-700">
                    {readable(repair.classification.targetSurface)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Static review</dt>
                  <dd className="mt-0.5 text-slate-700">
                    {validationLabel(repair.validation.staticReview)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Focused browser</dt>
                  <dd className="mt-0.5 text-slate-700">
                    {validationLabel(repair.validation.browserJourney)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Full gauntlet</dt>
                  <dd className="mt-0.5 capitalize text-slate-700">
                    {repair.validation.fullGauntlet}
                  </dd>
                </div>
              </dl>

              <p className="mt-3 text-xs text-slate-500">
                Changed application files: {applicationFiles.length}. Changed
                generated tests: {testFiles.length}. Protected files:{" "}
                {repair.scope.protectedPaths.length}.
              </p>

              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-slate-600">
                  Repair evidence
                </summary>
                <div className="mt-2 space-y-2 text-xs text-slate-600">
                  <p>{repair.classification.reasons.join(" ")}</p>
                  {latestAttempt?.reason && <p>{latestAttempt.reason}</p>}
                  {latestAttempt && (
                    <p>
                      Inspected {latestAttempt.filesInspected.length} file(s);{" "}
                      changed{" "}
                      {
                        new Set([
                          ...latestAttempt.filesWritten,
                          ...latestAttempt.filesDeleted,
                        ]).size
                      }
                      .
                    </p>
                  )}
                </div>
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}
