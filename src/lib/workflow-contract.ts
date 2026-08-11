import { z } from "zod";
import { normalizeEntityKey } from "./platform/data";
import { platformEntityFromSpec } from "./platform/spec-seeding";
import {
  isExternalIntegrationRequirement,
  type AppSpec,
} from "./spec";

export const WORKFLOW_CONTRACT_VERSION = 1 as const;

export const workflowContractRoleSchema = z.enum([
  "owner",
  "editor",
  "viewer",
  "public",
]);

export const workflowControlKindSchema = z.enum([
  "button",
  "link",
  "form",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "date",
  "file",
  "drag_drop",
  "menu",
]);

export const workflowPlatformServiceSchema = z.enum([
  "ai",
  "data",
  "users",
  "files",
  "email",
  "jobs",
  "integrations",
  "search",
  "reports",
  "device_location",
]);

const workflowDataOperationSchema = z.enum([
  "create",
  "read",
  "update",
  "delete",
]);

const workflowStepSchema = z.object({
  id: z.string().min(1).describe("Stable step id within the workflow"),
  description: z.string().min(1).describe("Plain-language user action or event"),
  kind: z
    .enum(["navigate", "input", "action", "save", "result", "automatic"])
    .describe("What kind of step this is"),
  route: z.string().min(1).describe("App route where this step happens"),
  controlId: z
    .string()
    .describe("Related visible control id, or an empty string for automatic steps"),
  reads: z.array(z.string()).describe("Exact entity keys read by this step"),
  writes: z.array(z.string()).describe("Exact entity keys written by this step"),
  visibleResult: z
    .string()
    .describe("What the user sees after this step, or an empty string"),
});

export const workflowContractSchema = z.object({
  id: z.string().min(1).describe("Stable workflow id"),
  name: z.string().min(1).describe("Friendly workflow name"),
  actor: z.object({
    persona: z.string().min(1).describe("Friendly actor name, such as Rider"),
    roles: z
      .array(workflowContractRoleSchema)
      .min(1)
      .describe("VoiceForge access roles allowed to complete the workflow"),
  }),
  trigger: z
    .enum(["user_action", "scheduled", "system"])
    .describe("What starts the workflow"),
  start: z.object({
    route: z.string().min(1).describe("Exact starting route"),
    screen: z.string().min(1).describe("Friendly starting screen name"),
    preconditions: z
      .array(z.string())
      .describe("Sign-in, permissions, or saved records required before starting"),
  }),
  controls: z
    .array(
      z.object({
        id: z.string().min(1).describe("Stable control id"),
        kind: workflowControlKindSchema,
        accessibleName: z
          .string()
          .min(1)
          .describe("Visible or accessible control label"),
        route: z.string().min(1).describe("Route where the control is visible"),
        roles: z
          .array(workflowContractRoleSchema)
          .min(1)
          .describe("Roles that can use this control"),
        action: z.string().min(1).describe("Outcome of using the control"),
      }),
    )
    .describe("Visible controls that make the workflow discoverable"),
  steps: z.array(workflowStepSchema).min(1).describe("Ordered workflow steps"),
  requiredData: z
    .array(
      z.object({
        entityName: z.string().min(1).describe("Friendly entity name"),
        entityKey: z.string().min(1).describe("Exact platform entity key"),
        operations: z
          .array(workflowDataOperationSchema)
          .min(1)
          .describe("Data operations required by the workflow"),
        requiredFieldKeys: z
          .array(z.string())
          .describe("Exact field keys needed by the workflow"),
      }),
    )
    .describe("Saved entities read or changed by the workflow"),
  expectedSaves: z
    .array(
      z.object({
        stepId: z.string().min(1).describe("Step responsible for persistence"),
        operation: z.enum(["create", "update", "delete"]),
        entityName: z.string().min(1),
        entityKey: z.string().min(1),
        fieldKeys: z.array(z.string()),
        storage: z.enum(["localStorage", "platformData", "platformFiles"]),
        producedReference: z
          .string()
          .describe("Stable record/file reference made available downstream"),
      }),
    )
    .describe("Records or files that must persist when the workflow succeeds"),
  success: z.object({
    message: z.string().describe("Success message, or an empty string"),
    visibleResult: z.string().min(1).describe("Visible proof of success"),
    route: z.string().min(1).describe("Route where success is visible"),
  }),
  failureStates: z
    .array(z.string())
    .describe("Expected validation, empty, permission, or service failures"),
  handoffs: z
    .array(
      z.object({
        id: z.string().min(1).describe("Stable handoff id"),
        fromStepId: z.string().min(1),
        produces: z.string().min(1).describe("Record or value produced"),
        storage: z.enum(["localStorage", "platformData", "platformFiles"]),
        consumerWorkflowId: z.string().min(1),
        consumerRoute: z.string().min(1),
        consumerControlId: z.string().describe("First consuming control, if any"),
        loadRule: z.string().min(1).describe("How the consumer reloads the value"),
      }),
    )
    .describe("Persistent outputs consumed by later workflows"),
  dependencies: z.object({
    workflowIds: z.array(z.string()).describe("Prerequisite workflow ids"),
    platformServices: z
      .array(workflowPlatformServiceSchema)
      .describe("Required locked platform services"),
  }),
  source: z.object({
    workflowName: z.string().min(1),
    acceptanceCriteria: z.array(z.string()),
    testScenarios: z.array(z.string()),
  }),
});

export type WorkflowContract = z.infer<typeof workflowContractSchema>;
export type WorkflowContractRole = z.infer<typeof workflowContractRoleSchema>;

export type WorkflowContractArchitecture = {
  pageMap: Array<{
    route: string;
    name: string;
    purpose: string;
    workflows: string[];
  }>;
  dataModel: Array<{
    name: string;
    storage: "localStorage" | "platformData" | "none" | "future";
  }>;
  platformServices: Array<{
    service: z.infer<typeof workflowPlatformServiceSchema>;
    required: boolean;
    availability: "available" | "not_available" | "later";
  }>;
  workflowContractVersion?: number;
  workflowContracts?: WorkflowContract[];
};

export type WorkflowContractValidation = {
  blockingIssues: string[];
  warnings: string[];
  stats: WorkflowContractStats;
};

export type WorkflowContractStats = {
  workflows: number;
  steps: number;
  controls: number;
  savedRecordTransitions: number;
  handoffs: number;
};

const WRITE_OPERATIONS = new Set(["create", "update", "delete"]);
const VAGUE_CONTROL_LABELS = new Set([
  "continue",
  "go",
  "ok",
  "save",
  "submit",
]);
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "at",
  "by",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "user",
  "with",
]);

