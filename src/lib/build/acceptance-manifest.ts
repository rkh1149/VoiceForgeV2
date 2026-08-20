import type { ArchitecturePlan } from "../architecture";
import type { AppSpec } from "../spec";
import type { WorkflowContractRole } from "../workflow-contract";
import {
  synthesizeWorkflowAcceptancePlan,
  type WorkflowAcceptanceFixture,
  type WorkflowAcceptanceJourney,
  type WorkflowAcceptancePlan,
  type WorkflowAcceptanceStep,
} from "./workflow-acceptance-plan";

export const ACCEPTANCE_MANIFEST_VERSION = 3 as const;
export const ACCEPTANCE_COMPILER_VERSION = 3 as const;

export type AcceptanceLocatorMode = "contract" | "accessible_name_fallback";

export type AcceptancePrimitive =
  | "navigate"
  | "fill"
  | "complete_form"
  | "select"
  | "check"
  | "upload"
  | "click"
  | "download"
  | "assert_visible"
  | "adapter";

export type AcceptanceManifestFixture = WorkflowAcceptanceFixture & {
  id: string;
  runScoped: boolean;
  relationFixtureId: string | null;
};

export type AcceptanceManifestPrerequisite = {
  id: string;
  journeyId: string;
  workflowIds: string[];
  storage: Array<"localStorage" | "platformData" | "platformFiles">;
  entityKeys: string[];
  fixtureIds: string[];
  setupStrategy: "visible_ui";
};

export type AcceptanceJourneyIsolation = {
  fixtureNamespace: string;
  prerequisiteJourneyIds: string[];
  browserLocalPrerequisitesRecreated: boolean;
  sharedDataNamespaced: boolean;
  parallelSafe: boolean;
  parallelBlockers: string[];
};

export type AcceptanceManifestControl = {
  workflowId: string;
  controlId: string;
  accessibleName: string;
  locatorMode: AcceptanceLocatorMode;
  recordScope: {
    entityKey: string;
    fixtureId: string;
  } | null;
};

export type AcceptanceManifestStep = {
  id: string;
  workflowId: string;
  contractStepId: string;
  description: string;
  route: string;
  reads: string[];
  writes: string[];
  primitive: AcceptancePrimitive;
  control: AcceptanceManifestControl | null;
  fixtureIds: string[];
  expectedText: string;
  assertionFixtureId: string | null;
  assertionText: string;
  assertionScope: {
    entityKey: string;
    fixtureId: string;
  } | null;
  expectedRoute: string;
  expectedPresence: boolean;
  adapterId: string | null;
};

export type AcceptanceManifestSave = {
  id: string;
  workflowId: string;
  stepId: string;
  operation: "create" | "update" | "delete";
  entityKey: string;
  storage: "localStorage" | "platformData" | "platformFiles";
  fixtureId: string | null;
  expectedPresence: boolean;
  expectedText: string;
};

export type AcceptanceManifestHandoff = {
  id: string;
  producerWorkflowId: string;
  fromStepId: string;
  consumerWorkflowId: string;
  consumerRoute: string;
  storage: "localStorage" | "platformData" | "platformFiles";
  consumerControl: AcceptanceManifestControl | null;
  fixtureId: string | null;
  expectedText: string;
  expectedPresence: boolean;
};

export type AcceptanceManifestRoleCheck = {
  id: string;
  role: WorkflowContractRole;
  route: string;
  hiddenControl: AcceptanceManifestControl;
};

export type AcceptanceManifestJourney = {
  id: string;
  name: string;
  componentId: string;
  sequence: number;
  dependsOnJourneyIds: string[];
  startRoute: string;
  executionRole: WorkflowContractRole;
  requiresGeolocation: boolean;
  fixtures: AcceptanceManifestFixture[];
  steps: AcceptanceManifestStep[];
  saves: AcceptanceManifestSave[];
  handoffs: AcceptanceManifestHandoff[];
  roleChecks: AcceptanceManifestRoleCheck[];
  prerequisites: AcceptanceManifestPrerequisite[];
  isolation: AcceptanceJourneyIsolation;
};

export type AcceptanceAdapterRequirement = {
  id: string;
  journeyId: string;
  workflowId: string;
  contractStepId: string;
  description: string;
  reason: string;
};

export type VoiceForgeAcceptanceManifest = {
  version: typeof ACCEPTANCE_MANIFEST_VERSION;
  compilerVersion: typeof ACCEPTANCE_COMPILER_VERSION;
  sourcePlanVersion: WorkflowAcceptancePlan["version"];
  locatorMode: AcceptanceLocatorMode;
  journeys: AcceptanceManifestJourney[];
  adapters: AcceptanceAdapterRequirement[];
  summary: {
    components: number;
    journeys: number;
    steps: number;
    saves: number;
    handoffs: number;
    roleChecks: number;
    adapterRequirements: number;
    prerequisites: number;
    isolatedJourneys: number;
    parallelSafeJourneys: number;
  };
};

export type AcceptanceManifestValidation = {
  blockingIssues: string[];
  warnings: string[];
};

