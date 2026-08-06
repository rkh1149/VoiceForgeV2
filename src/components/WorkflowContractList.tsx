import type { WorkflowContract } from "@/lib/workflow-contract";

const storageLabels: Record<
  WorkflowContract["expectedSaves"][number]["storage"],
  string
> = {
  localStorage: "this browser",
  platformData: "shared app data",
  platformFiles: "app files",
};

function sentenceList(values: string[]): string {
  if (values.length < 2) return values[0] ?? "None";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

export default function WorkflowContractList({
  contracts,
}: {
  contracts: WorkflowContract[];
}) {
  if (contracts.length === 0) return null;

  const namesById = new Map(
    contracts.map((contract) => [contract.id, contract.name]),
  );

  return (
    <section className="mt-4 border-t border-slate-200 pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-800">
          Promised workflows
        </h4>
        <span className="text-xs text-slate-500">
          {contracts.length} workflow{contracts.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="mt-2 divide-y divide-slate-200">
        {contracts.map((contract) => (
          <details key={contract.id} className="py-3">
            <summary className="cursor-pointer list-none">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-800">
                  {contract.name}
                </span>
                {contract.actor.roles.map((role) => (
                  <span
                    key={role}
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-600"
                  >
                    {role}
                  </span>
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Starts on {contract.start.screen} · {contract.success.visibleResult}
              </p>
            </summary>

            <div className="mt-3 space-y-3 text-sm text-slate-600">
              {contract.start.preconditions.length > 0 && (
                <div>
                  <p className="font-medium text-slate-700">Before starting</p>
                  <p>{sentenceList(contract.start.preconditions)}</p>
                </div>
              )}

              <div>
                <p className="font-medium text-slate-700">What the user can find</p>
                <p>
                  {sentenceList(
                    contract.controls.map((control) => control.accessibleName),
                  )}
                </p>
              </div>

              <div>
                <p className="font-medium text-slate-700">What happens</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5">
                  {contract.steps.map((step) => (
                    <li key={step.id}>{step.description}</li>
                  ))}
                </ol>
              </div>

              {contract.expectedSaves.length > 0 && (
                <div>
                  <p className="font-medium text-slate-700">What is saved</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {contract.expectedSaves.map((save) => (
                      <li key={`${save.stepId}-${save.entityKey}`}>
                        {save.operation === "create"
                          ? "Creates"
                          : save.operation === "update"
                            ? "Updates"
                            : "Removes"}{" "}
                        {save.entityName} in {storageLabels[save.storage]}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {contract.handoffs.length > 0 && (
                <div>
                  <p className="font-medium text-slate-700">What this enables next</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {contract.handoffs.map((handoff) => (
                      <li key={handoff.id}>
                        {namesById.get(handoff.consumerWorkflowId) ??
                          handoff.consumerWorkflowId}{" "}
                        on {handoff.consumerRoute}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <details>
                <summary className="cursor-pointer text-xs text-slate-400">
                  Technical contract details
                </summary>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap bg-slate-50 p-3 font-mono text-xs text-slate-500">
                  {JSON.stringify(contract, null, 2)}
                </pre>
              </details>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