export function ensureWorkflowContracts<T extends WorkflowContractArchitecture>(
  spec: AppSpec,
  architecture: T,
): Omit<T, "workflowContractVersion" | "workflowContracts"> & {
  workflowContractVersion: typeof WORKFLOW_CONTRACT_VERSION;
  workflowContracts: WorkflowContract[];
} {
  const supplied = architecture.workflowContracts ?? [];
  const contracts =
    architecture.workflowContractVersion === WORKFLOW_CONTRACT_VERSION &&
    supplied.length > 0
      ? supplied.map((contract) => normalizeSuppliedContract(contract, spec))
      : compileWorkflowContracts(spec, architecture);
  const interactionSafeContracts = contracts.map((contract) =>
    normalizeContractInteractionSemantics(contract, architecture),
  );

  return {
    ...architecture,
    workflowContractVersion: WORKFLOW_CONTRACT_VERSION,
    workflowContracts: assignSourcesAndHandoffs(interactionSafeContracts, spec),
  };
}

export function compileWorkflowContracts(
  spec: AppSpec,
  architecture: WorkflowContractArchitecture,
): WorkflowContract[] {
  const contracts = spec.workflows.map((workflow, workflowIndex) => {
    const id = uniqueWorkflowId(workflow.name, workflowIndex);
    const route = selectStartingPage(workflow, architecture.pageMap);
    const operations = inferOperations(workflow);
    const requiredData = inferRequiredData(spec, architecture, workflow, operations);
    const roles = inferRoles(spec, workflow.actor, operations);
    const controls = inferControls(id, route.route, roles, workflow.steps);
    const storageByEntity = new Map(
      architecture.dataModel.map((entity) => [
        normalizeEntityKey(entity.name),
        entity.storage,
      ]),
    );
    const saveOperation = operations.find((operation) =>
      WRITE_OPERATIONS.has(operation),
    ) as "create" | "update" | "delete" | undefined;
    const saveStepId = `${id}-step-${Math.max(1, workflow.steps.length)}`;
    const expectedSaves = saveOperation
      ? requiredData
          .filter((entity) => entity.operations.includes(saveOperation))
          .map((entity) => ({
          stepId: saveStepId,
          operation: saveOperation,
          entityName: entity.entityName,
          entityKey: entity.entityKey,
          fieldKeys: entity.requiredFieldKeys,
          storage: persistentStorage(
            storageByEntity.get(entity.entityKey),
            spec.sharingModel,
          ),
          producedReference: `${entity.entityKey}.id`,
          }))
      : [];
    const writeKeys = expectedSaves.map((save) => save.entityKey);
    const readKeys = requiredData.map((entity) => entity.entityKey);
    const steps = workflow.steps.map((description, stepIndex) => {
      const control = controls[stepIndex] ?? controls.at(-1);
      const isLast = stepIndex === workflow.steps.length - 1;
      const kind = inferStepKind(description, isLast && expectedSaves.length > 0);
      return {
        id: `${id}-step-${stepIndex + 1}`,
        description,
        kind,
        route: route.route,
        controlId: kind === "result" || kind === "automatic" ? "" : control?.id ?? "",
        reads: kind === "navigate" ? [] : readKeys,
        writes: kind === "save" ? writeKeys : [],
        visibleResult: isLast ? workflow.successOutcome : "",
      } satisfies WorkflowContract["steps"][number];
    });
    if (steps.length === 0) {
      steps.push({
        id: `${id}-step-1`,
        description: workflow.name,
        kind: expectedSaves.length > 0 ? "save" : "action",
        route: route.route,
        controlId: controls[0]?.id ?? "",
        reads: readKeys,
        writes: writeKeys,
        visibleResult: workflow.successOutcome,
      });
    } else if (expectedSaves.length > 0 && !steps.some((step) => step.kind === "save")) {
      steps[steps.length - 1] = {
        ...steps[steps.length - 1],
        kind: "save",
        writes: writeKeys,
      };
    }
    for (const save of expectedSaves) {
      save.stepId = steps.findLast((step) => step.kind === "save")?.id ?? steps.at(-1)!.id;
    }

    return {
      id,
      name: workflow.name,
      actor: {
        persona: workflow.actor || "User",
        roles,
      },
      trigger: inferTrigger(workflow.trigger),
      start: {
        route: route.route,
        screen: route.name,
        preconditions: inferPreconditions(spec, roles),
      },
      controls,
      steps,
      requiredData,
      expectedSaves,
      success: {
        message: successMessage(workflow.successOutcome),
        visibleResult: workflow.successOutcome,
        route: route.route,
      },
      failureStates: workflow.failureStates,
      handoffs: [],
      dependencies: {
        workflowIds: [],
        platformServices: inferPlatformServices(
          workflow,
          requiredData,
          architecture,
          spec,
        ),
      },
      source: {
        workflowName: workflow.name,
        acceptanceCriteria: [],
        testScenarios: [],
      },
    } satisfies WorkflowContract;
  });

  return assignSourcesAndHandoffs(contracts, spec);
}

