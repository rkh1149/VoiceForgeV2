import type { ArchitecturePlan } from "../architecture";
import { platformEntityFromSpec } from "../platform/spec-seeding";
import type { AppSpec } from "../spec";
import type {
  WorkflowContract,
  WorkflowContractRole,
} from "../workflow-contract";

export const WORKFLOW_ACCEPTANCE_PLAN_VERSION = 2 as const;
export const WORKFLOW_ACCEPTANCE_MAX_WORKFLOWS_PER_JOURNEY = 3;
export const WORKFLOW_ACCEPTANCE_MAX_STEPS_PER_JOURNEY = 14;

export type WorkflowAcceptanceFixture = {
  entityName: string;
  entityKey: string;
  fieldKey: string;
  label: string;
  type: string;
  value: unknown;
  relationEntityKey: string | null;
};

export type WorkflowAcceptanceStep = {
  id: string;
  workflowId: string;
  workflowName: string;
  contractStepId: string;
  role: WorkflowContractRole;
  kind: WorkflowContract["steps"][number]["kind"];
  description: string;
  route: string;
  controlId: string;
  controlKind: WorkflowContract["controls"][number]["kind"] | null;
  accessibleName: string;
  reads: string[];
  writes: string[];
  visibleResult: string;
};

export type WorkflowAcceptanceSave = {
  id: string;
  workflowId: string;
  workflowName: string;
  stepId: string;
  operation: "create" | "update" | "delete";
  entityName: string;
  entityKey: string;
  fieldKeys: string[];
  storage: "localStorage" | "platformData" | "platformFiles";
  producedReference: string;
  refreshRequired: true;
};

export type WorkflowAcceptanceHandoff = {
  id: string;
  producerWorkflowId: string;
  producerWorkflowName: string;
  fromStepId: string;
  produces: string;
  storage: "localStorage" | "platformData" | "platformFiles";
  consumerWorkflowId: string;
  consumerWorkflowName: string;
  consumerRoute: string;
  consumerControlId: string;
  consumerAccessibleName: string;
  loadRule: string;
};

export type WorkflowAcceptanceRoleScenario = {
  workflowId: string;
  workflowName: string;
  allowedRoles: WorkflowContractRole[];
  visibleControlNames: string[];
  readOnlyRoles: WorkflowContractRole[];
};

export type WorkflowAcceptanceJourney = {
  id: string;
  name: string;
  sequence: number;
  dependsOnJourneyIds: string[];
  workflowIds: string[];
  startRoute: string;
  executionRoles: WorkflowContractRole[];
  preconditions: string[];
  steps: WorkflowAcceptanceStep[];
  fixtures: WorkflowAcceptanceFixture[];
  saves: WorkflowAcceptanceSave[];
  handoffs: WorkflowAcceptanceHandoff[];
  roleScenarios: WorkflowAcceptanceRoleScenario[];
  successResults: Array<{
    workflowId: string;
    route: string;
    message: string;
    visibleResult: string;
  }>;
  expectedDownloads: string[];
  requiresGeolocation: boolean;
  sourceAcceptanceCriteria: string[];
  sourceTestScenarios: string[];
};

export type NonBrowserWorkflowAcceptance = {
  workflowId: string;
  workflowName: string;
  trigger: "scheduled" | "system";
  reason: string;
  requiredSupportingEvidence: string[];
};

export type WorkflowAcceptancePlan = {
  version: typeof WORKFLOW_ACCEPTANCE_PLAN_VERSION;
  journeys: WorkflowAcceptanceJourney[];
  nonBrowserWorkflows: NonBrowserWorkflowAcceptance[];
  summary: {
    userActionWorkflows: number;
    journeys: number;
    contractSteps: number;
    saves: number;
    refreshChecks: number;
    handoffs: number;
    roleScenarios: number;
    downloads: number;
    geolocationJourneys: number;
    nonBrowserWorkflows: number;
  };
};