export function createAcceptanceTestManifest(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  locatorMode?: AcceptanceLocatorMode;
}): VoiceForgeAcceptanceManifest {
  const plan = synthesizeWorkflowAcceptancePlan(input.spec, input.architecture);
  const locatorMode = input.locatorMode ?? "contract";
  const componentIds = acceptanceComponentIds(plan);

  const plannedJourneys = plan.journeys.map((journey) => {
    const fixtures = journey.fixtures.map((fixture) => ({
      ...fixture,
      id: fixtureId(journey.id, fixture),
      runScoped: isRunScopedFixture(fixture),
      relationFixtureId: null,
    }));
    const fixtureByEntity = fixturesByEntity(fixtures);
    const steps = journey.steps.map((step) =>
      manifestStep({
        step,
        journey,
        fixtures,
        fixtureByEntity,
        locatorMode,
      }),
    );
    const saves = journey.saves.map((save) => {
      const fixture = bestEntityFixture(fixtureByEntity.get(save.entityKey) ?? []);
      return {
        id: save.id,
        workflowId: save.workflowId,
        stepId: save.stepId,
        operation: save.operation,
        entityKey: save.entityKey,
        storage: save.storage,
        fixtureId: fixture?.id ?? null,
        expectedPresence: save.operation !== "delete",
        expectedText: fixtureText(fixture) || save.producedReference,
      } satisfies AcceptanceManifestSave;
    });
    const handoffs = journey.handoffs.map((handoff) => {
      const producerSave = journey.saves.find(
        (save) => save.workflowId === handoff.producerWorkflowId,
      );
      const fixture = producerSave
        ? bestEntityFixture(fixtureByEntity.get(producerSave.entityKey) ?? [])
        : null;
      return {
        id: handoff.id,
        producerWorkflowId: handoff.producerWorkflowId,
        fromStepId: handoff.fromStepId,
        consumerWorkflowId: handoff.consumerWorkflowId,
        consumerRoute: handoff.consumerRoute,
        storage: handoff.storage,
        consumerControl:
          handoff.consumerControlId && producerSave?.operation !== "delete"
          ? {
              workflowId: handoff.consumerWorkflowId,
              controlId: handoff.consumerControlId,
              accessibleName: handoff.consumerAccessibleName,
              locatorMode,
              recordScope:
                producerSave &&
                fixture &&
                isRepeatedRecordControl(
                  handoff.consumerAccessibleName,
                  handoff.consumerControlId,
                )
                  ? {
                      entityKey: producerSave.entityKey,
                      fixtureId: fixture.id,
                    }
                  : null,
            }
          : null,
        fixtureId: fixture?.id ?? null,
        expectedText: fixtureText(fixture) || handoff.produces,
        expectedPresence: producerSave?.operation !== "delete",
      } satisfies AcceptanceManifestHandoff;
    });
    const roleChecks = journey.roleScenarios.flatMap((scenario) =>
      scenario.readOnlyRoles.flatMap((role) => {
        const hidden = mutationControlForRole(
          input.architecture,
          scenario.workflowId,
          role,
        );
        if (!hidden) return [];
        return [
          {
            id: `${scenario.workflowId}:${role}:read-only`,
            role,
            route: hidden.route,
            hiddenControl: {
              workflowId: hidden.workflowId,
              controlId: hidden.controlId,
              accessibleName: hidden.accessibleName,
              locatorMode,
              recordScope: null,
            },
          } satisfies AcceptanceManifestRoleCheck,
        ];
      }),
    );

    return {
      id: journey.id,
      name: journey.name,
      componentId: componentIds.get(journey.id) ?? journey.id,
      sequence: journey.sequence,
      dependsOnJourneyIds: [...journey.dependsOnJourneyIds],
      startRoute: journey.startRoute,
      executionRole: preferredRole(journey.executionRoles),
      requiresGeolocation: journey.requiresGeolocation,
      fixtures,
      steps,
      saves,
      handoffs,
      roleChecks,
      prerequisites: [],
      isolation: {
        fixtureNamespace: `vf-${slugify(journey.id)}`,
        prerequisiteJourneyIds: [],
        browserLocalPrerequisitesRecreated: true,
        sharedDataNamespaced: true,
        parallelSafe: true,
        parallelBlockers: [],
      },
    } satisfies AcceptanceManifestJourney;
  });
  const journeys = finalizeJourneyIsolation({
    journeys: splitDestructiveWorkflowJourneys(plannedJourneys),
    architecture: input.architecture,
  });
  const adapters = journeys.flatMap((journey) =>
    journey.steps.flatMap((step) =>
      step.adapterId
        ? [
            {
              id: step.adapterId,
              journeyId: journey.id,
              workflowId: step.workflowId,
              contractStepId: step.contractStepId,
              description: step.description,
              reason:
                "The contracted interaction cannot be represented safely by one standard control primitive.",
            } satisfies AcceptanceAdapterRequirement,
          ]
        : [],
    ),
  );

  return {
    version: ACCEPTANCE_MANIFEST_VERSION,
    compilerVersion: ACCEPTANCE_COMPILER_VERSION,
    sourcePlanVersion: plan.version,
    locatorMode,
    journeys,
    adapters,
    summary: {
      components: new Set(journeys.map((journey) => journey.componentId)).size,
      journeys: journeys.length,
      steps: journeys.reduce((total, journey) => total + journey.steps.length, 0),
      saves: journeys.reduce((total, journey) => total + journey.saves.length, 0),
      handoffs: journeys.reduce(
        (total, journey) => total + journey.handoffs.length,
        0,
      ),
      roleChecks: journeys.reduce(
        (total, journey) => total + journey.roleChecks.length,
        0,
      ),
      adapterRequirements: adapters.length,
      prerequisites: journeys.reduce(
        (total, journey) => total + journey.prerequisites.length,
        0,
      ),
      isolatedJourneys: journeys.filter(
        (journey) => journey.isolation.browserLocalPrerequisitesRecreated,
      ).length,
      parallelSafeJourneys: journeys.filter(
        (journey) => journey.isolation.parallelSafe,
      ).length,
    },
  };
}