export function validateWorkflowContracts(
  spec: AppSpec,
  architecture: WorkflowContractArchitecture,
): WorkflowContractValidation {
  const contracts = architecture.workflowContracts ?? [];
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const routeSet = new Set(architecture.pageMap.map((page) => page.route));
  const workflowIds = new Set(contracts.map((contract) => contract.id));
  const contractNames = new Set(contracts.map((contract) => normalizeText(contract.name)));
  const sourceWorkflows = new Map(
    spec.workflows.map((workflow) => [normalizeText(workflow.name), workflow]),
  );
  const entityDefinitions = new Map(
    spec.dataEntities.map((entity) => {
      const platform = platformEntityFromSpec(entity, spec);
      return [platform.key, platform] as const;
    }),
  );

  const duplicateIds = duplicates(contracts.map((contract) => contract.id));
  if (duplicateIds.length > 0) {
    blockingIssues.push(
      `workflow_contract: Duplicate workflow ids: ${duplicateIds.join(", ")}.`,
    );
  }

  const missingWorkflows = spec.workflows.filter(
    (workflow) => !contractNames.has(normalizeText(workflow.name)),
  );
  if (missingWorkflows.length > 0) {
    blockingIssues.push(
      `workflow_contract: Missing contracts for promised workflows: ${missingWorkflows
        .map((workflow) => workflow.name)
        .join(", ")}.`,
    );
  }
  if (contracts.length !== spec.workflows.length) {
    blockingIssues.push(
      `workflow_contract: Expected ${spec.workflows.length} workflow contract(s), but found ${contracts.length}.`,
    );
  }

  for (const contract of contracts) {
    const label = `workflow_contract: ${contract.name}`;
    if (!routeSet.has(contract.start.route)) {
      blockingIssues.push(`${label} starts on unknown route ${contract.start.route}.`);
    }
    if (!routeSet.has(contract.success.route)) {
      blockingIssues.push(`${label} finishes on unknown route ${contract.success.route}.`);
    }
    if (contract.trigger === "user_action" && contract.controls.length === 0) {
      blockingIssues.push(`${label} has no visible controls.`);
    }

    const controlIds = new Set(contract.controls.map((control) => control.id));
    const duplicateControlIds = duplicates(
      contract.controls.map((control) => control.id),
    );
    if (duplicateControlIds.length > 0) {
      blockingIssues.push(
        `${label} has duplicate control ids: ${duplicateControlIds.join(", ")}.`,
      );
    }
    for (const control of contract.controls) {
      if (!routeSet.has(control.route)) {
        blockingIssues.push(`${label} has a control on unknown route ${control.route}.`);
      }
      if (VAGUE_CONTROL_LABELS.has(normalizeText(control.accessibleName))) {
        blockingIssues.push(
          `${label} uses the vague control label "${control.accessibleName}"; name the action clearly.`,
        );
      }
    }

    const stepIds = new Set(contract.steps.map((step) => step.id));
    const duplicateStepIds = duplicates(contract.steps.map((step) => step.id));
    if (duplicateStepIds.length > 0) {
      blockingIssues.push(
        `${label} has duplicate step ids: ${duplicateStepIds.join(", ")}.`,
      );
    }
    for (const step of contract.steps) {
      if (!routeSet.has(step.route)) {
        blockingIssues.push(`${label} has a step on unknown route ${step.route}.`);
      }
      if (step.controlId && !controlIds.has(step.controlId)) {
        blockingIssues.push(
          `${label} step ${step.id} references unknown control ${step.controlId}.`,
        );
      }
    }

    const requiredEntities = new Set(
      contract.requiredData.map((entity) => entity.entityKey),
    );
    for (const data of contract.requiredData) {
      const entity = entityDefinitions.get(data.entityKey);
      if (!entity) {
        blockingIssues.push(`${label} references unknown entity ${data.entityKey}.`);
        continue;
      }
      const knownFields = new Set(entity.fields.map((field) => field.key));
      const unknownFields = data.requiredFieldKeys.filter(
        (field) => !knownFields.has(field),
      );
      if (unknownFields.length > 0) {
        blockingIssues.push(
          `${label} references unknown ${data.entityKey} fields: ${unknownFields.join(", ")}.`,
        );
      }
    }

    for (const save of contract.expectedSaves) {
      if (!stepIds.has(save.stepId)) {
        blockingIssues.push(`${label} saves from unknown step ${save.stepId}.`);
      }
      if (!requiredEntities.has(save.entityKey)) {
        blockingIssues.push(
          `${label} saves ${save.entityKey} without listing it as required data.`,
        );
      }
      const dataRequirement = contract.requiredData.find(
        (data) => data.entityKey === save.entityKey,
      );
      if (!dataRequirement?.operations.includes(save.operation)) {
        blockingIssues.push(
          `${label} saves ${save.entityKey} with ${save.operation}, but that operation is missing from required data.`,
        );
      }
      const entity = entityDefinitions.get(save.entityKey);
      const knownFields = new Set(entity?.fields.map((field) => field.key) ?? []);
      const unknownSaveFields = save.fieldKeys.filter(
        (field) => !knownFields.has(field),
      );
      if (unknownSaveFields.length > 0) {
        blockingIssues.push(
          `${label} saves unknown ${save.entityKey} fields: ${unknownSaveFields.join(", ")}.`,
        );
      }
      const saveStep = contract.steps.find((step) => step.id === save.stepId);
      if (saveStep && !saveStep.writes.includes(save.entityKey)) {
        blockingIssues.push(
          `${label} save step ${save.stepId} does not declare a write to ${save.entityKey}.`,
        );
      }
      if (!canAnyRoleWrite(spec, contract.actor.roles)) {
        blockingIssues.push(
          `${label} promises a save, but its roles do not have write access.`,
        );
      }
    }

    const sourceWorkflow = sourceWorkflows.get(normalizeText(contract.name));
    if (
      contractPromisesPersistence(contract, sourceWorkflow) &&
      spec.dataEntities.length > 0 &&
      contract.expectedSaves.length === 0
    ) {
      blockingIssues.push(
        `${label} promises saved or changed information but defines no persistent record transition.`,
      );
    }

    for (const dependency of contract.dependencies.workflowIds) {
      if (!workflowIds.has(dependency)) {
        blockingIssues.push(
          `${label} depends on unknown workflow ${dependency}.`,
        );
      }
    }
    for (const handoff of contract.handoffs) {
      if (!stepIds.has(handoff.fromStepId)) {
        blockingIssues.push(
          `${label} handoff ${handoff.id} starts from unknown step ${handoff.fromStepId}.`,
        );
      }
      if (!workflowIds.has(handoff.consumerWorkflowId)) {
        blockingIssues.push(
          `${label} handoff ${handoff.id} targets unknown workflow ${handoff.consumerWorkflowId}.`,
        );
      }
      if (!routeSet.has(handoff.consumerRoute)) {
        blockingIssues.push(
          `${label} handoff ${handoff.id} targets unknown route ${handoff.consumerRoute}.`,
        );
      }
      if (
        !contract.expectedSaves.some(
          (save) => save.producedReference === handoff.produces,
        )
      ) {
        blockingIssues.push(
          `${label} handoff ${handoff.id} does not come from an expected saved reference.`,
        );
      }
      const consumer = contracts.find(
        (candidate) => candidate.id === handoff.consumerWorkflowId,
      );
      const producedEntityKey = handoff.produces.split(".", 1)[0];
      if (
        consumer &&
        !consumer.requiredData.some(
          (data) => data.entityKey === producedEntityKey,
        )
      ) {
        blockingIssues.push(
          `${label} handoff ${handoff.id} targets a workflow that does not load ${producedEntityKey}.`,
        );
      }
    }
  }

  const mappedCriteria = new Set(
    contracts.flatMap((contract) => contract.source.acceptanceCriteria),
  );
  const unmappedCriteria = spec.acceptanceCriteria
    .map((criterion) => criterion.name)
    .filter((name) => !mappedCriteria.has(name));
  if (unmappedCriteria.length > 0) {
    blockingIssues.push(
      `workflow_contract: Acceptance criteria are not mapped to workflows: ${unmappedCriteria.join(", ")}.`,
    );
  }
  const mappedTests = new Set(
    contracts.flatMap((contract) => contract.source.testScenarios),
  );
  const unmappedTests = spec.testScenarios
    .map((scenario) => scenario.name)
    .filter((name) => !mappedTests.has(name));
  if (unmappedTests.length > 0) {
    blockingIssues.push(
      `workflow_contract: Test scenarios are not mapped to workflows: ${unmappedTests.join(", ")}.`,
    );
  }

  const knownServices = new Set(
    architecture.platformServices
      .filter((service) => service.availability === "available")
      .map((service) => service.service),
  );
  for (const contract of contracts) {
    const unavailable = contract.dependencies.platformServices.filter(
      (service) => !knownServices.has(service),
    );
    if (unavailable.length > 0) {
      warnings.push(
        `workflow_contract: ${contract.name} references services not marked available in the architecture: ${unavailable.join(", ")}.`,
      );
    }
  }

  return {
    blockingIssues: uniqueStrings(blockingIssues),
    warnings: uniqueStrings(warnings),
    stats: workflowContractStats(contracts),
  };
}

