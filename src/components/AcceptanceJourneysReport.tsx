import type { AgentArtifactItem } from "@/components/AgentArtifactsList";
import type { AcceptanceTestReview } from "@/lib/build/acceptance-test-review";

type BrowserResult = {
  status: string;
  summary: string | null;
} | null;

const statusStyles: Record<AgentArtifactItem["status"], string> = {
  passed: "bg-green-100 text-green-700",
  warning: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
  skipped: "bg-slate-100 text-slate-600",
};

function displayStatus(
  artifact: AgentArtifactItem,
  browserResult: BrowserResult,
): AgentArtifactItem["status"] {
  if (browserResult?.status === "failed") return "failed";
  if (browserResult?.status === "passed" && artifact.status === "passed") {
    return "passed";
  }
  return artifact.status;
}

function executionLabel(browserResult: BrowserResult): string {
  if (!browserResult) return "Waiting to run";
  if (browserResult.status === "passed") return "Browser passed";
  if (browserResult.status === "failed") return "Browser failed";
  if (browserResult.status === "skipped") return "Browser skipped";
  return browserResult.status;
}

export default function AcceptanceJourneysReport({
  artifact,
  browserResult,
}: {
  artifact: AgentArtifactItem | null;
  browserResult: BrowserResult;
}) {
  if (!artifact?.payload) return null;
  const report = artifact.payload as unknown as Partial<AcceptanceTestReview> & {
    skipped?: boolean;
    reason?: string;
  };
  if (!report.summary) return null;

  const journeys = report.journeys ?? [];
  const blockingIssues = report.blockingIssues ?? [];
  const warnings = report.warnings ?? [];
  const overallStatus = displayStatus(artifact, browserResult);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">
            Acceptance journeys
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Can a person complete the promised workflows from start to finish?
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusStyles[overallStatus]}`}
        >
          {overallStatus}
        </span>
      </div>

      {report.skipped ? (
        <p className="mt-3 text-sm text-slate-500">
          {report.reason ?? "No browser journeys were required."}
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
            <div>
              <dt className="text-xs text-slate-500">Planned</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.journeysPlanned}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Generated</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.journeysGenerated}/
                {report.summary.journeysPlanned}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Contract verified</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.journeysVerified}/
                {report.summary.journeysPlanned}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Execution</dt>
              <dd className="text-sm font-semibold text-slate-900">
                {executionLabel(browserResult)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Stable locators</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.stableLocatorsVerified}/
                {report.summary.stableLocatorsRequired}
              </dd>
            </div>
          </dl>

          {journeys.length > 0 && (
            <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
              {journeys.map((journey) => (
                <div
                  key={journey.journeyId}
                  className="flex flex-wrap items-start justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800">
                      {journey.name}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Steps {journey.stepsVerified}/{journey.stepsRequired}
                      {journey.stableLocatorsRequired > 0
                        ? ` · stable controls ${journey.stableLocatorsVerified}/${journey.stableLocatorsRequired}`
                        : ""}
                      {journey.savesRequired > 0
                        ? ` · saves ${journey.savesVerified}/${journey.savesRequired}`
                        : ""}
                      {journey.handoffsRequired > 0
                        ? ` · handoffs ${journey.handoffsVerified}/${journey.handoffsRequired}`
                        : ""}
                      {journey.roleScenariosRequired > 0
                        ? ` · roles ${journey.roleScenariosVerified}/${journey.roleScenariosRequired}`
                        : ""}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      journey.status === "verified"
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {journey.status === "verified" ? "Ready" : "Needs repair"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {(blockingIssues.length > 0 || warnings.length > 0) && (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs font-medium text-slate-600">
                Review details
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {[...blockingIssues, ...warnings].map((issue) => (
                  <li key={issue}>{issue.replace(/^acceptance_test:[a-z_]+\s*/i, "")}</li>
                ))}
              </ul>
            </details>
          )}

          {report.summary.nonBrowserWorkflows > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              {report.summary.nonBrowserWorkflows} scheduled or system workflow
              {report.summary.nonBrowserWorkflows === 1 ? " is" : "s are"} covered
              by non-browser checks.
            </p>
          )}
        </>
      )}
    </section>
  );
}
