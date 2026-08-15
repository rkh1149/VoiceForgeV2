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

export const ACCEPTANCE_MANIFEST_VERSION = 2 as const;
export const ACCEPTANCE_COMPILER_VERSION = 2 as const;

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
  entityKey: string;
  fixtureId: string | null;
  expectedPresence: boolean;
  expectedText: string;
};

export type AcceptanceManifestHandoff = {
  id: string;
  producerWorkflowId: string;
  consumerWorkflowId: string;
  consumerRoute: string;
  consumerControl: AcceptanceManifestControl | null;
  fixtureId: string | null;
  expectedText: string;
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

  const journeys = plan.journeys.map((journey) => {
    const fixtures = journey.fixtures.map((fixture) => ({
      ...fixture,
      id: fixtureId(journey.id, fixture),
      runScoped: isRunScopedFixture(fixture),
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
        entityKey: save.entityKey,
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
        consumerWorkflowId: handoff.consumerWorkflowId,
        consumerRoute: handoff.consumerRoute,
        consumerControl: handoff.consumerControlId
          ? {
              workflowId: handoff.consumerWorkflowId,
              controlId: handoff.consumerControlId,
              accessibleName: handoff.consumerAccessibleName,
              locatorMode,
              recordScope:
                producerSave && fixture
                  ? {
                      entityKey: producerSave.entityKey,
                      fixtureId: fixture.id,
                    }
                  : null,
            }
          : null,
        fixtureId: fixture?.id ?? null,
        expectedText: fixtureText(fixture) || handoff.produces,
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
    } satisfies AcceptanceManifestJourney;
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
  for (const journey of input.plan.journeys) {
    if (count(manifestJourneyIds, journey.id) !== 1) {
      blockingIssues.push(
        `acceptance_compiler: Journey ${journey.id} must appear exactly once in the acceptance manifest.`,
      );
      continue;
    }
    const compiled = input.manifest.journeys.find(
      (candidate) => candidate.id === journey.id,
    );
    if (!compiled) continue;
    for (const step of journey.steps) {
      if (
        compiled.steps.filter(
          (candidate) =>
            candidate.workflowId === step.workflowId &&
            candidate.contractStepId === step.contractStepId,
        ).length !== 1
      ) {
        blockingIssues.push(
          `acceptance_compiler: Step ${step.workflowId}/${step.contractStepId} must appear exactly once in ${journey.id}.`,
        );
      }
    }
    for (const save of journey.saves) {
      if (count(compiled.saves.map((candidate) => candidate.id), save.id) !== 1) {
        blockingIssues.push(
          `acceptance_compiler: Save ${save.id} must appear exactly once in ${journey.id}.`,
        );
      }
    }
    for (const handoff of journey.handoffs) {
      if (
        count(compiled.handoffs.map((candidate) => candidate.id), handoff.id) !== 1
      ) {
        blockingIssues.push(
          `acceptance_compiler: Handoff ${handoff.id} must appear exactly once in ${journey.id}.`,
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
  const primitive = primitiveForStep(input.step);
  const fixtures = fixturesForStep(input.step, input.fixtures, input.fixtureByEntity);
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
    assertionScope: assertionFixture
      ? {
          entityKey: assertionFixture.entityKey,
          fixtureId: assertionFixture.id,
        }
      : null,
    expectedRoute: input.step.route,
    expectedPresence: !deleteStep,
    adapterId,
  };
}

function primitiveForStep(step: WorkflowAcceptanceStep): AcceptancePrimitive {
  if (step.kind === "result" || step.kind === "automatic") {
    return "assert_visible";
  }
  if (step.kind === "navigate") return "navigate";
  if (step.kind === "input") {
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
        return "click";
      case null:
        return "adapter";
    }
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
  const entityFixtures = uniqueStrings([...step.writes, ...step.reads]).flatMap(
    (entityKey) => fixtureByEntity.get(entityKey) ?? [],
  );
  const candidates = entityFixtures.length > 0 ? entityFixtures : fixtures;
  if (step.controlKind === "form") return candidates;
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
  if (
    !/\b(edit|delete|remove|archive|complete|finish|reopen|mark|open|view)\b/i.test(
      `${step.description} ${step.accessibleName}`,
    )
  ) {
    return null;
  }
  for (const entityKey of [...step.reads, ...step.writes]) {
    const fixture = bestEntityFixture(fixtureByEntity.get(entityKey) ?? []);
    if (fixture) return fixture;
  }
  return null;
}

function assertionRecordFixture(
  step: WorkflowAcceptanceStep,
  fixtureByEntity: Map<string, AcceptanceManifestFixture[]>,
): AcceptanceManifestFixture | null {
  for (const entityKey of uniqueStrings([...step.writes, ...step.reads])) {
    const fixture = bestEntityFixture(fixtureByEntity.get(entityKey) ?? []);
    if (fixture) return fixture;
  }
  return null;
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
  const stepWords = words(
    `${step.description} ${step.accessibleName} ${step.controlId}`,
  );
  const fixtureWords = words(
    `${fixture.entityName} ${fixture.entityKey} ${fixture.fieldKey} ${fixture.label}`,
  );
  let score = 0;
  for (const word of stepWords) if (fixtureWords.has(word)) score += 2;
  if (fixture.type === "text" || fixture.type === "long_text") score += 1;
  return score;
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
  if (typeof fixture.value !== "string") return false;
  if (fixture.value.startsWith("@")) return false;
  return !["date", "datetime", "select", "file", "image"].includes(
    fixture.type,
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