export function workflowContractStats(
  contracts: readonly WorkflowContract[],
): WorkflowContractStats {
  return {
    workflows: contracts.length,
    steps: contracts.reduce((sum, contract) => sum + contract.steps.length, 0),
    controls: contracts.reduce(
      (sum, contract) => sum + contract.controls.length,
      0,
    ),
    savedRecordTransitions: contracts.reduce(
      (sum, contract) => sum + contract.expectedSaves.length,
      0,
    ),
    handoffs: contracts.reduce(
      (sum, contract) => sum + contract.handoffs.length,
      0,
    ),
  };
}

function normalizeSuppliedContract(
  contract: WorkflowContract,
  spec: AppSpec,
): WorkflowContract {
  const platformEntities = spec.dataEntities.map((entity) =>
    platformEntityFromSpec(entity, spec),
  );
  const entities = new Map(
    platformEntities.flatMap((platform) => {
      return [
        [normalizeText(platform.name), platform],
        [normalizeText(platform.key), platform],
      ] as const;
    }),
  );
  const resolvePlatformEntity = (value: string) => {
    const exact = entities.get(normalizeText(value));
    if (exact) return exact;
    const scored = platformEntities
      .map((platform) => ({
        platform,
        score: overlapScore(value, `${platform.name} ${platform.key}`),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    if (
      scored.length === 0 ||
      (scored[1] && scored[1].score === scored[0].score)
    ) {
      return undefined;
    }
    return scored[0].platform;
  };
  const normalizeEntity = (name: string, key: string) => {
    const platform =
      resolvePlatformEntity(key) ?? resolvePlatformEntity(name);
    return platform
      ? { entityName: platform.name, entityKey: platform.key }
      : { entityName: name, entityKey: normalizeEntityKey(key || name) };
  };
  const normalizeEntityReference = (value: string) =>
    resolvePlatformEntity(value)?.key ?? normalizeEntityKey(value);
  const synthesizedDiscoverabilityControl =
    contract.controls.length === 0 && contract.trigger === "user_action";
  const suppliedControls = synthesizedDiscoverabilityControl
    ? [createDiscoverabilityControl(contract)]
    : contract.controls;
  const requiredData = contract.requiredData.map((data) => {
    const entity = normalizeEntity(data.entityName, data.entityKey);
    const platform = entities.get(normalizeText(entity.entityKey));
    const fields = new Set(platform?.fields.map((field) => field.key) ?? []);
    return {
      ...data,
      ...entity,
      requiredFieldKeys: data.requiredFieldKeys.map((field) => {
        const key = normalizeEntityKey(field);
        return fields.has(key) ? key : field;
      }),
    };
  });
  const controlIdMap = new Map(
    suppliedControls.map((control, index) => [
      control.id,
      slugify(control.id || `${contract.id}-control-${index + 1}`),
    ]),
  );
  const stepIdMap = new Map(
    contract.steps.map((step, index) => [
      step.id,
      slugify(step.id || `${contract.id}-step-${index + 1}`),
    ]),
  );
  const expectedSaves = contract.expectedSaves.map((save) => {
    const entity = normalizeEntity(save.entityName, save.entityKey);
    const platform = entities.get(normalizeText(entity.entityKey));
    const fields = new Set(platform?.fields.map((field) => field.key) ?? []);
    return {
      ...save,
      ...entity,
      stepId: stepIdMap.get(save.stepId) ?? slugify(save.stepId),
      fieldKeys: save.fieldKeys.map((field) => {
        const key = normalizeEntityKey(field);
        return fields.has(key) ? key : field;
      }),
      producedReference: `${entity.entityKey}.id`,
    };
  });
  const producedReferenceMap = new Map(
    contract.expectedSaves.map((save, index) => [
      save.producedReference,
      expectedSaves[index]?.producedReference ?? save.producedReference,
    ]),
  );
  const normalizedHandoffs = contract.handoffs.map((handoff) => ({
    ...handoff,
    id: slugify(handoff.id),
    fromStepId:
      stepIdMap.get(handoff.fromStepId) ?? slugify(handoff.fromStepId),
    produces:
      producedReferenceMap.get(handoff.produces) ??
      `${normalizeEntityReference(handoff.produces)}.id`,
    consumerWorkflowId: slugify(handoff.consumerWorkflowId),
    consumerControlId: handoff.consumerControlId
      ? slugify(handoff.consumerControlId)
      : "",
  }));

  return {
    ...contract,
    id: slugify(contract.id || contract.name),
    actor: {
      ...contract.actor,
      roles: unique(contract.actor.roles),
    },
    controls: suppliedControls.map((control, index) => ({
      ...control,
      id:
        controlIdMap.get(control.id) ??
        slugify(`${contract.id}-control-${index + 1}`),
      roles: unique(control.roles),
    })),
    steps: contract.steps.map((step, index) => ({
      ...step,
      id:
        stepIdMap.get(step.id) ?? slugify(`${contract.id}-step-${index + 1}`),
      controlId: synthesizedDiscoverabilityControl
        ? step.kind === "automatic" || step.kind === "result"
          ? ""
          : (controlIdMap.get(suppliedControls[0]?.id ?? "") ?? "")
        : step.controlId
          ? (controlIdMap.get(step.controlId) ?? slugify(step.controlId))
          : "",
      reads: unique(step.reads.map(normalizeEntityReference)),
      writes: unique(step.writes.map(normalizeEntityReference)),
    })),
    requiredData,
    expectedSaves,
    failureStates: uniqueStrings(contract.failureStates),
    handoffs: uniqueBy(
      normalizedHandoffs,
      (handoff) =>
        `${handoff.produces}|${handoff.consumerWorkflowId}`,
    ),
    dependencies: {
      workflowIds: unique(contract.dependencies.workflowIds.map(slugify)),
      platformServices: unique(contract.dependencies.platformServices).filter(
        (service) =>
          service !== "integrations" ||
          spec.integrations.some(isExternalIntegrationRequirement),
      ),
    },
  };
}

function normalizeContractInteractionSemantics(
  contract: WorkflowContract,
  architecture: WorkflowContractArchitecture,
): WorkflowContract {
  let steps = contract.steps.map((step) => {
    const kind = normalizedStepKind(step);
    return {
      ...step,
      kind,
      controlId:
        kind === "automatic" || kind === "result" ? "" : step.controlId,
    };
  });
  const actionableControlIds = new Set(
    steps.map((step) => step.controlId).filter(Boolean),
  );
  let controls = contract.controls
    .filter(
      (control) =>
        actionableControlIds.has(control.id) ||
        isUserGestureDescription(control.accessibleName) ||
        isUserGestureDescription(control.action),
    )
    .map((control) => ({
      ...control,
      accessibleName: conciseControlLabel(control, contract),
    }));

  const hasUserGestureStep = steps.some((step) =>
    ["navigate", "input", "action", "save"].includes(step.kind),
  );
  const needsCommandTrigger =
    contract.trigger === "user_action" &&
    !hasUserGestureStep &&
    isCommandWorkflowName(contract.name);

  let start = { ...contract.start };
  if (needsCommandTrigger) {
    const page = bestContractStartPage(contract, architecture.pageMap);
    if (page) {
      start = { ...start, route: page.route, screen: page.name };
    }
    let triggerControl = controls.find(
      (control) =>
        normalizeText(control.accessibleName) === normalizeText(contract.name),
    );
    if (!triggerControl) {
      triggerControl = {
        id: uniqueControlId(`${contract.id}-trigger`, controls),
        kind: "button",
        accessibleName: contract.name,
        route: start.route,
        roles: [...contract.actor.roles],
        action: contract.name,
      };
      controls = [triggerControl, ...controls];
    }
    const triggerStepId = uniqueStepId(`${contract.id}-trigger`, steps);
    steps = [
      {
        id: triggerStepId,
        description: contract.name,
        kind: "action",
        route: triggerControl.route,
        controlId: triggerControl.id,
        reads: [],
        writes: [],
        visibleResult: "",
      },
      ...steps,
    ];
  }

  if (contract.trigger === "user_action" && controls.length === 0) {
    controls = [createDiscoverabilityControl({ ...contract, start, steps })];
  }

  const validControlIds = new Set(controls.map((control) => control.id));
  steps = steps.map((step) => ({
    ...step,
    controlId:
      step.kind === "automatic" || step.kind === "result"
        ? ""
        : validControlIds.has(step.controlId)
          ? step.controlId
          : bestControlForStep(step, controls)?.id ?? "",
  }));

  return {
    ...contract,
    start,
    controls: uniqueBy(controls, (control) => control.id),
    steps,
  };
}

function normalizedStepKind(
  step: WorkflowContract["steps"][number],
): WorkflowContract["steps"][number]["kind"] {
  if (step.kind === "automatic" || step.kind === "result") return step.kind;
  const description = step.description.trim();
  if (isVisibleOutcomeDescription(description)) return "result";
  if (isAutomaticEffectDescription(description)) return "automatic";
  if (!isUserGestureDescription(description)) return step.kind;
  const lower = description.toLowerCase();
  if (/\b(enter|type|write|choose|select|pick|upload|attach|check|uncheck|toggle|drag|drop|change .*date)\b/.test(lower)) {
    return "input";
  }
  if (/^\s*(?:the\s+)?(?:user|player|rider|member|owner|editor)?\s*(?:open|go to|navigate|visit)\b/i.test(description)) {
    return "navigate";
  }
  return step.kind === "save" || step.writes.length > 0 ? "save" : "action";
}

function isUserGestureDescription(value: string): boolean {
  const normalized = value.trim();
  if (/^\s*(?:the\s+)?(?:app|application|system|game|screen|page)\b/i.test(normalized)) {
    return false;
  }
  if (isAutomaticEffectDescription(normalized) || isVisibleOutcomeDescription(normalized)) {
    return false;
  }
  return /\b(click|tap|press|enter|type|write|choose|select|pick|upload|attach|check|uncheck|toggle|drag|drop|open|go to|navigate|visit|add|create|edit|update|delete|remove|save|submit|start|stop|play|retry|restart|finish|answer|calculate|export|download|search|filter|sort)\b/i.test(
    normalized,
  );
}

function isAutomaticEffectDescription(value: string): boolean {
  return (
    /^\s*(?:the\s+)?(?:app|application|system|game|screen|page)\s+(?:automatically\s+)?(?:checks?|clears?|compares?|creates?|generates?|loads?|calculates?|moves?|navigates?|persists?|resets?|redirects?|advances?|saves?|starts?|prepares?|stores?|updates?|records?|chooses?|selects?|validates?)\b/i.test(
      value,
    ) ||
    /^\s*(?:the\s+)?(?:user|player|rider|member)\s+(?:automatically\s+)?(?:begins?|arrives?|returns?|lands?|is taken|is redirected)\b/i.test(
      value,
    )
  );
}

function isVisibleOutcomeDescription(value: string): boolean {
  return (
    /^\s*(?:the\s+)?(?:app|application|system|game|screen|page)\s+(?:shows?|displays?|renders?|presents?|provides?|reveals?)\b/i.test(
      value,
    ) ||
    /^\s*(?:the\s+)?(?:user|player|rider|member)\s+(?:sees?|receives?|is shown)\b/i.test(
      value,
    ) ||
    /\b(?:appears?|is shown|is displayed|is visible|becomes visible|shows? (?:the )?(?:result|score|feedback|message))\b/i.test(
      value,
    )
  );
}

function isCommandWorkflowName(value: string): boolean {
  return /^\s*(?:add|answer|calculate|change|choose|create|delete|download|edit|export|finish|mark|move|play|record|remove|restart|retry|save|search|select|start|stop|submit|track|try|update|upload)\b/i.test(
    value,
  );
}

function conciseControlLabel(
  control: WorkflowContract["controls"][number],
  contract: WorkflowContract,
): string {
  const label = control.accessibleName.trim();
  if (
    isAutomaticEffectDescription(label) ||
    isVisibleOutcomeDescription(label) ||
    label.length > 80 ||
    label.split(/\s+/).length > 12
  ) {
    return isCommandWorkflowName(contract.name)
      ? contract.name
      : `Open ${contract.start.screen}`;
  }
  return label;
}

function bestContractStartPage(
  contract: WorkflowContract,
  pages: WorkflowContractArchitecture["pageMap"],
): WorkflowContractArchitecture["pageMap"][number] | undefined {
  const controlRoutes = uniqueStrings(
    contract.controls.map((control) => control.route),
  );
  if (controlRoutes.length === 1) {
    const controlPage = pages.find((page) => page.route === controlRoutes[0]);
    if (controlPage) return controlPage;
  }
  const exact = pages.filter((page) =>
    page.workflows.some(
      (workflow) => normalizeText(workflow) === normalizeText(contract.name),
    ),
  );
  const candidates = exact.length > 0 ? exact : pages;
  const contractText = [
    contract.name,
    ...contract.steps.map((step) => step.description),
  ].join(" ");
  return candidates.reduce<WorkflowContractArchitecture["pageMap"][number] | undefined>(
    (best, page) => {
      if (!best) return page;
      const pageScore = overlapScore(
        contractText,
        `${page.name} ${page.purpose}`,
      );
      const bestScore = overlapScore(
        contractText,
        `${best.name} ${best.purpose}`,
      );
      return pageScore > bestScore ? page : best;
    },
    undefined,
  );
}

function bestControlForStep(
  step: WorkflowContract["steps"][number],
  controls: WorkflowContract["controls"],
): WorkflowContract["controls"][number] | undefined {
  return controls
    .map((control) => ({
      control,
      score: overlapScore(
        step.description,
        `${control.accessibleName} ${control.action}`,
      ),
    }))
    .sort((left, right) => right.score - left.score)
    .find((candidate) => candidate.score > 0)?.control;
}

function uniqueControlId(
  base: string,
  controls: WorkflowContract["controls"],
): string {
  const ids = new Set(controls.map((control) => control.id));
  let candidate = slugify(base);
  let suffix = 2;
  while (ids.has(candidate)) candidate = `${slugify(base)}-${suffix++}`;
  return candidate;
}

function uniqueStepId(
  base: string,
  steps: WorkflowContract["steps"],
): string {
  const ids = new Set(steps.map((step) => step.id));
  let candidate = slugify(base);
  let suffix = 2;
  while (ids.has(candidate)) candidate = `${slugify(base)}-${suffix++}`;
  return candidate;
}

function createDiscoverabilityControl(
  contract: WorkflowContract,
): WorkflowContract["controls"][number] {
  const command = isCommandWorkflowName(contract.name);
  const label = command
    ? contract.name
    : /^(?:review|view|open|show|see)\b/i.test(contract.name)
      ? contract.name
      : `Open ${contract.name}`;
  return {
    id: `${slugify(contract.id || contract.name)}-discoverability-control`,
    kind: command ? "button" : "link",
    accessibleName: label,
    route: contract.start.route,
    roles: [...contract.actor.roles],
    action: `Open ${contract.start.screen} and review ${contract.success.visibleResult}`,
  };
}

function assignSourcesAndHandoffs(
  input: WorkflowContract[],
  spec: AppSpec,
): WorkflowContract[] {
  const contracts = input.map((contract) => {
    const validHandoffs = contract.handoffs.filter((handoff) =>
      contract.expectedSaves.some(
        (save) => save.producedReference === handoff.produces,
      ),
    );
    const hasArchitectHandoffs = validHandoffs.some(
      (handoff) => !isGenericInferredHandoff(contract.id, handoff),
    );
    return {
      ...contract,
      handoffs: validHandoffs.filter(
        (handoff) =>
          !hasArchitectHandoffs ||
          !isGenericInferredHandoff(contract.id, handoff),
      ),
      dependencies: {
        ...contract.dependencies,
        workflowIds: [...contract.dependencies.workflowIds],
      },
      source: {
        ...contract.source,
        acceptanceCriteria: [...contract.source.acceptanceCriteria],
        testScenarios: [...contract.source.testScenarios],
      },
    };
  });

  assignNamedSources(
    contracts,
    spec.acceptanceCriteria.map((criterion) => ({
      name: criterion.name,
      text: [criterion.name, criterion.scenario, criterion.given, criterion.when, criterion.then].join(" "),
    })),
    "acceptanceCriteria",
  );
  assignNamedSources(
    contracts,
    spec.testScenarios.map((scenario) => ({
      name: scenario.name,
      text: [scenario.name, ...scenario.steps, scenario.expectedResult].join(" "),
    })),
    "testScenarios",
  );

  for (const producer of contracts) {
    for (const handoff of producer.handoffs) {
      const consumer = contracts.find(
        (candidate) => candidate.id === handoff.consumerWorkflowId,
      );
      if (
        consumer &&
        !consumer.dependencies.workflowIds.includes(producer.id)
      ) {
        consumer.dependencies.workflowIds.push(producer.id);
      }
    }
  }

  for (let producerIndex = 0; producerIndex < contracts.length; producerIndex += 1) {
    const producer = contracts[producerIndex];
    // A planner-supplied map describes the product's intended handoffs. Do not
    // inflate it with every later collection reader of every record written by
    // the workflow. Fallback contracts still receive inferred handoffs below.
    if (
      producer.handoffs.some(
        (handoff) => !isGenericInferredHandoff(producer.id, handoff),
      )
    ) {
      continue;
    }
    for (const save of producer.expectedSaves) {
      if (
        producer.handoffs.some(
          (handoff) => handoff.produces === save.producedReference,
        )
      ) {
        continue;
      }
      for (let consumerIndex = producerIndex + 1; consumerIndex < contracts.length; consumerIndex += 1) {
        const consumer = contracts[consumerIndex];
        if (
          !consumer.requiredData.some(
            (data) => data.entityKey === save.entityKey && data.operations.includes("read"),
          )
        ) {
          continue;
        }
        const handoffId = `${producer.id}-to-${consumer.id}-${save.entityKey}`;
        if (
          !producer.handoffs.some(
            (handoff) =>
              handoff.id === handoffId ||
              (handoff.produces === save.producedReference &&
                handoff.consumerWorkflowId === consumer.id),
          )
        ) {
          producer.handoffs.push({
            id: handoffId,
            fromStepId: save.stepId,
            produces: save.producedReference,
            storage: save.storage,
            consumerWorkflowId: consumer.id,
            consumerRoute: consumer.start.route,
            consumerControlId: consumer.controls[0]?.id ?? "",
            loadRule: `Load the saved ${save.entityName} record from ${save.storage} and make it available on ${consumer.start.screen}.`,
          });
        }
        if (!consumer.dependencies.workflowIds.includes(producer.id)) {
          consumer.dependencies.workflowIds.push(producer.id);
        }
      }
    }
  }

  return contracts;
}

function isGenericInferredHandoff(
  producerWorkflowId: string,
  handoff: WorkflowContract["handoffs"][number],
): boolean {
  const entityKey = handoff.produces.split(".", 1)[0] ?? "";
  return (
    handoff.id ===
    `${producerWorkflowId}-to-${handoff.consumerWorkflowId}-${slugify(entityKey)}`
  );
}

function assignNamedSources(
  contracts: WorkflowContract[],
  sources: Array<{ name: string; text: string }>,
  key: "acceptanceCriteria" | "testScenarios",
): void {
  if (contracts.length === 0) return;
  for (const source of sources) {
    let bestIndex = 0;
    let bestScore = -1;
    contracts.forEach((contract, index) => {
      const score = overlapScore(
        `${contract.name} ${contract.steps.map((step) => step.description).join(" ")}`,
        source.text,
      );
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    });
    if (!contracts[bestIndex].source[key].includes(source.name)) {
      contracts[bestIndex].source[key].push(source.name);
    }
  }
}

function inferRequiredData(
  spec: AppSpec,
  architecture: WorkflowContractArchitecture,
  workflow: AppSpec["workflows"][number],
  operations: Array<z.infer<typeof workflowDataOperationSchema>>,
): WorkflowContract["requiredData"] {
  if (spec.dataEntities.length === 0) return [];
  const text = workflowText(workflow);
  const scored = spec.dataEntities
    .map((entity) => ({
      entity,
      platform: platformEntityFromSpec(entity, spec),
      score: overlapScore(
        text,
        `${entity.name} ${entity.description} ${platformEntityFromSpec(entity, spec).key}`,
      ),
    }))
    .filter((item) => item.score > 0);
  const maxScore = Math.max(0, ...scored.map((item) => item.score));
  const selected =
    scored.length > 0
      ? scored.filter((item) => item.score >= Math.ceil(maxScore / 2))
      : spec.dataEntities.length === 1
        ? [
            {
              entity: spec.dataEntities[0],
              platform: platformEntityFromSpec(spec.dataEntities[0], spec),
              score: 0,
            },
          ]
        : [];
  const storageKeys = new Set(
    architecture.dataModel.map((entity) => normalizeEntityKey(entity.name)),
  );
  const requirements: WorkflowContract["requiredData"] = selected
    .filter((item) => storageKeys.has(item.platform.key))
    .map(({ entity, platform, score }) => ({
      entityName: entity.name,
      entityKey: platform.key,
      operations:
        score === 0 || score >= maxScore - 1 ? operations : ["read"],
      requiredFieldKeys: platform.fields
        .filter((field) => field.required)
        .map((field) => field.key),
    }));

  for (const { entity } of selected) {
    for (const relationship of entity.relationships) {
      const relatedEntity = spec.dataEntities.find(
        (candidate) =>
          normalizeEntityKey(candidate.name) ===
          normalizeEntityKey(relationship.targetEntity),
      );
      if (!relatedEntity) continue;
      const platform = platformEntityFromSpec(relatedEntity, spec);
      if (
        !storageKeys.has(platform.key) ||
        requirements.some((requirement) => requirement.entityKey === platform.key)
      ) {
        continue;
      }
      requirements.push({
        entityName: relatedEntity.name,
        entityKey: platform.key,
        operations: ["read"],
        requiredFieldKeys: platform.fields
          .filter((field) => field.required)
          .map((field) => field.key),
      });
    }
  }

  return requirements;
}

function inferOperations(
  workflow: AppSpec["workflows"][number],
): Array<z.infer<typeof workflowDataOperationSchema>> {
  const text = workflowText(workflow).toLowerCase();
  const operations: Array<z.infer<typeof workflowDataOperationSchema>> = ["read"];
  if (/\b(add|create|save|upload|record|schedule|start)\b/.test(text)) {
    operations.push("create");
  }
  if (/\b(edit|update|change|assign|mark|move|select|complete|finish)\b/.test(text)) {
    operations.push("update");
  }
  if (/\b(delete|remove|archive)\b/.test(text)) operations.push("delete");
  return unique(operations);
}

function inferRoles(
  spec: AppSpec,
  actor: string,
  operations: Array<z.infer<typeof workflowDataOperationSchema>>,
): WorkflowContractRole[] {
  const actorText = actor.toLowerCase();
  const mutates = operations.some((operation) => WRITE_OPERATIONS.has(operation));
  if (actorText.includes("viewer")) return ["viewer"];
  if (actorText.includes("editor")) return ["editor"];
  if (actorText.includes("owner") || actorText.includes("admin")) return ["owner"];
  if (!spec.needsLogin) {
    return spec.sharingModel === "private" ? ["owner"] : ["public"];
  }
  return mutates ? ["owner", "editor"] : ["owner", "editor", "viewer"];
}

function inferControls(
  workflowId: string,
  route: string,
  roles: WorkflowContractRole[],
  steps: string[],
): WorkflowContract["controls"] {
  const actionable = steps.filter(
    (step) => !/^\s*(review|see|show|display|result|confirm)\b/i.test(step),
  );
  const source = actionable.length > 0 ? actionable : steps;
  return source.map((step, index) => ({
    id: `${workflowId}-control-${index + 1}`,
    kind: inferControlKind(step),
    accessibleName: controlLabel(step),
    route,
    roles,
    action: step,
  }));
}

function inferControlKind(
  step: string,
): WorkflowContract["controls"][number]["kind"] {
  const lower = step.toLowerCase();
  if (/upload|photo|image|attachment|file/.test(lower)) return "file";
  if (/drag|drop|move between/.test(lower)) return "drag_drop";
  if (/date|day|time/.test(lower)) return "date";
  if (/check|toggle|complete/.test(lower)) return "checkbox";
  if (/choose|select|pick/.test(lower)) return "combobox";
  if (/enter|type|write|search|filter/.test(lower)) return "textbox";
  if (/open|go to|navigate|view|review|overview|display|show/.test(lower)) {
    return "link";
  }
  return "button";
}

function inferStepKind(
  step: string,
  shouldSave: boolean,
): WorkflowContract["steps"][number]["kind"] {
  if (shouldSave) return "save";
  const lower = step.toLowerCase();
  if (/^\s*(open|go to|navigate)/.test(lower)) return "navigate";
  if (/enter|type|write|choose|select|pick|upload|date/.test(lower)) return "input";
  if (/review|see|show|display|confirm/.test(lower)) return "result";
  return "action";
}

function selectStartingPage(
  workflow: AppSpec["workflows"][number],
  pages: WorkflowContractArchitecture["pageMap"],
): WorkflowContractArchitecture["pageMap"][number] {
  const fallback = pages[0] ?? {
    route: "/",
    name: "Home",
    purpose: "Primary app screen",
    workflows: [],
  };
  const exact = pages.filter((page) =>
    page.workflows.some(
      (name) => normalizeText(name) === normalizeText(workflow.name),
    ),
  );
  const candidates = exact.length > 0 ? exact : pages;
  return candidates.reduce(
    (best, page) =>
      overlapScore(workflowText(workflow), `${page.name} ${page.purpose}`) >
      overlapScore(workflowText(workflow), `${best.name} ${best.purpose}`)
        ? page
        : best,
    candidates[0] ?? fallback,
  );
}

function inferPlatformServices(
  workflow: AppSpec["workflows"][number],
  requiredData: WorkflowContract["requiredData"],
  architecture: WorkflowContractArchitecture,
  spec: AppSpec,
): WorkflowContract["dependencies"]["platformServices"] {
  const text = workflowText(workflow).toLowerCase();
  const requested = new Set<z.infer<typeof workflowPlatformServiceSchema>>();
  if (requiredData.length > 0) {
    const usesPlatformData = requiredData.some((data) =>
      architecture.dataModel.some(
        (entity) =>
          normalizeEntityKey(entity.name) === data.entityKey &&
          entity.storage === "platformData",
      ),
    );
    if (usesPlatformData) requested.add("data");
  }
  if (
    spec.integrations.some(isExternalIntegrationRequirement) &&
    /\b(map|route|place|geocode|elevation)\b/.test(text)
  ) {
    requested.add("integrations");
  }
  if (/\b(gps|location|track|tracking|gpx)\b/.test(text)) requested.add("device_location");
  if (/\b(file|photo|image|attachment|upload|download)\b/.test(text)) requested.add("files");
  if (/\b(remind|notification|notify|scheduled)\b/.test(text)) requested.add("jobs");
  if (/\b(email)\b/.test(text)) requested.add("email");
  if (/\b(search|filter|sort|find)\b/.test(text)) requested.add("search");
  if (/\b(report|dashboard|chart|export)\b/.test(text)) requested.add("reports");
  if (/\b(ai|generate|suggest|summarize)\b/.test(text)) requested.add("ai");
  return [...requested];
}

function inferPreconditions(
  spec: AppSpec,
  roles: WorkflowContractRole[],
): string[] {
  const conditions: string[] = [];
  if (spec.needsLogin) conditions.push("The user is signed in to VoiceForge.");
  if (roles.includes("viewer")) {
    conditions.push("The viewer has access to this generated app.");
  }
  if (roles.some((role) => role === "owner" || role === "editor")) {
    conditions.push("The user's role allows the required actions.");
  }
  return conditions;
}

function inferTrigger(trigger: string): WorkflowContract["trigger"] {
  if (/schedule|automatic|daily|weekly|hourly|due/i.test(trigger)) return "scheduled";
  if (/system|background|after .* saved/i.test(trigger)) return "system";
  return "user_action";
}

function persistentStorage(
  storage: WorkflowContractArchitecture["dataModel"][number]["storage"] | undefined,
  sharingModel: AppSpec["sharingModel"],
): "localStorage" | "platformData" | "platformFiles" {
  if (storage === "platformData") return "platformData";
  if (storage === "localStorage") return "localStorage";
  return sharingModel === "private" ? "localStorage" : "platformData";
}

function canAnyRoleWrite(
  spec: AppSpec,
  roles: WorkflowContractRole[],
): boolean {
  return roles.some(
    (role) =>
      role === "owner" ||
      role === "editor" ||
      (role === "public" && spec.sharingModel === "shared" && !spec.needsLogin),
  );
}

function workflowText(workflow: AppSpec["workflows"][number]): string {
  return [
    workflow.name,
    workflow.actor,
    workflow.trigger,
    ...workflow.steps,
    workflow.successOutcome,
  ].join(" ");
}

function contractPromisesPersistence(
  contract: WorkflowContract,
  workflow: AppSpec["workflows"][number] | undefined,
): boolean {
  const declaresWrite =
    contract.steps.some(
      (step) => step.kind === "save" || step.writes.length > 0,
    ) ||
    contract.requiredData.some((data) =>
      data.operations.some((operation) => WRITE_OPERATIONS.has(operation)),
    );
  if (declaresWrite) return true;
  if (!workflow) return false;

  return /\b(add|archive|create|delete|edit|record|remove|save|schedule|update|upload)\b/i.test(
    workflowText(workflow),
  );
}

function overlapScore(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  let score = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) score += token.length > 5 ? 2 : 1;
  }
  return score;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
      .map(singularToken),
  );
}

function singularToken(value: string): string {
  return value.endsWith("s") && value.length > 3 ? value.slice(0, -1) : value;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function controlLabel(step: string): string {
  const cleaned = step.replace(/^\s*(the user|user)\s+/i, "").trim();
  return cleaned || "Continue";
}

function successMessage(outcome: string): string {
  const trimmed = outcome.trim();
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

function uniqueWorkflowId(name: string, index: number): string {
  return `${slugify(name)}-${index + 1}`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "workflow"
  );
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicatesFound = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicatesFound.add(value);
    seen.add(value);
  }
  return [...duplicatesFound];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: T[], keyFor: (value: T) => string): T[] {
  const keys = new Set<string>();
  return values.filter((value) => {
    const key = keyFor(value);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  return unique(values.filter(Boolean));
}