export type WorkflowAcceptancePlanValidation = {
  blockingIssues: string[];
  warnings: string[];
};

const ROLE_PRIORITY: WorkflowContractRole[] = [
  "owner",
  "editor",
  "viewer",
  "public",
];

export function synthesizeWorkflowAcceptancePlan(
  spec: AppSpec,
  architecture: ArchitecturePlan,
): WorkflowAcceptancePlan {
  const contracts = architecture.workflowContracts;
  const userActionContracts = contracts.filter(
    (contract) => contract.trigger === "user_action",
  );
  const contractById = new Map(contracts.map((contract) => [contract.id, contract]));
  const orderById = new Map(
    contracts.map((contract, index) => [contract.id, index]),
  );
  const entityDefinitions = new Map(
    spec.dataEntities.map((entity) => {
      const platform = platformEntityFromSpec(entity, spec);
      return [platform.key, platform] as const;
    }),
  );
  const appRoles = contractRolesFromSpec(spec);
  const deviceLocationRequired = architecture.platformServices.some(
    (service) => service.service === "device_location" && service.required,
  );

  const journeys = connectedWorkflowComponents(userActionContracts)
    .flatMap((component, componentIndex) => {
      const orderedComponent = topologicalContractOrder(component, orderById);
      const chunks = partitionJourneyContracts(orderedComponent);
      const journeyIds = chunks.map((chunk, chunkIndex) =>
        journeyIdForContracts(
          chunk,
          componentIndex,
          chunkIndex,
          chunks.length,
        ),
      );
      return chunks.map((chunk, chunkIndex) =>
        buildJourney({
          component: chunk,
          componentContracts: orderedComponent,
          journeyId: journeyIds[chunkIndex],
          fixtureScopeId: `component-${componentIndex + 1}`,
          sequence: chunkIndex + 1,
          dependsOnJourneyIds:
            chunkIndex === 0 ? [] : [journeyIds[chunkIndex - 1]],
          contractById,
          orderById,
          entityDefinitions,
          appRoles,
          deviceLocationRequired,
        }),
      );
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const nonBrowserWorkflows = contracts
    .filter(
      (contract): contract is WorkflowContract & {
        trigger: "scheduled" | "system";
      } => contract.trigger !== "user_action",
    )
    .map((contract) => ({
      workflowId: contract.id,
      workflowName: contract.name,
      trigger: contract.trigger,
      reason:
        contract.trigger === "scheduled"
          ? "The workflow is started by the platform scheduler rather than a browser action."
          : "The workflow is started automatically by the system rather than a browser action.",
      requiredSupportingEvidence: uniqueStrings([
        ...contract.source.acceptanceCriteria,
        ...contract.source.testScenarios,
        ...contract.steps.map((step) => step.visibleResult).filter(Boolean),
      ]),
    }));

  return {
    version: WORKFLOW_ACCEPTANCE_PLAN_VERSION,
    journeys,
    nonBrowserWorkflows,
    summary: {
      userActionWorkflows: userActionContracts.length,
      journeys: journeys.length,
      contractSteps: journeys.reduce(
        (total, journey) => total + journey.steps.length,
        0,
      ),
      saves: journeys.reduce((total, journey) => total + journey.saves.length, 0),
      refreshChecks: journeys.reduce(
        (total, journey) =>
          total + journey.saves.filter((save) => save.refreshRequired).length,
        0,
      ),
      handoffs: journeys.reduce(
        (total, journey) => total + journey.handoffs.length,
        0,
      ),
      roleScenarios: journeys.reduce(
        (total, journey) => total + journey.roleScenarios.length,
        0,
      ),
      downloads: journeys.reduce(
        (total, journey) => total + journey.expectedDownloads.length,
        0,
      ),
      geolocationJourneys: journeys.filter(
        (journey) => journey.requiresGeolocation,
      ).length,
      nonBrowserWorkflows: nonBrowserWorkflows.length,
    },
  };
}

export function validateWorkflowAcceptancePlan(
  architecture: ArchitecturePlan,
  plan: WorkflowAcceptancePlan,
): WorkflowAcceptancePlanValidation {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const userActionContracts = architecture.workflowContracts.filter(
    (contract) => contract.trigger === "user_action",
  );
  const plannedWorkflowIds = plan.journeys.flatMap(
    (journey) => journey.workflowIds,
  );

  for (const contract of userActionContracts) {
    const occurrences = plannedWorkflowIds.filter(
      (workflowId) => workflowId === contract.id,
    ).length;
    if (occurrences !== 1) {
      blockingIssues.push(
        `acceptance_plan: Workflow ${contract.id} must appear in exactly one browser journey; found ${occurrences}.`,
      );
    }
    const journey = plan.journeys.find((candidate) =>
      candidate.workflowIds.includes(contract.id),
    );
    if (!journey) continue;
    const coveredSteps = new Set(
      journey.steps
        .filter((step) => step.workflowId === contract.id)
        .map((step) => step.contractStepId),
    );
    const missingSteps = contract.steps.filter(
      (step) => !coveredSteps.has(step.id),
    );
    if (missingSteps.length > 0) {
      blockingIssues.push(
        `acceptance_plan: Workflow ${contract.id} is missing contract steps: ${missingSteps.map((step) => step.id).join(", ")}.`,
      );
    }
    const saveIds = new Set(
      journey.saves
        .filter((save) => save.workflowId === contract.id)
        .map((save) => `${save.stepId}|${save.entityKey}|${save.operation}`),
    );
    for (const save of contract.expectedSaves) {
      if (!saveIds.has(`${save.stepId}|${save.entityKey}|${save.operation}`)) {
        blockingIssues.push(
          `acceptance_plan: Workflow ${contract.id} is missing the ${save.operation} ${save.entityKey} save assertion from ${save.stepId}.`,
        );
      }
    }
  }

  const plannedHandoffIds = plan.journeys.flatMap((journey) =>
    journey.handoffs.map((handoff) => handoff.id),
  );
  const userActionWorkflowIds = new Set(
    userActionContracts.map((contract) => contract.id),
  );
  for (const contract of userActionContracts) {
    for (const handoff of contract.handoffs) {
      if (!userActionWorkflowIds.has(handoff.consumerWorkflowId)) continue;
      const occurrences = plannedHandoffIds.filter(
        (handoffId) => handoffId === handoff.id,
      ).length;
      if (occurrences !== 1) {
        blockingIssues.push(
          `acceptance_plan: Workflow ${contract.id} handoff ${handoff.id} must appear in exactly one consumer journey; found ${occurrences}.`,
        );
      }
    }
  }

  for (const journey of plan.journeys) {
    if (journey.workflowIds.length > WORKFLOW_ACCEPTANCE_MAX_WORKFLOWS_PER_JOURNEY) {
      blockingIssues.push(
        `acceptance_plan: Journey ${journey.id} exceeds the ${WORKFLOW_ACCEPTANCE_MAX_WORKFLOWS_PER_JOURNEY}-workflow limit.`,
      );
    }
    if (journey.steps.length > WORKFLOW_ACCEPTANCE_MAX_STEPS_PER_JOURNEY) {
      warnings.push(
        `acceptance_plan: Journey ${journey.id} has ${journey.steps.length} contract steps because one workflow could not be split safely; keep its browser test focused and use helper functions for repeated setup.`,
      );
    }
  }

  const classifiedNonBrowser = new Set(
    plan.nonBrowserWorkflows.map((workflow) => workflow.workflowId),
  );
  for (const contract of architecture.workflowContracts.filter(
    (candidate) => candidate.trigger !== "user_action",
  )) {
    if (!classifiedNonBrowser.has(contract.id)) {
      warnings.push(
        `acceptance_plan: Non-browser workflow ${contract.id} needs an explicit classification.`,
      );
    }
  }

  return {
    blockingIssues: uniqueStrings(blockingIssues),
    warnings: uniqueStrings(warnings),
  };
}

function buildJourney(input: {
  component: WorkflowContract[];
  componentContracts: WorkflowContract[];
  journeyId: string;
  fixtureScopeId: string;
  sequence: number;
  dependsOnJourneyIds: string[];
  contractById: Map<string, WorkflowContract>;
  orderById: Map<string, number>;
  entityDefinitions: Map<
    string,
    ReturnType<typeof platformEntityFromSpec>
  >;
  appRoles: WorkflowContractRole[];
  deviceLocationRequired: boolean;
}): WorkflowAcceptanceJourney {
  const contracts = topologicalContractOrder(
    input.component,
    input.orderById,
  );
  const journeyId = input.journeyId;
  const steps = contracts.flatMap((contract) => {
    const role = preferredRole(contract.actor.roles);
    const controls = new Map(
      contract.controls.map((control) => [control.id, control]),
    );
    return contract.steps.map((step) => {
      const control = controls.get(step.controlId);
      return {
        id: `${contract.id}:${step.id}`,
        workflowId: contract.id,
        workflowName: contract.name,
        contractStepId: step.id,
        role,
        kind: step.kind,
        description: step.description,
        route: step.route,
        controlId: step.controlId,
        controlKind: control?.kind ?? null,
        accessibleName: control?.accessibleName ?? "",
        reads: [...step.reads],
        writes: [...step.writes],
        visibleResult: step.visibleResult,
      } satisfies WorkflowAcceptanceStep;
    });
  });
  const requiredEntityFields = new Map<string, Set<string>>();
  for (const contract of contracts) {
    for (const required of contract.requiredData) {
      const fields = requiredEntityFields.get(required.entityKey) ?? new Set();
      required.requiredFieldKeys.forEach((field) => fields.add(field));
      requiredEntityFields.set(required.entityKey, fields);
    }
  }
  const fixtures = [...requiredEntityFields.entries()].flatMap(
    ([entityKey, requiredFieldKeys]) => {
      const entity = input.entityDefinitions.get(entityKey);
      if (!entity) return [];
      return entity.fields
        .filter(
          (field) => requiredFieldKeys.has(field.key) || field.required,
        )
        .map((field) => ({
          entityName: entity.name,
          entityKey,
          fieldKey: field.key,
          label: field.label,
          type: field.type,
          value: fixtureValue({
            journeyId: input.fixtureScopeId,
            entityKey,
            field,
          }),
          relationEntityKey: field.relation?.entityKey ?? null,
        }));
    },
  );
  const saves = contracts.flatMap((contract) =>
    contract.expectedSaves.map((save) => ({
      id: `${contract.id}:${save.stepId}:${save.operation}:${save.entityKey}`,
      workflowId: contract.id,
      workflowName: contract.name,
      stepId: save.stepId,
      operation: save.operation,
      entityName: save.entityName,
      entityKey: save.entityKey,
      fieldKeys: [...save.fieldKeys],
      storage: save.storage,
      producedReference: save.producedReference,
      refreshRequired: true as const,
    })),
  );
  const consumerWorkflowIds = new Set(contracts.map((contract) => contract.id));
  const handoffs = input.componentContracts.flatMap((contract) =>
    contract.handoffs.flatMap((handoff) => {
      if (!consumerWorkflowIds.has(handoff.consumerWorkflowId)) return [];
      const consumer = input.contractById.get(handoff.consumerWorkflowId);
      if (!consumer) return [];
      const consumerControl = consumer.controls.find(
        (control) => control.id === handoff.consumerControlId,
      );
      return [
        {
          id: handoff.id,
          producerWorkflowId: contract.id,
          producerWorkflowName: contract.name,
          fromStepId: handoff.fromStepId,
          produces: handoff.produces,
          storage: handoff.storage,
          consumerWorkflowId: handoff.consumerWorkflowId,
          consumerWorkflowName: consumer.name,
          consumerRoute: handoff.consumerRoute,
          consumerControlId: handoff.consumerControlId,
          consumerAccessibleName: consumerControl?.accessibleName ?? "",
          loadRule: handoff.loadRule,
        },
      ];
    }),
  );
  const downloadWorkflows = contracts
    .filter((contract) =>
      /\b(export|download|gpx|csv|pdf)\b/i.test(
        [
          contract.name,
          ...contract.steps.map((step) => step.description),
          ...contract.controls.map((control) => control.accessibleName),
          contract.success.visibleResult,
        ].join(" "),
      ),
    )
    .map((contract) => contract.id);
  const dedicatedReadOnlyContracts = input.componentContracts.filter(
    (contract) =>
      contract.expectedSaves.length === 0 &&
      contract.actor.roles.some(
        (role) => role === "viewer" || role === "public",
      ) &&
      contract.actor.roles.every(
        (role) => role === "viewer" || role === "public",
      ) &&
      contract.requiredData.every((data) =>
        data.operations.every((operation) => operation === "read"),
      ),
  );

  return {
    id: journeyId,
    name: contracts.map((contract) => contract.name).join(" -> "),
    sequence: input.sequence,
    dependsOnJourneyIds: [...input.dependsOnJourneyIds],
    workflowIds: contracts.map((contract) => contract.id),
    startRoute: contracts[0]?.start.route ?? "/",
    executionRoles: uniqueRoles(
      contracts.map((contract) => preferredRole(contract.actor.roles)),
    ),
    preconditions: uniqueStrings([
      ...contracts.flatMap((contract) => contract.start.preconditions),
      ...input.dependsOnJourneyIds.map(
        (dependency) =>
          `Run after ${dependency} in the same serial Playwright suite. Recreate any browser-local prerequisites through visible UI inside this test because Playwright tests do not share localStorage or sessionStorage.`,
      ),
    ]),
    steps,
    fixtures,
    saves,
    handoffs,
    roleScenarios: contracts.map((contract) => {
      const explicitReadOnlyRoles =
        contract.expectedSaves.length === 0 &&
        contract.actor.roles.every(
          (role) => role === "viewer" || role === "public",
        ) &&
        input.componentContracts.some(
          (mutableContract) =>
            mutableContract.expectedSaves.length > 0 &&
            contract.actor.roles.some((role) =>
              readOnlyContractCoversContract(
                contract,
                mutableContract,
                role,
              ),
            ),
        )
          ? contract.actor.roles.filter(
              (role) => role === "viewer" || role === "public",
            )
          : [];
      const fallbackReadOnlyRoles =
        contract.expectedSaves.length > 0
          ? input.appRoles.filter(
              (role) =>
                (role === "viewer" || role === "public") &&
                !contract.actor.roles.includes(role) &&
                !dedicatedReadOnlyContracts.some((readOnlyContract) =>
                  readOnlyContractCoversContract(
                    readOnlyContract,
                    contract,
                    role,
                  ),
                ),
            )
          : [];
      return {
        workflowId: contract.id,
        workflowName: contract.name,
        allowedRoles: [...contract.actor.roles],
        visibleControlNames: uniqueStrings(
          contract.controls.map((control) => control.accessibleName),
        ),
        readOnlyRoles: uniqueRoles([
          ...explicitReadOnlyRoles,
          ...fallbackReadOnlyRoles,
        ]),
      };
    }),
    successResults: contracts.map((contract) => ({
      workflowId: contract.id,
      route: contract.success.route,
      message: contract.success.message,
      visibleResult: contract.success.visibleResult,
    })),
    expectedDownloads: uniqueStrings(downloadWorkflows),
    requiresGeolocation: contracts.some(
      (contract) =>
        (input.deviceLocationRequired &&
          contract.dependencies.platformServices.includes("device_location")) ||
        /\b(gps|geolocation|current location|device location)\b/i.test(
          [
            contract.name,
            ...contract.steps.map((step) => step.description),
          ].join(" "),
        ),
    ),
    sourceAcceptanceCriteria: uniqueStrings(
      contracts.flatMap((contract) => contract.source.acceptanceCriteria),
    ),
    sourceTestScenarios: uniqueStrings(
      contracts.flatMap((contract) => contract.source.testScenarios),
    ),
  };
}

function readOnlyContractCoversContract(
  readOnlyContract: WorkflowContract,
  mutableContract: WorkflowContract,
  role: WorkflowContractRole,
): boolean {
  if (!readOnlyContract.actor.roles.includes(role)) return false;
  const readOnlyEntities = new Set(
    readOnlyContract.requiredData.map((data) => data.entityKey),
  );
  const mutableEntities = mutableContract.requiredData.map(
    (data) => data.entityKey,
  );
  const sharesEntity = mutableEntities.some((entityKey) =>
    readOnlyEntities.has(entityKey),
  );
  const sharesRoute = [
    readOnlyContract.start.route,
    ...readOnlyContract.controls.map((control) => control.route),
  ].some((route) =>
    [
      mutableContract.start.route,
      ...mutableContract.controls.map((control) => control.route),
    ].includes(route),
  );
  return sharesEntity || sharesRoute;
}

function connectedWorkflowComponents(
  contracts: WorkflowContract[],
): WorkflowContract[][] {
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  const neighbors = new Map(
    contracts.map((contract) => [contract.id, new Set<string>()]),
  );
  for (const contract of contracts) {
    const linkedIds = [
      ...contract.dependencies.workflowIds,
      ...contract.handoffs.map((handoff) => handoff.consumerWorkflowId),
    ];
    for (const linkedId of linkedIds) {
      if (!byId.has(linkedId)) continue;
      neighbors.get(contract.id)?.add(linkedId);
      neighbors.get(linkedId)?.add(contract.id);
    }
  }

  const visited = new Set<string>();
  const components: WorkflowContract[][] = [];
  for (const contract of contracts) {
    if (visited.has(contract.id)) continue;
    const component: WorkflowContract[] = [];
    const queue = [contract.id];
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const current = byId.get(id);
      if (current) component.push(current);
      for (const neighbor of neighbors.get(id) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}

function partitionJourneyContracts(
  contracts: WorkflowContract[],
): WorkflowContract[][] {
  const chunks: WorkflowContract[][] = [];
  let current: WorkflowContract[] = [];
  let currentSteps = 0;
  for (const contract of contracts) {
    const wouldExceedWorkflowLimit =
      current.length >= WORKFLOW_ACCEPTANCE_MAX_WORKFLOWS_PER_JOURNEY;
    const wouldExceedStepLimit =
      current.length > 0 &&
      currentSteps + contract.steps.length >
        WORKFLOW_ACCEPTANCE_MAX_STEPS_PER_JOURNEY;
    if (wouldExceedWorkflowLimit || wouldExceedStepLimit) {
      chunks.push(current);
      current = [];
      currentSteps = 0;
    }
    current.push(contract);
    currentSteps += contract.steps.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function journeyIdForContracts(
  contracts: WorkflowContract[],
  componentIndex: number,
  chunkIndex: number,
  chunkCount: number,
): string {
  const workflowSlug = contracts.map((contract) => contract.id).join("-to-");
  return chunkCount === 1
    ? `journey-${workflowSlug}`
    : `journey-${componentIndex + 1}-${chunkIndex + 1}-${workflowSlug}`;
}

function topologicalContractOrder(
  contracts: WorkflowContract[],
  orderById: Map<string, number>,
): WorkflowContract[] {
  const ids = new Set(contracts.map((contract) => contract.id));
  const indegree = new Map(contracts.map((contract) => [contract.id, 0]));
  const outgoing = new Map(
    contracts.map((contract) => [contract.id, new Set<string>()]),
  );
  for (const contract of contracts) {
    for (const dependency of contract.dependencies.workflowIds) {
      if (!ids.has(dependency)) continue;
      outgoing.get(dependency)?.add(contract.id);
      indegree.set(contract.id, (indegree.get(contract.id) ?? 0) + 1);
    }
    for (const handoff of contract.handoffs) {
      if (!ids.has(handoff.consumerWorkflowId)) continue;
      if (!outgoing.get(contract.id)?.has(handoff.consumerWorkflowId)) {
        outgoing.get(contract.id)?.add(handoff.consumerWorkflowId);
        indegree.set(
          handoff.consumerWorkflowId,
          (indegree.get(handoff.consumerWorkflowId) ?? 0) + 1,
        );
      }
    }
  }
  const ready = contracts
    .filter((contract) => indegree.get(contract.id) === 0)
    .sort((left, right) => originalOrder(left.id, right.id, orderById));
  const ordered: WorkflowContract[] = [];
  while (ready.length > 0) {
    const contract = ready.shift();
    if (!contract) break;
    ordered.push(contract);
    for (const nextId of outgoing.get(contract.id) ?? []) {
      indegree.set(nextId, (indegree.get(nextId) ?? 1) - 1);
      if (indegree.get(nextId) === 0) {
        const next = contracts.find((candidate) => candidate.id === nextId);
        if (next) {
          ready.push(next);
          ready.sort((left, right) =>
            originalOrder(left.id, right.id, orderById),
          );
        }
      }
    }
  }
  if (ordered.length !== contracts.length) {
    return [...contracts].sort((left, right) =>
      originalOrder(left.id, right.id, orderById),
    );
  }
  return ordered;
}

function originalOrder(
  left: string,
  right: string,
  orderById: Map<string, number>,
): number {
  return (orderById.get(left) ?? 0) - (orderById.get(right) ?? 0);
}

function preferredRole(roles: readonly WorkflowContractRole[]): WorkflowContractRole {
  return ROLE_PRIORITY.find((role) => roles.includes(role)) ?? roles[0] ?? "public";
}

function uniqueRoles(
  roles: readonly WorkflowContractRole[],
): WorkflowContractRole[] {
  return ROLE_PRIORITY.filter((role) => roles.includes(role));
}

function contractRolesFromSpec(spec: AppSpec): WorkflowContractRole[] {
  const roles = spec.userRoles.flatMap((role) => {
    const normalized = role.name.toLowerCase();
    if (normalized.includes("owner") || normalized.includes("admin")) {
      return ["owner" as const];
    }
    if (normalized.includes("editor") || normalized.includes("member")) {
      return ["editor" as const];
    }
    if (normalized.includes("viewer") || normalized.includes("read")) {
      return ["viewer" as const];
    }
    if (normalized.includes("public") || normalized.includes("guest")) {
      return ["public" as const];
    }
    return [];
  });
  if (spec.sharingModel === "public") roles.push("public");
  return uniqueRoles(roles.length > 0 ? roles : ["owner"]);
}

function fixtureValue(input: {
  journeyId: string;
  entityKey: string;
  field: ReturnType<typeof platformEntityFromSpec>["fields"][number];
}): unknown {
  const label = `VF ${humanize(input.entityKey)} ${humanize(input.field.key)}`;
  switch (input.field.type) {
    case "number":
      return 7;
    case "boolean":
      return true;
    case "date":
      return "2030-06-15";
    case "datetime":
      return "2030-06-15T09:30";
    case "select":
      return input.field.options[0] ?? "planned";
    case "multi_select":
      return [input.field.options[0] ?? "planned"];
    case "relation":
      return `@${input.field.relation?.entityKey ?? "record"}.id`;
    case "image":
    case "file":
      return "voiceforge-stage-14d.png";
    case "json":
      return { source: "stage-14d", journey: input.journeyId };
    case "long_text":
      return `${label} acceptance details`;
    case "text":
    default:
      return `${label} acceptance`;
  }
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
