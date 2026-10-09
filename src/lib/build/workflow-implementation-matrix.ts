import type { ArchitecturePlan } from "../architecture";
import type { AppSpec } from "../spec";
import { classifyEntityBehaviors, type EntityBehaviorClassification } from "./entity-behavior";

export const WORKFLOW_IMPLEMENTATION_MATRIX_VERSION = 1 as const;

export type WorkflowImplementationMatrixRow = {
  workflowId: string;
  workflowName: string;
  roles: string[];
  startRoute: string;
  destinationRoute: string;
  controls: Array<{ id: string; name: string; route: string; kind: string }>;
  reads: string[];
  writes: string[];
  saves: Array<{ stepId: string; entityKey: string; operation: string; fieldKeys: string[] }>;
  handoffs: Array<{ id: string; consumerWorkflowId: string; consumerRoute: string; consumerControlId: string }>;
  acceptanceJourneyRequired: boolean;
};

export type WorkflowImplementationMatrix = {
  version: typeof WORKFLOW_IMPLEMENTATION_MATRIX_VERSION;
  rows: WorkflowImplementationMatrixRow[];
  entities: EntityBehaviorClassification[];
  blockingIssues: string[];
  warnings: string[];
  summary: { workflows: number; controls: number; saves: number; handoffs: number; primaryEntities: number };
};

export function createWorkflowImplementationMatrix(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
}): WorkflowImplementationMatrix {
  const entities = classifyEntityBehaviors(input);
  const rows = input.architecture.workflowContracts.map((contract) => ({
    workflowId: contract.id,
    workflowName: contract.name,
    roles: contract.actor.roles,
    startRoute: contract.start.route,
    destinationRoute: contract.success.route,
    controls: contract.controls.map((control) => ({
      id: control.id,
      name: control.accessibleName,
      route: control.route,
      kind: control.kind,
    })),
    reads: unique(contract.steps.flatMap((step) => step.reads)),
    writes: unique(contract.steps.flatMap((step) => step.writes)),
    saves: contract.expectedSaves.map((save) => ({
      stepId: save.stepId,
      entityKey: save.entityKey,
      operation: save.operation,
      fieldKeys: save.fieldKeys,
    })),
    handoffs: contract.handoffs.map((handoff) => ({
      id: handoff.id,
      consumerWorkflowId: handoff.consumerWorkflowId,
      consumerRoute: handoff.consumerRoute,
      consumerControlId: handoff.consumerControlId,
    })),
    acceptanceJourneyRequired: contract.trigger === "user_action",
  }));
  const blockingIssues: string[] = [];
  for (const row of rows) {
    if (row.acceptanceJourneyRequired && row.controls.length === 0) {
      blockingIssues.push(`workflow_matrix: ${row.workflowName} has no visible controls.`);
    }
    for (const save of row.saves) {
      if (!row.writes.includes(save.entityKey)) {
        blockingIssues.push(`workflow_matrix: ${row.workflowName} saves ${save.entityKey} but no step declares that write.`);
      }
    }
    for (const handoff of row.handoffs) {
      const consumer = rows.find((candidate) => candidate.workflowId === handoff.consumerWorkflowId);
      if (!consumer) {
        blockingIssues.push(`workflow_matrix: ${row.workflowName} hands off to missing workflow ${handoff.consumerWorkflowId}.`);
      }
    }
  }
  return {
    version: WORKFLOW_IMPLEMENTATION_MATRIX_VERSION,
    rows,
    entities,
    blockingIssues: unique(blockingIssues),
    warnings: [],
    summary: {
      workflows: rows.length,
      controls: rows.reduce((total, row) => total + row.controls.length, 0),
      saves: rows.reduce((total, row) => total + row.saves.length, 0),
      handoffs: rows.reduce((total, row) => total + row.handoffs.length, 0),
      primaryEntities: entities.filter((entity) => entity.behavior === "primary").length,
    },
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
