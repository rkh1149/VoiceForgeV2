import type { AgentArtifactItem } from "@/components/AgentArtifactsList";
import type { PersistenceHandoffReview } from "@/lib/build/persistence-handoff-review";

const statusStyles: Record<AgentArtifactItem["status"], string> = {
  passed: "bg-green-100 text-green-700",
  warning: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
  skipped: "bg-slate-100 text-slate-600",
};

function stripIssuePrefix(issue: string): string {
  return issue.replace(/^persistence_handoff:[a-z_]+\s*/i, "");
}

function evidenceStatus(status: "verified" | "needs_repair"): string {
  return status === "verified" ? "Verified" : "Needs repair";
}

export default function PersistenceHandoffReport({
  artifact,
}: {
  artifact: AgentArtifactItem | null;
}) {
  if (!artifact?.payload) return null;
  const report = artifact.payload as Partial<PersistenceHandoffReview> & {
    skipped?: boolean;
    reason?: string;
  };
  if (!report.summary) return null;

  const saves = report.saves ?? [];
  const handoffs = report.handoffs ?? [];
  const blockingIssues = report.blockingIssues ?? [];
  const warnings = report.warnings ?? [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">
            Persistence and handoff
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Do saved results survive refresh and reach the next workflow?
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
          {report.reason ?? "No durable saves or workflow handoffs were planned."}
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
            <div>
              <dt className="text-xs text-slate-500">Durable saves</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.savesVerified}/{report.summary.savesRequired}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Exact schemas</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.exactSchemasVerified}/
                {report.summary.exactSchemasRequired}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Refresh paths</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.reloadPathsVerified}/
                {report.summary.reloadPathsRequired}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Handoffs</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.handoffsVerified}/
                {report.summary.handoffsRequired}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Focused tests</dt>
              <dd className="text-lg font-semibold text-slate-900">
                {report.summary.persistenceTestsVerified}/
                {report.summary.persistenceTestsRequired}
              </dd>
            </div>
          </dl>

          {saves.length > 0 && (
            <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
              {saves.map((save) => (
                <div
                  key={`${save.workflowId}-${save.stepId}-${save.entityKey}`}
                  className="flex items-start justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800">
                      {save.workflowName}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {save.operation} {save.entityKey} through {save.storage}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-xs font-medium ${
                      save.status === "verified" ? "text-green-700" : "text-red-700"
                    }`}
                  >
                    {evidenceStatus(save.status)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {handoffs.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold uppercase text-slate-500">
                Downstream handoffs
              </h4>
              <ul className="mt-2 space-y-2">
                {handoffs.map((handoff) => (
                  <li
                    key={handoff.id}
                    className="flex items-start justify-between gap-4 text-sm"
                  >
                    <span className="text-slate-600">
                      {handoff.producerWorkflowName} to {handoff.consumerWorkflowName}
                    </span>
                    <span
                      className={`shrink-0 text-xs font-medium ${
                        handoff.status === "verified"
                          ? "text-green-700"
                          : "text-red-700"
                      }`}
                    >
                      {evidenceStatus(handoff.status)}
                    </span>
                  </li>
                ))}
              </ul>
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