export function validateAcceptanceTestManifest(input: {
  plan: WorkflowAcceptancePlan;
  manifest: VoiceForgeAcceptanceManifest;
}): AcceptanceManifestValidation {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  if (input.manifest.version !== ACCEPTANCE_MANIFEST_VERSION) {
    blockingIssues.push(
      `acceptance_compiler: Manifest version ${input.manifest.version} is not supported.`,
    );
  }
  if (input.manifest.compilerVersion !== ACCEPTANCE_COMPILER_VERSION) {
    blockingIssues.push(
      `acceptance_compiler: Compiler version ${input.manifest.compilerVersion} is not supported.`,
    );
  }

  const manifestJourneyIds = input.manifest.journeys.map((journey) => journey.id);
  for (const duplicate of duplicates(manifestJourneyIds)) {
    blockingIssues.push(
      `acceptance_compiler: Journey ${duplicate} appears more than once in the acceptance manifest.`,
    );
  }
  const manifestSteps = input.manifest.journeys.flatMap((journey) =>
    journey.steps.map(
      (step) => `${step.workflowId}:${step.contractStepId}`,
    ),
  );
  const manifestSaveIds = input.manifest.journeys.flatMap((journey) =>
    journey.saves.map((save) => save.id),
  );
  const manifestHandoffIds = input.manifest.journeys.flatMap((journey) =>
    journey.handoffs.map((handoff) => handoff.id),
  );
  for (const journey of input.plan.journeys) {
    for (const step of journey.steps) {
      if (
        count(
          manifestSteps,
          `${step.workflowId}:${step.contractStepId}`,
        ) !== 1
      ) {
        blockingIssues.push(
          `acceptance_compiler: Step ${step.workflowId}/${step.contractStepId} must appear exactly once in the acceptance manifest.`,
        );
      }
    }
    for (const save of journey.saves) {
      if (count(manifestSaveIds, save.id) !== 1) {
        blockingIssues.push(
          `acceptance_compiler: Save ${save.id} must appear exactly once in the acceptance manifest.`,
        );
      }
    }
    for (const handoff of journey.handoffs) {
      if (count(manifestHandoffIds, handoff.id) !== 1) {
        blockingIssues.push(
          `acceptance_compiler: Handoff ${handoff.id} must appear exactly once in the acceptance manifest.`,
        );
      }
    }
  }

  const adapterIds = input.manifest.adapters.map((adapter) => adapter.id);
  for (const journey of input.manifest.journeys) {
    for (const step of journey.steps) {
      if (step.primitive === "adapter" && !step.adapterId) {
        blockingIssues.push(
          `acceptance_compiler: Adapter step ${step.workflowId}/${step.contractStepId} has no adapter id.`,
        );
      }
      if (
        step.adapterId &&
        count(adapterIds, step.adapterId) !== 1
      ) {
        blockingIssues.push(
          `acceptance_compiler: Adapter ${step.adapterId} must be declared exactly once.`,
        );
      }
      if (step.control && !step.control.controlId) {
        blockingIssues.push(
          `acceptance_compiler: Step ${step.workflowId}/${step.contractStepId} has an empty stable control id.`,
        );
      }
    }
  }
  const duplicateAdapterIds = duplicates(adapterIds);
  if (duplicateAdapterIds.length > 0) {
    blockingIssues.push(
      `acceptance_compiler: Duplicate adapter ids: ${duplicateAdapterIds.join(", ")}.`,
    );
  }
  if (input.manifest.locatorMode === "accessible_name_fallback") {
    warnings.push(
      "acceptance_compiler: This change build uses accessible-name fallback for legacy controls; new builds require permanent Stage 14G identities.",
    );
  }
  const manifestById = new Map(
    input.manifest.journeys.map((journey) => [journey.id, journey]),
  );
  for (const journey of input.manifest.journeys) {
    const expectedDependencies = journey.prerequisites.map(
      (prerequisite) => prerequisite.journeyId,
    );
    if (!sameStrings(journey.isolation.prerequisiteJourneyIds, expectedDependencies)) {
      blockingIssues.push(
        `fixture_isolation: Journey ${journey.id} does not declare its complete prerequisite chain.`,
      );
    }
    for (const prerequisite of journey.prerequisites) {
      const source = manifestById.get(prerequisite.journeyId);
      const sourceWorkflowIds = new Set(
        source?.steps.map((step) => step.workflowId) ?? [],
      );
      if (
        !source ||
        prerequisite.workflowIds.length === 0 ||
        prerequisite.workflowIds.some(
          (workflowId) => !sourceWorkflowIds.has(workflowId),
        )
      ) {
        blockingIssues.push(
          `fixture_isolation: Journey ${journey.id} has an invalid workflow-scoped prerequisite from ${prerequisite.journeyId}.`,
        );
      }
    }
    const availableFixtureIds = new Set([
      ...journey.fixtures.map((fixture) => fixture.id),
      ...journey.prerequisites.flatMap((prerequisite) => prerequisite.fixtureIds),
    ]);
    for (const fixture of journey.fixtures) {
      if (
        fixture.relationEntityKey &&
        (!fixture.relationFixtureId ||
          !availableFixtureIds.has(fixture.relationFixtureId))
      ) {
        blockingIssues.push(
          `fixture_isolation: Relation fixture ${fixture.id} cannot resolve a visible ${fixture.relationEntityKey} prerequisite.`,
        );
      }
    }
    if (!journey.isolation.browserLocalPrerequisitesRecreated) {
      blockingIssues.push(
        `fixture_isolation: Journey ${journey.id} relies on browser-local state from another test.`,
      );
    }
    if (!journey.isolation.sharedDataNamespaced) {
      blockingIssues.push(
        `fixture_isolation: Journey ${journey.id} does not namespace shared platform records by test attempt.`,
      );
    }
    if (
      journey.isolation.parallelSafe &&
      journey.isolation.parallelBlockers.length > 0
    ) {
      blockingIssues.push(
        `fixture_isolation: Journey ${journey.id} is marked parallel-safe despite: ${journey.isolation.parallelBlockers.join(", ")}.`,
      );
    }
  }
  return {
    blockingIssues: uniqueStrings(blockingIssues),
    warnings: uniqueStrings(warnings),
  };
}

