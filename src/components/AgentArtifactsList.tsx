export type AgentArtifactItem = {
  id?: string;
  agentKey: string;
  phaseKey: string;
  artifactType: string;
  status: "passed" | "warning" | "failed" | "skipped";
  summary: string;
  payload?: Record<string, unknown> | null;
  createdAt: string | Date;
};

const statusClass: Record<AgentArtifactItem["status"], string> = {
  passed: "bg-green-100 text-green-700",
  warning: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
  skipped: "bg-slate-100 text-slate-600",
};

function humanize(value: string): string {
  return value.replace(/[-_]/g, " ");
}

function formatTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function AgentArtifactsList({
  artifacts,
  title = "Agent review",
}: {
  artifacts: AgentArtifactItem[];
  title?: string;
}) {
  if (artifacts.length === 0) return null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      <div className="mt-3 space-y-3">
        {artifacts.map((artifact) => {
          const detail =
            artifact.payload && Object.keys(artifact.payload).length > 0
              ? JSON.stringify(artifact.payload, null, 2)
              : null;
          return (
            <div
              key={
                artifact.id ??
                `${artifact.agentKey}-${artifact.phaseKey}-${artifact.createdAt}`
              }
              className="border-l-2 border-slate-200 pl-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium capitalize text-slate-800">
                  {humanize(artifact.agentKey)}
                </span>
                <span className="text-xs capitalize text-slate-400">
                  {humanize(artifact.phaseKey)}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass[artifact.status]}`}
                >
                  {artifact.status}
                </span>
                <span className="text-xs capitalize text-slate-400">
                  {humanize(artifact.artifactType)}
                </span>
                <span className="text-xs text-slate-300">
                  {formatTime(artifact.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600">{artifact.summary}</p>
              {detail && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-slate-400">
                    Details
                  </summary>
                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 font-mono text-xs text-slate-500">
                    {detail}
                  </pre>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
