import type { AgentArtifactItem } from "@/components/AgentArtifactsList";
import type { UiAffordanceReview } from "@/lib/build/ui-affordance-review";

const statusStyles: Record<AgentArtifactItem["status"], string> = {
  passed: "bg-green-100 text-green-700",
  warning: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
  skipped: "bg-slate-100 text-slate-600",
};

const workflowStatusStyles: Record<
  UiAffordanceReview["workflows"][number]["status"],
  string
> = {
  discoverable: "text-green-700",
  needs_repair: "text-red-700",
  not_applicable: "text-slate-500",
};

function humanWorkflowStatus(
  status: UiAffordanceReview["workflows"][number]["status"],
): string {
  if (status === "discoverable") return "Discoverable";
  if (status === "needs_repair") return "Needs repair";
  return "Not applicable";
}

function stripIssuePrefix(issue: string): string {
  return issue.replace(/^ui_affordance:\s*/i, "");
}

export default function InterfaceReadinessReport({
  artifact,
}: {
  artifact: AgentArtifactItem | null;
}) {
  if (!artifact?.payload) return null;
  const report = artifact.payload as Partial<UiAffordanceReview> & {
    skipped?: boolean;
    reason?: string;
  };
  if (!report.summary) return null;

  const workflows = report.workflows ?? [];
  const blockingIssues = report.blockingIssues ?? [];
  const warnings = report.warnings ?? [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">
            Interface readiness
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Can each promised workflow be found and started?
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusStyles[artifact.status]}`}
        >
          {artifact.status}
        </span>
      </div>

      {report.skipped ? (
        <p className="mt-3 text-sm text-slate-500">
          {report.reason ?? "No user workflows required an interface review."}
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
            <div>
              <dt className="text-xs text-slate-500">Workflows</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.workflowsDiscoverable}/
                {report.summary.workflowsPlanned}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Reachable routes</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.reachableRoutes}/{report.summary.routesFound}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Visible controls</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.controlsMatched}/
                {report.summary.controlsExpected}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Entity paths</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.entityPathsAvailable}/
                {report.summary.entityPathsRequired}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Stable controls</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.stableControlsBound}/
                {report.summary.stableControlsRequired}
              </dd>
              {(report.summary.legacyControlFallbacks ?? 0) > 0 && (
                <p className="text-xs text-amber-700">
                  {report.summary.legacyControlFallbacks} legacy fallback
                </p>
              )}
            </div>
          </dl>

          {workflows.length > 0 && (
            <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
              {workflows.map((workflow) => (
                <div
                  key={workflow.contractId}
                  className="flex items-start justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800">
                      {workflow.name}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Starts on {workflow.startRoute}; {workflow.matchedControls}/
                      {workflow.expectedControls} controls found
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-xs font-medium ${workflowStatusStyles[workflow.status]}`}
                  >
                    {humanWorkflowStatus(workflow.status)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {(blockingIssues.length > 0 || warnings.length > 0) && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-700">
                Review details
              </summary>
              <ul className="mt-2 space-y-2 text-sm text-slate-600">
                {[...blockingIssues, ...warnings].map((issue) => (
                  <li key={issue}>{stripIssuePrefix(issue)}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
