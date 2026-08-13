import type { AgentArtifactItem } from "@/components/AgentArtifactsList";
import type { HumanCompletenessReview } from "@/lib/build/human-completeness-review";

const statusStyles: Record<AgentArtifactItem["status"], string> = {
  passed: "bg-green-100 text-green-700",
  warning: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
  skipped: "bg-slate-100 text-slate-600",
};

function statusLabel(
  artifact: AgentArtifactItem,
  report: Partial<HumanCompletenessReview>,
): string {
  if (!report.available) return "Review unavailable";
  if (artifact.status === "failed") return "Needs repair";
  if (artifact.status === "warning") return "Ready with notes";
  return "Ready";
}

function verdictLabel(
  verdict: HumanCompletenessReview["assessments"][number]["verdict"],
): string {
  if (verdict === "partially_supported") return "Partial";
  if (verdict === "supported") return "Supported";
  if (verdict === "missing") return "Missing";
  return "Confirm in preview";
}

export default function HumanCompletenessReport({
  artifact,
}: {
  artifact: AgentArtifactItem | null;
}) {
  if (!artifact?.payload) return null;
  const report = artifact.payload as unknown as Partial<HumanCompletenessReview>;
  if (!report.summary) return null;
  const assessments = report.assessments ?? [];
  const findings = assessments.filter(
    (assessment) => assessment.verdict !== "supported",
  );
  const warnings = report.warnings ?? [];
  const blockingIssues = report.blockingIssues ?? [];

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">
            Product completeness
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Would a non-technical person recognize the app they were promised?
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[artifact.status]}`}
        >
          {statusLabel(artifact, report)}
        </span>
      </div>

      <p className="mt-3 text-sm text-slate-600">
        {report.overallAssessment ?? artifact.summary}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
        <div>
          <dt className="text-xs text-slate-500">Reviewed</dt>
          <dd className="text-lg font-semibold text-slate-900">
            {report.summary.promisesReviewed}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Supported</dt>
          <dd className="text-lg font-semibold text-green-700">
            {report.summary.supported}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Partial</dt>
          <dd className="text-lg font-semibold text-amber-700">
            {report.summary.partiallySupported}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Missing</dt>
          <dd className="text-lg font-semibold text-red-700">
            {report.summary.missing}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Confirm</dt>
          <dd className="text-lg font-semibold text-slate-700">
            {report.summary.unclear}
          </dd>
        </div>
      </dl>

      {findings.length > 0 && (
        <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
          {findings.map((assessment) => (
            <div
              key={assessment.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800">
                  {assessment.statement}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {assessment.finding || assessment.userImpact}
                </p>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  assessment.verdict === "missing"
                    ? "bg-red-100 text-red-700"
                    : assessment.verdict === "partially_supported"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-slate-100 text-slate-600"
                }`}
              >
                {verdictLabel(assessment.verdict)}
              </span>
            </div>
          ))}
        </div>
      )}

      {(blockingIssues.length > 0 ||
        warnings.length > 0 ||
        (report.limitations?.length ?? 0) > 0) && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">
            Review details
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-slate-600">
            {[...blockingIssues, ...warnings, ...(report.limitations ?? [])].map(
              (item, index) => (
                <li key={`${index}-${item}`}>
                  {item.replace(/^human_completeness:[^ ]+\s*/i, "")}
                </li>
              ),
            )}
          </ul>
        </details>
      )}
    </section>
  );
}