function manifestStep(input: {
  step: WorkflowAcceptanceStep;
  journey: WorkflowAcceptanceJourney;
  fixtures: AcceptanceManifestFixture[];
  fixtureByEntity: Map<string, AcceptanceManifestFixture[]>;
  locatorMode: AcceptanceLocatorMode;
}): AcceptanceManifestStep {
  const fixtures = fixturesForStep(input.step, input.fixtures, input.fixtureByEntity);
  const primitive = primitiveForStep(input.step, fixtures.length);
  const recordFixture = repeatedRecordFixture(input.step, input.fixtureByEntity);
  const assertionFixture = assertionRecordFixture(
    input.step,
    input.fixtureByEntity,
  );
  const success = input.journey.successResults.find(
    (candidate) => candidate.workflowId === input.step.workflowId,
  );
  const expectedText =
    input.step.visibleResult ||
    success?.message ||
    success?.visibleResult ||
    fixtureText(fixtures[0]);
  const deleteStep = input.journey.saves.some(
    (save) =>
      save.workflowId === input.step.workflowId &&
      save.stepId === input.step.contractStepId &&
      save.operation === "delete",
  );
  const currentStepIndex = input.journey.steps.findIndex(
    (candidate) => candidate.id === input.step.id,
  );
  const deletedBeforeOrAtStep = Boolean(
    assertionFixture &&
      input.journey.saves.some((save) => {
        if (
          save.workflowId !== input.step.workflowId ||
          save.operation !== "delete" ||
          save.entityKey !== assertionFixture.entityKey
        ) {
          return false;
        }
        const saveStepIndex = input.journey.steps.findIndex(
          (candidate) =>
            candidate.workflowId === save.workflowId &&
            candidate.contractStepId === save.stepId,
        );
        return saveStepIndex >= 0 && saveStepIndex <= currentStepIndex;
      }),
  );
  const adapterId =
    primitive === "adapter"
      ? `adapter-${slugify(input.journey.id)}-${slugify(input.step.workflowId)}-${slugify(input.step.contractStepId)}`
      : null;
  return {
    id: input.step.id,
    workflowId: input.step.workflowId,
    contractStepId: input.step.contractStepId,
    description: input.step.description,
    route: input.step.route,
    reads: [...input.step.reads],
    writes: [...input.step.writes],
    primitive,
    control: input.step.controlId
      ? {
          workflowId: input.step.workflowId,
          controlId: input.step.controlId,
          accessibleName: input.step.accessibleName,
          locatorMode: input.locatorMode,
          recordScope: recordFixture
            ? {
                entityKey: recordFixture.entityKey,
                fixtureId: recordFixture.id,
              }
            : null,
        }
      : null,
    fixtureIds: fixtures.map((fixture) => fixture.id),
    expectedText,
    assertionFixtureId: assertionFixture?.id ?? null,
    assertionText: conciseStateText(input.step, input.fixtureByEntity),
    assertionScope: assertionFixture && input.step.controlId
      ? {
          entityKey: assertionFixture.entityKey,
          fixtureId: assertionFixture.id,
        }
      : null,
    expectedRoute: input.step.route,
    expectedPresence: !deleteStep && !deletedBeforeOrAtStep,
    adapterId,
  };
}

function primitiveForStep(
  step: WorkflowAcceptanceStep,
  fixtureCount: number,
): AcceptancePrimitive {
  if (step.kind === "result" || step.kind === "automatic") {
    return "assert_visible";
  }
  if (step.kind === "navigate") return "navigate";
  if (step.kind === "input" && fixtureCount > 1) return "complete_form";
  switch (step.controlKind) {
    case "textbox":
    case "date":
      return "fill";
    case "form":
      return "complete_form";
    case "combobox":
    case "radio":
    case "menu":
      return "select";
    case "checkbox":
      return "check";
    case "file":
      return "upload";
    case "drag_drop":
      return "adapter";
    case "button":
    case "link":
      break;
    case null:
      if (step.kind === "input") return "adapter";
      break;
  }
  if (
    /\b(export|download)\b/i.test(
      `${step.description} ${step.accessibleName}`,
    )
  ) {
    return "download";
  }
  return "click";
}

function fixturesForStep(
  step: WorkflowAcceptanceStep,
  fixtures: AcceptanceManifestFixture[],
  fixtureByEntity: Map<string, AcceptanceManifestFixture[]>,
): AcceptanceManifestFixture[] {
  const entityFixtures = uniqueFixturesById(
    uniqueStrings([...step.writes, ...step.reads]).flatMap(
      (entityKey) => fixtureByEntity.get(entityKey) ?? [],
    ),
  );
  const candidates =
    entityFixtures.length > 0 ? entityFixtures : uniqueFixturesById(fixtures);
  if (step.controlKind === "form") return candidates;
  if (step.kind === "input") {
    const explicitFields = candidates.filter(
      (fixture) =>
        fixtureExplicitlyMentioned(step, fixture) &&
        !fixtureIntentionallyBlank(step, fixture),
    );
    if (explicitFields.length > 1) return explicitFields;
  }
  const ranked = candidates
    .map((fixture) => ({
      fixture,
      score: fixtureMatchScore(step, fixture),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.fixture.id.localeCompare(right.fixture.id),
    );
  return ranked.length > 0 ? [ranked[0].fixture] : [];
}

function repeatedRecordFixture(
  step: WorkflowAcceptanceStep,
  fixtureByEntity: Map<string, AcceptanceManifestFixture[]>,
): AcceptanceManifestFixture | null {
  if (/\b(confirm|cancel)\b/i.test(`${step.description} ${step.accessibleName}`)) {
    return null;
  }
  if (
    step.controlKind === "link" &&
    !/\b(open|view|edit|delete|remove|archive)\b/i.test(step.accessibleName)
  ) {
    return null;
  }
  if (!isRepeatedRecordControl(step.accessibleName, step.controlId)) {
    return null;
  }
  for (const entityKey of [...step.reads, ...step.writes]) {
    const fixture = bestEntityFixture(fixtureByEntity.get(entityKey) ?? []);
    if (fixture) return fixture;
  }
  return null;
}

function isRepeatedRecordControl(...parts: string[]): boolean {
  const [accessibleName = "", controlId = ""] = parts;
  const visibleAction = accessibleName.trim() || controlId;
  return /\b(edit|delete|remove|archive|complete|finish|reopen|mark|open|view)\b/i.test(
    visibleAction,
  );
}

function assertionRecordFixture(
  step: WorkflowAcceptanceStep,
  fixtureByEntity: Map<string, AcceptanceManifestFixture[]>,
): AcceptanceManifestFixture | null {
  return (
    uniqueStrings([...step.writes, ...step.reads])
      .map((entityKey, index) => {
        const fixtures = fixtureByEntity.get(entityKey) ?? [];
        return {
          fixture: bestEntityFixture(fixtures),
          score:
            (step.writes.includes(entityKey) ? 100 : 0) +
            entityMentionScore(step.visibleResult, entityKey, fixtures) * 10 +
            entityMentionScore(step.description, entityKey, fixtures) * 2 -
            index / 100,
        };
      })
      .filter(
        (candidate): candidate is {
          fixture: AcceptanceManifestFixture;
          score: number;
        } => Boolean(candidate.fixture),
      )
      .sort((left, right) => right.score - left.score)[0]?.fixture ?? null
  );
}

function entityMentionScore(
  source: string,
  entityKey: string,
  fixtures: AcceptanceManifestFixture[],
): number {
  const sourceWords = words(source);
  const entityWords = words(
    `${entityKey} ${fixtures[0]?.entityName ?? ""}`,
  );
  let score = 0;
  for (const entityWord of entityWords) {
    if (
      [...sourceWords].some(
        (sourceWord) =>
          sourceWord === entityWord ||
          sourceWord === `${entityWord}s` ||
          sourceWord === `${entityWord}es`,
      )
    ) {
      score += 1;
    }
  }
  return score;
}

function conciseStateText(
  step: WorkflowAcceptanceStep,
  fixtureByEntity: Map<string, AcceptanceManifestFixture[]>,
): string {
  const normalizedResult = step.visibleResult.replaceAll("-", " ");
  for (const entityKey of uniqueStrings([...step.writes, ...step.reads])) {
    for (const fixture of fixtureByEntity.get(entityKey) ?? []) {
      if (fixture.type === "boolean") {
        const label = fixture.label.trim();
        if (!label) continue;
        if (
          new RegExp(`\\bnot\\s+${escapeRegExp(label)}\\b`, "i").test(
            normalizedResult,
          )
        ) {
          return `Not ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
        }
        if (new RegExp(`\\b${escapeRegExp(label)}\\b`, "i").test(normalizedResult)) {
          return label;
        }
      }
      if (
        (fixture.type === "select" || fixture.type === "radio") &&
        typeof fixture.value === "string" &&
        fixture.value &&
        new RegExp(`\\b${escapeRegExp(fixture.value)}\\b`, "i").test(
          normalizedResult,
        )
      ) {
        return fixture.value;
      }
    }
  }
  return "";
}

function fixtureMatchScore(
  step: WorkflowAcceptanceStep,
  fixture: AcceptanceManifestFixture,
): number {
  const identityWords = words(`${step.accessibleName} ${step.controlId}`);
  const descriptionWords = words(step.description);
  const fixtureWords = words(
    `${fixture.entityName} ${fixture.entityKey} ${fixture.fieldKey} ${fixture.label}`,
  );
  let score = 0;
  for (const word of identityWords) if (fixtureWords.has(word)) score += 10;
  for (const word of descriptionWords) if (fixtureWords.has(word)) score += 2;
  const identity = normalizedPhrase(`${step.accessibleName} ${step.controlId}`);
  const label = normalizedPhrase(fixture.label);
  const fieldKey = normalizedPhrase(fixture.fieldKey);
  if (label && identity.includes(label)) score += 30;
  if (fieldKey && identity.includes(fieldKey)) score += 30;
  if (fixture.type === "text" || fixture.type === "long_text") score += 1;
  return score;
}

function fixtureExplicitlyMentioned(
  step: WorkflowAcceptanceStep,
  fixture: AcceptanceManifestFixture,
): boolean {
  const description = normalizedPhrase(step.description);
  const label = normalizedPhrase(fixture.label);
  const fieldKey = normalizedPhrase(fixture.fieldKey);
  return Boolean(
    (label && description.includes(label)) ||
      (fieldKey && description.includes(fieldKey)),
  );
}

function fixtureIntentionallyBlank(
  step: WorkflowAcceptanceStep,
  fixture: AcceptanceManifestFixture,
): boolean {
  const description = normalizedPhrase(step.description);
  const phrase = normalizedPhrase(fixture.label || fixture.fieldKey);
  if (!phrase) return false;
  return new RegExp(
    `\\b(?:leave|leaving|keep|keeping)\\s+(?:the\\s+)?${escapeRegExp(
      phrase,
    )}\\s+(?:empty|blank|unassigned|unselected)\\b`,
    "i",
  ).test(description);
}

function normalizedPhrase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function fixturesByEntity(
  fixtures: AcceptanceManifestFixture[],
): Map<string, AcceptanceManifestFixture[]> {
  const grouped = new Map<string, AcceptanceManifestFixture[]>();
  for (const fixture of fixtures) {
    const current = grouped.get(fixture.entityKey) ?? [];
    current.push(fixture);
    grouped.set(fixture.entityKey, current);
  }
  return grouped;
}

function bestEntityFixture(
  fixtures: AcceptanceManifestFixture[],
): AcceptanceManifestFixture | null {
  return (
    fixtures.find(
      (fixture) =>
        fixture.runScoped &&
        typeof fixture.value === "string" &&
        !String(fixture.value).startsWith("@"),
    ) ??
    fixtures.find(
      (fixture) =>
        typeof fixture.value === "string" &&
        !String(fixture.value).startsWith("@") &&
        !["date", "datetime", "file", "image"].includes(fixture.type),
    ) ??
    fixtures.find(
      (fixture) =>
        typeof fixture.value === "string" &&
        !String(fixture.value).startsWith("@"),
    ) ??
    fixtures[0] ??
    null
  );
}

function fixtureText(fixture?: AcceptanceManifestFixture | null): string {
  if (!fixture) return "";
  if (typeof fixture.value === "string" && !fixture.value.startsWith("@")) {
    return fixture.value;
  }
  if (typeof fixture.value === "number") return String(fixture.value);
  return "";
}

function fixtureId(
  journeyId: string,
  fixture: WorkflowAcceptanceFixture,
): string {
  return `fixture-${slugify(journeyId)}-${slugify(fixture.entityKey)}-${slugify(fixture.fieldKey)}`;
}

function isRunScopedFixture(fixture: WorkflowAcceptanceFixture): boolean {
  if (fixture.type === "file" || fixture.type === "image") return true;
  if (typeof fixture.value !== "string") return false;
  if (fixture.value.startsWith("@")) return false;
  return !["date", "datetime", "select"].includes(
    fixture.type,
  );
}

function splitDestructiveWorkflowJourneys(
  journeys: AcceptanceManifestJourney[],
): AcceptanceManifestJourney[] {
  return journeys.flatMap((journey) => {
    const workflowIds = uniqueStrings(
      journey.steps.map((step) => step.workflowId),
    );
    const groups: string[][] = [];
    let current: string[] = [];
    for (const [index, workflowId] of workflowIds.entries()) {
      current.push(workflowId);
      const deletesData = journey.saves.some(
        (save) =>
          save.workflowId === workflowId && save.operation === "delete",
      );
      if (deletesData && index < workflowIds.length - 1) {
        groups.push(current);
        current = [];
      }
    }
    if (current.length > 0) groups.push(current);
    if (groups.length <= 1) return [journey];

    return groups.map((workflowGroup, index) => {
      const selected = new Set(workflowGroup);
      const steps = journey.steps.filter((step) =>
        selected.has(step.workflowId),
      );
      return {
        ...journey,
        id: `${journey.id}-part-${index + 1}`,
        name: `${journey.name} (${index + 1}/${groups.length})`,
        sequence: journey.sequence + index / 100,
        dependsOnJourneyIds: [],
        startRoute: steps[0]?.route ?? journey.startRoute,
        fixtures: journey.fixtures.map((fixture) => ({ ...fixture })),
        steps,
        saves: journey.saves.filter((save) =>
          selected.has(save.workflowId),
        ),
        handoffs: journey.handoffs.filter((handoff) =>
          selected.has(handoff.consumerWorkflowId),
        ),
        roleChecks: journey.roleChecks.filter((roleCheck) =>
          selected.has(roleCheck.hiddenControl.workflowId),
        ),
        prerequisites: [],
        isolation: {
          ...journey.isolation,
          fixtureNamespace: `vf-${slugify(journey.id)}-part-${index + 1}`,
          prerequisiteJourneyIds: [],
          parallelBlockers: [],
        },
      } satisfies AcceptanceManifestJourney;
    });
  });
}

function finalizeJourneyIsolation(input: {
  journeys: AcceptanceManifestJourney[];
  architecture: ArchitecturePlan;
}): AcceptanceManifestJourney[] {
  const journeys = input.journeys.map((journey) => ({
    ...journey,
    fixtures: journey.fixtures.map((fixture) => ({ ...fixture })),
    handoffs: journey.handoffs.map((handoff) => ({
      ...handoff,
      consumerControl: handoff.consumerControl
        ? {
            ...handoff.consumerControl,
            recordScope: handoff.consumerControl.recordScope
              ? { ...handoff.consumerControl.recordScope }
              : null,
          }
        : null,
    })),
  }));
  const byId = new Map(journeys.map((journey) => [journey.id, journey]));
  const byWorkflow = new Map(
    journeys.flatMap((journey) =>
      uniqueStrings(journey.steps.map((step) => step.workflowId)).map(
        (workflowId) => [workflowId, journey] as const,
      ),
    ),
  );
  const contractById = new Map(
    input.architecture.workflowContracts.map((contract) => [contract.id, contract]),
  );
  const plannedHandoffs = journeys.flatMap((journey) =>
    journey.handoffs.map((handoff) => ({ handoff, originalJourney: journey })),
  );
  for (const journey of journeys) journey.handoffs = [];
  for (const planned of plannedHandoffs) {
    const producerJourney = byWorkflow.get(planned.handoff.producerWorkflowId);
    (producerJourney ?? planned.originalJourney).handoffs.push(planned.handoff);
  }

  for (const journey of journeys) {
    const prerequisiteWorkflowIds = requiredPrerequisiteWorkflowIds({
      journey,
      architecture: input.architecture,
      byWorkflow,
    });
    const prerequisiteJourneyIds = uniqueStrings(
      prerequisiteWorkflowIds.flatMap((workflowId) => {
        const prerequisite = byWorkflow.get(workflowId);
        return prerequisite && prerequisite.id !== journey.id
          ? [prerequisite.id]
          : [];
      }),
    ).sort((left, right) => {
      const leftJourney = byId.get(left);
      const rightJourney = byId.get(right);
      return (
        (leftJourney?.sequence ?? 0) - (rightJourney?.sequence ?? 0) ||
        left.localeCompare(right)
      );
    });
    const prerequisiteJourneys = prerequisiteJourneyIds.flatMap((id) => {
      const prerequisite = byId.get(id);
      return prerequisite ? [prerequisite] : [];
    });
    const availableFixtures = uniqueFixturesById([
      ...prerequisiteJourneys.flatMap((prerequisite) => prerequisite.fixtures),
      ...journey.fixtures,
    ]);
    for (const fixture of journey.fixtures) {
      if (!fixture.relationEntityKey) continue;
      const related = bestEntityFixture(
        availableFixtures.filter(
          (candidate) =>
            candidate.id !== fixture.id &&
            candidate.entityKey === fixture.relationEntityKey &&
            !candidate.relationEntityKey,
        ),
      );
      fixture.relationFixtureId = related?.id ?? null;
    }

    journey.handoffs = journey.handoffs.map((handoff) => {
      const producerJourney = byWorkflow.get(handoff.producerWorkflowId);
      const consumerJourney = byWorkflow.get(handoff.consumerWorkflowId);
      const consumerTargetStep = consumerJourney?.steps.find(
        (step) =>
          step.workflowId === handoff.consumerWorkflowId &&
          step.control?.controlId === handoff.consumerControl?.controlId,
      );
      const producerSave =
        producerJourney?.saves.find(
          (save) =>
            save.workflowId === handoff.producerWorkflowId &&
            save.stepId === handoff.fromStepId,
        ) ??
        producerJourney?.saves.find(
          (save) => save.workflowId === handoff.producerWorkflowId,
        );
      const producerFixture = producerSave
        ? bestEntityFixture(
            producerJourney?.fixtures.filter(
              (fixture) => fixture.entityKey === producerSave.entityKey,
            ) ?? [],
          )
        : null;
      if (!producerSave || !producerFixture) return handoff;
      const consumerScopeEntity = consumerTargetStep?.control?.recordScope?.entityKey;
      const consumerScopeFixture = consumerScopeEntity
        ? bestEntityFixture(
            availableFixtures.filter(
              (fixture) => fixture.entityKey === consumerScopeEntity,
            ),
          )
        : null;
      return {
        ...handoff,
        fixtureId: producerFixture.id,
        expectedText: fixtureText(producerFixture) || handoff.expectedText,
        expectedPresence: producerSave.operation !== "delete",
        consumerControl:
          producerSave.operation !== "delete" && handoff.consumerControl
          ? {
              ...handoff.consumerControl,
              recordScope: isRepeatedRecordControl(
                handoff.consumerControl.accessibleName,
                handoff.consumerControl.controlId,
              )
                ? {
                    entityKey: consumerScopeEntity ?? producerSave.entityKey,
                    fixtureId: consumerScopeFixture?.id ?? producerFixture.id,
                  }
                : null,
            }
          : null,
      };
    });

    const executionJourneys = [...prerequisiteJourneys, journey];
    const workflowIds = uniqueStrings(
      executionJourneys.flatMap((candidate) =>
        candidate.steps.map((step) => step.workflowId),
      ),
    );
    const platformServices = uniqueStrings(
      workflowIds.flatMap(
        (workflowId) =>
          contractById.get(workflowId)?.dependencies.platformServices ?? [],
      ),
    );
    const externalServices = platformServices.filter((service) =>
      ["ai", "email", "jobs", "integrations"].includes(service),
    );
    const adapterJourneys = executionJourneys.filter((candidate) =>
      candidate.steps.some((step) => step.primitive === "adapter"),
    );
    const parallelBlockers = uniqueStrings([
      ...externalServices.map((service) => `external service ${service}`),
      ...adapterJourneys.map(
        (candidate) => `app-specific adapter in ${candidate.id}`,
      ),
    ]);
    journey.prerequisites = prerequisiteJourneys.flatMap((prerequisite) => {
      const workflowIds = prerequisiteWorkflowIds.filter(
        (workflowId) => byWorkflow.get(workflowId)?.id === prerequisite.id,
      );
      if (workflowIds.length === 0) return [];
      const selected = new Set(workflowIds);
      const steps = prerequisite.steps.filter((step) =>
        selected.has(step.workflowId),
      );
      const saves = prerequisite.saves.filter((save) =>
        selected.has(save.workflowId),
      );
      const handoffs = prerequisite.handoffs.filter(
        (handoff) =>
          selected.has(handoff.producerWorkflowId) &&
          selected.has(handoff.consumerWorkflowId),
      );
      const entityKeys = uniqueStrings([
        ...saves.map((save) => save.entityKey),
        ...steps.flatMap((step) => [...step.reads, ...step.writes]),
      ]);
      return [
        {
          id: `setup-${slugify(journey.id)}-from-${slugify(prerequisite.id)}`,
          journeyId: prerequisite.id,
          workflowIds,
          storage: uniqueStorage([
            ...saves.map((save) => save.storage),
            ...handoffs.map((handoff) => handoff.storage),
          ]),
          entityKeys,
          fixtureIds: prerequisite.fixtures
            .filter((fixture) => entityKeys.includes(fixture.entityKey))
            .map((fixture) => fixture.id),
          setupStrategy: "visible_ui" as const,
        },
      ];
    });
    journey.isolation = {
      fixtureNamespace: `vf-${slugify(journey.componentId)}-${slugify(journey.id)}`,
      prerequisiteJourneyIds,
      browserLocalPrerequisitesRecreated: true,
      sharedDataNamespaced: true,
      parallelSafe: parallelBlockers.length === 0,
      parallelBlockers,
    };
  }
  return journeys;
}

function requiredPrerequisiteWorkflowIds(input: {
  journey: AcceptanceManifestJourney;
  architecture: ArchitecturePlan;
  byWorkflow: Map<string, AcceptanceManifestJourney>;
}): string[] {
  const contracts = input.architecture.workflowContracts;
  const contractById = new Map(contracts.map((contract) => [contract.id, contract]));
  const contractIndex = new Map(
    contracts.map((contract, index) => [contract.id, index]),
  );
  const targetIds = new Set(input.journey.steps.map((step) => step.workflowId));
  const selected = new Set<string>();
  const queue = [...targetIds];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const workflowId = queue.shift();
    if (!workflowId || visited.has(workflowId)) continue;
    visited.add(workflowId);
    const contract = contractById.get(workflowId);
    if (!contract) continue;
    const dependencyContracts = contract.dependencies.workflowIds.flatMap((id) => {
      const dependency = contractById.get(id);
      return dependency ? [dependency] : [];
    });
    const createdEntities = new Set(
      dependencyContracts.flatMap((dependency) =>
        dependency.expectedSaves
          .filter((save) => save.operation === "create")
          .map((save) => save.entityKey),
      ),
    );

    for (const dependency of dependencyContracts) {
      const saves = dependency.expectedSaves;
      const saveEntities = uniqueStrings(saves.map((save) => save.entityKey));
      const hasCreate = saves.some((save) => save.operation === "create");
      const hasUpdate = saves.some((save) => save.operation === "update");
      const hasDelete = saves.some((save) => save.operation === "delete");
      const coveredByCreate =
        saveEntities.length > 0 &&
        saveEntities.every((entityKey) => createdEntities.has(entityKey));
      const include =
        saves.length === 0 ||
        hasCreate ||
        (hasUpdate && !coveredByCreate) ||
        (hasDelete && destructiveStateRequired(contract, saveEntities));
      if (include) select(dependency.id);
    }

    for (const required of contract.requiredData.filter((data) =>
      data.operations.some((operation) =>
        ["read", "update", "delete"].includes(operation),
      ),
    )) {
      if (workflowCreatesEntity([...targetIds, ...selected], required.entityKey)) {
        continue;
      }
      const producer = contracts
        .filter(
          (candidate) =>
            candidate.id !== contract.id &&
            (contractIndex.get(candidate.id) ?? Number.MAX_SAFE_INTEGER) <
              (contractIndex.get(contract.id) ?? Number.MAX_SAFE_INTEGER) &&
            candidate.expectedSaves.some(
              (save) =>
                save.operation === "create" &&
                save.entityKey === required.entityKey,
            ),
        )
        .sort((left, right) => {
          const leftExplicit = contract.dependencies.workflowIds.includes(left.id)
            ? 0
            : 1;
          const rightExplicit = contract.dependencies.workflowIds.includes(right.id)
            ? 0
            : 1;
          return (
            leftExplicit - rightExplicit ||
            (contractIndex.get(right.id) ?? 0) -
              (contractIndex.get(left.id) ?? 0)
          );
        })[0];
      if (producer) select(producer.id);
    }
  }

  return [...selected].sort(
    (left, right) =>
      (contractIndex.get(left) ?? 0) - (contractIndex.get(right) ?? 0) ||
      left.localeCompare(right),
  );

  function select(workflowId: string) {
    if (targetIds.has(workflowId) || selected.has(workflowId)) return;
    if (input.byWorkflow.get(workflowId)?.id === input.journey.id) return;
    selected.add(workflowId);
    queue.push(workflowId);
  }

  function workflowCreatesEntity(
    workflowIds: Iterable<string>,
    entityKey: string,
  ): boolean {
    return [...workflowIds].some((id) =>
      contractById
        .get(id)
        ?.expectedSaves.some(
          (save) => save.operation === "create" && save.entityKey === entityKey,
        ),
    );
  }
}

function destructiveStateRequired(
  contract: ArchitecturePlan["workflowContracts"][number],
  entityKeys: string[],
): boolean {
  const text = [
    contract.name,
    contract.success.message,
    contract.success.visibleResult,
    ...contract.start.preconditions,
    ...contract.source.acceptanceCriteria,
    ...contract.source.testScenarios,
  ].join(" ");
  const restoring = /\b(restore|recover|undelete|undo deletion)\b/i.test(text);
  const destructive = /\b(delete|deleted|remove|removed|archive|archived)\b/i.test(
    text,
  );
  if (!restoring && !destructive) return false;
  return contract.requiredData.some(
    (data) =>
      entityKeys.includes(data.entityKey) &&
      (restoring
        ? data.operations.some((operation) =>
            ["read", "update"].includes(operation),
          )
        : data.operations.includes("delete")),
  );
}

function uniqueFixturesById(
  fixtures: AcceptanceManifestFixture[],
): AcceptanceManifestFixture[] {
  const seen = new Set<string>();
  return fixtures.filter((fixture) => {
    if (seen.has(fixture.id)) return false;
    seen.add(fixture.id);
    return true;
  });
}

function uniqueStorage(
  storage: Array<"localStorage" | "platformData" | "platformFiles">,
): Array<"localStorage" | "platformData" | "platformFiles"> {
  return [...new Set(storage)];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function acceptanceComponentIds(plan: WorkflowAcceptancePlan): Map<string, string> {
  const byId = new Map(plan.journeys.map((journey) => [journey.id, journey]));
  const roots = new Map<string, string>();
  const rootFor = (journeyId: string, seen = new Set<string>()): string => {
    if (roots.has(journeyId)) return roots.get(journeyId)!;
    if (seen.has(journeyId)) return journeyId;
    seen.add(journeyId);
    const journey = byId.get(journeyId);
    const dependency = journey?.dependsOnJourneyIds[0];
    const root = dependency ? rootFor(dependency, seen) : journeyId;
    roots.set(journeyId, root);
    return root;
  };
  for (const journey of plan.journeys) rootFor(journey.id);
  return new Map(
    plan.journeys.map((journey) => [
      journey.id,
      `component-${slugify(roots.get(journey.id) ?? journey.id)}`,
    ]),
  );
}

function mutationControlForRole(
  architecture: ArchitecturePlan,
  workflowId: string,
  role: WorkflowContractRole,
): { workflowId: string; controlId: string; accessibleName: string; route: string } | null {
  const linked = architecture.workflowContracts.find(
    (contract) => contract.id === workflowId,
  );
  const entityKeys = new Set(
    linked?.requiredData.map((data) => data.entityKey) ?? [],
  );
  const candidates = architecture.workflowContracts.filter(
    (contract) =>
      contract.expectedSaves.length > 0 &&
      !contract.actor.roles.includes(role) &&
      (entityKeys.size === 0 ||
        contract.requiredData.some((data) => entityKeys.has(data.entityKey))),
  );
  const orderedCandidates = [
    ...(linked &&
    linked.expectedSaves.length > 0 &&
    !linked.actor.roles.includes(role)
      ? [linked]
      : []),
    ...candidates.filter((contract) => contract.id !== linked?.id),
  ];
  for (const contract of orderedCandidates) {
    const saveStepIds = new Set(contract.expectedSaves.map((save) => save.stepId));
    const saveStep = contract.steps.find((candidate) =>
      saveStepIds.has(candidate.id),
    );
    const step = saveStep?.controlId
      ? saveStep
      : contract.steps.find((candidate) => candidate.controlId);
    const control = contract.controls.find(
      (candidate) => candidate.id === step?.controlId,
    );
    if (control) {
      return {
        workflowId: contract.id,
        controlId: control.id,
        accessibleName: control.accessibleName,
        route: control.route,
      };
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function preferredRole(
  roles: readonly WorkflowContractRole[],
): WorkflowContractRole {
  return (
    (["owner", "editor", "viewer", "public"] as const).find((role) =>
      roles.includes(role),
    ) ?? "public"
  );
}

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

function count(values: readonly string[], value: string): number {
  return values.filter((candidate) => candidate === value).length;
}

function duplicates(values: readonly string[]): string[] {
  return uniqueStrings(values.filter((value) => count(values, value) > 1));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
