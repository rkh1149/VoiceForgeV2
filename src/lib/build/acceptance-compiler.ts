import { createHash } from "crypto";
import type { ArchitecturePlan } from "../architecture";
import type { AppSpec } from "../spec";
import type { CodegenResult, GenerationPhaseResult } from "../agents/coder";
import type { FileOperation } from "../agents/file-tools";
import type { FileMap } from "./template";
import {
  ACCEPTANCE_COMPILER_VERSION,
  createAcceptanceTestManifest,
  validateAcceptanceTestManifest,
  type AcceptanceManifestControl,
  type AcceptanceManifestFixture,
  type AcceptanceManifestHandoff,
  type AcceptanceManifestJourney,
  type AcceptanceManifestPrerequisite,
  type AcceptanceManifestRoleCheck,
  type AcceptanceManifestSave,
  type AcceptanceManifestStep,
  type VoiceForgeAcceptanceManifest,
} from "./acceptance-manifest";
import { synthesizeWorkflowAcceptancePlan } from "./workflow-acceptance-plan";
import {
  analyzeFixtureIsolation,
  type FixtureIsolationReview,
} from "./fixture-isolation-review";

export const ACCEPTANCE_COMPILED_SPEC_PATH =
  "e2e/generated/voiceforge-compiled.spec.ts";
export const ACCEPTANCE_MANIFEST_SOURCE_PATH =
  "e2e/generated/voiceforge-acceptance-manifest.ts";
export const ACCEPTANCE_ADAPTERS_PATH =
  "e2e/generated/voiceforge-acceptance-adapters.ts";

export type AcceptanceCompilerLine = {
  kind: "journey" | "step" | "save" | "handoff" | "role";
  id: string;
  line: number;
};

export type CompiledAcceptanceTests = {
  manifest: VoiceForgeAcceptanceManifest;
  manifestSource: string;
  compiledSource: string;
  adapterSource: string;
  compilerHash: string;
  lineMap: AcceptanceCompilerLine[];
  isolationReview: FixtureIsolationReview;
  blockingIssues: string[];
  warnings: string[];
};

export type AcceptanceCompilerReview = {
  version: 1;
  compilerVersion: number;
  status: "verified" | "needs_repair";
  manifest: VoiceForgeAcceptanceManifest;
  compilerHash: string;
  expectedPaths: string[];
  lineMap: AcceptanceCompilerLine[];
  adapterRequirements: Array<{
    id: string;
    status: "resolved" | "missing";
  }>;
  isolationReview: FixtureIsolationReview;
  summary: {
    components: number;
    journeys: number;
    stepsCompiled: number;
    savesCompiled: number;
    handoffsCompiled: number;
    adaptersRequired: number;
    adaptersResolved: number;
    prerequisiteSetups: number;
    runScopedFixtures: number;
    parallelSafeJourneys: number;
  };
  warnings: string[];
  blockingIssues: string[];
};

export function compileAcceptanceTests(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  existingAdapterSource?: string;
  changeMode?: boolean;
}): CompiledAcceptanceTests {
  const manifest = createAcceptanceTestManifest({
    spec: input.spec,
    architecture: input.architecture,
    locatorMode: input.changeMode
      ? "accessible_name_fallback"
      : "contract",
  });
  const plan = synthesizeWorkflowAcceptancePlan(input.spec, input.architecture);
  const validation = validateAcceptanceTestManifest({ plan, manifest });
  const adapterSource =
    input.existingAdapterSource ?? defaultAcceptanceAdapterSource();
  const missingAdapters = missingAcceptanceAdapters(manifest, adapterSource);
  const manifestSource = acceptanceManifestSource(manifest);
  const compiledSource = acceptanceSpecSource(manifest);
  const isolationReview = analyzeFixtureIsolation({
    manifest,
    compiledSource,
  });
  const lineMap = acceptanceCompilerLineMap(compiledSource, manifest);
  const compilerHash = sourceHash(
    `${JSON.stringify(manifest)}\n${compiledSource}`,
  );
  return {
    manifest,
    manifestSource,
    compiledSource,
    adapterSource,
    compilerHash,
    lineMap,
    isolationReview,
    blockingIssues: uniqueStrings([
      ...validation.blockingIssues,
      ...isolationReview.blockingIssues,
      ...missingAdapters.map(
        (adapter) =>
          `acceptance_compiler: Required adapter ${adapter.id} is unresolved for ${adapter.workflowId}/${adapter.contractStepId}. Implement that exact quoted key in ${ACCEPTANCE_ADAPTERS_PATH} before browser tests begin.`,
      ),
    ]),
    warnings: uniqueStrings([
      ...validation.warnings,
      ...isolationReview.warnings,
    ]),
  };
}

export function applyDeterministicAcceptanceCompiler(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  files: FileMap;
  generated: CodegenResult;
  changeMode?: boolean;
}): CompiledAcceptanceTests {
  const compilation = compileAcceptanceTests({
    spec: input.spec,
    architecture: input.architecture,
    existingAdapterSource: input.files[ACCEPTANCE_ADAPTERS_PATH],
    changeMode: input.changeMode,
  });
  const deletedFiles = Object.keys(input.files).filter(
    (path) =>
      /^e2e\/generated\/.+\.spec\.tsx?$/.test(path) &&
      path !== ACCEPTANCE_COMPILED_SPEC_PATH,
  );
  for (const path of deletedFiles) delete input.files[path];
  input.files[ACCEPTANCE_MANIFEST_SOURCE_PATH] = compilation.manifestSource;
  input.files[ACCEPTANCE_COMPILED_SPEC_PATH] = compilation.compiledSource;
  input.files[ACCEPTANCE_ADAPTERS_PATH] = compilation.adapterSource;

  const filesWritten = [
    ACCEPTANCE_MANIFEST_SOURCE_PATH,
    ACCEPTANCE_COMPILED_SPEC_PATH,
    ACCEPTANCE_ADAPTERS_PATH,
  ];
  for (const path of deletedFiles) delete input.generated.files[path];
  input.generated.files[ACCEPTANCE_MANIFEST_SOURCE_PATH] =
    compilation.manifestSource;
  input.generated.files[ACCEPTANCE_COMPILED_SPEC_PATH] =
    compilation.compiledSource;
  input.generated.files[ACCEPTANCE_ADAPTERS_PATH] = compilation.adapterSource;
  input.generated.filesWritten = uniqueStrings([
    ...input.generated.filesWritten.filter((path) => !deletedFiles.includes(path)),
    ...filesWritten,
  ]);
  input.generated.deletedFiles = uniqueStrings([
    ...input.generated.deletedFiles,
    ...deletedFiles,
  ]).filter((path) => !filesWritten.includes(path));
  input.generated.operations.push(
    ...deletedFiles.map(
      (path): FileOperation => ({ operation: "delete", path }),
    ),
    ...filesWritten.map(
      (path): FileOperation => ({ operation: "write", path }),
    ),
  );
  input.generated.phases.push(compilerPhase({ filesWritten, deletedFiles }));
  input.generated.notes = [
    input.generated.notes,
    `Deterministic acceptance compiler v${ACCEPTANCE_COMPILER_VERSION}: ${compilation.manifest.summary.journeys} journey(s), ${compilation.manifest.summary.steps} step(s), and ${compilation.manifest.summary.adapterRequirements} adapter requirement(s).`,
  ]
    .filter(Boolean)
    .join("\n");
  return compilation;
}

export function refreshDeterministicAcceptanceCompiler(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  files: FileMap;
  generated: CodegenResult;
  changeMode?: boolean;
}): { compilation: CompiledAcceptanceTests; refreshedPaths: string[] } {
  const compilation = compileAcceptanceTests({
    spec: input.spec,
    architecture: input.architecture,
    existingAdapterSource: input.files[ACCEPTANCE_ADAPTERS_PATH],
    changeMode: input.changeMode,
  });
  const outputs: Array<[string, string]> = [
    [ACCEPTANCE_MANIFEST_SOURCE_PATH, compilation.manifestSource],
    [ACCEPTANCE_COMPILED_SPEC_PATH, compilation.compiledSource],
    [ACCEPTANCE_ADAPTERS_PATH, compilation.adapterSource],
  ];
  const refreshedPaths: string[] = [];
  for (const [filePath, source] of outputs) {
    if (input.files[filePath] !== source) refreshedPaths.push(filePath);
    input.files[filePath] = source;
    input.generated.files[filePath] = source;
  }
  input.generated.filesWritten = uniqueStrings([
    ...input.generated.filesWritten,
    ...outputs.map(([filePath]) => filePath),
  ]);
  return { compilation, refreshedPaths };
}

export function reviewAcceptanceCompiler(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  files: FileMap;
  changeMode?: boolean;
}): AcceptanceCompilerReview {
  const compiled = compileAcceptanceTests({
    spec: input.spec,
    architecture: input.architecture,
    existingAdapterSource: input.files[ACCEPTANCE_ADAPTERS_PATH],
    changeMode: input.changeMode,
  });
  const blockingIssues = [...compiled.blockingIssues];
  if (input.files[ACCEPTANCE_MANIFEST_SOURCE_PATH] !== compiled.manifestSource) {
    blockingIssues.push(
      `acceptance_compiler: ${ACCEPTANCE_MANIFEST_SOURCE_PATH} is missing or does not match the current workflow contract.`,
    );
  }
  if (input.files[ACCEPTANCE_COMPILED_SPEC_PATH] !== compiled.compiledSource) {
    blockingIssues.push(
      `acceptance_compiler: ${ACCEPTANCE_COMPILED_SPEC_PATH} is missing or was modified after deterministic compilation.`,
    );
  }
  const missing = new Set(
    missingAcceptanceAdapters(
      compiled.manifest,
      input.files[ACCEPTANCE_ADAPTERS_PATH] ?? "",
    ).map((adapter) => adapter.id),
  );
  const adapterRequirements = compiled.manifest.adapters.map((adapter) => ({
    id: adapter.id,
    status: missing.has(adapter.id) ? ("missing" as const) : ("resolved" as const),
  }));
  const adaptersResolved = adapterRequirements.filter(
    (adapter) => adapter.status === "resolved",
  ).length;
  return {
    version: 1,
    compilerVersion: ACCEPTANCE_COMPILER_VERSION,
    status: blockingIssues.length > 0 ? "needs_repair" : "verified",
    manifest: compiled.manifest,
    compilerHash: compiled.compilerHash,
    expectedPaths: [
      ACCEPTANCE_MANIFEST_SOURCE_PATH,
      ACCEPTANCE_COMPILED_SPEC_PATH,
      ACCEPTANCE_ADAPTERS_PATH,
    ],
    lineMap: compiled.lineMap,
    adapterRequirements,
    isolationReview: compiled.isolationReview,
    summary: {
      components: compiled.manifest.summary.components,
      journeys: compiled.manifest.summary.journeys,
      stepsCompiled: compiled.manifest.summary.steps,
      savesCompiled: compiled.manifest.summary.saves,
      handoffsCompiled: compiled.manifest.summary.handoffs,
      adaptersRequired: adapterRequirements.length,
      adaptersResolved,
      prerequisiteSetups: compiled.isolationReview.summary.prerequisiteSetups,
      runScopedFixtures: compiled.isolationReview.summary.runScopedFixtures,
      parallelSafeJourneys:
        compiled.isolationReview.summary.parallelSafeJourneys,
    },
    warnings: compiled.warnings,
    blockingIssues: uniqueStrings(blockingIssues),
  };
}

export function missingAcceptanceAdapters(
  manifest: VoiceForgeAcceptanceManifest,
  adapterSource: string,
) {
  return manifest.adapters.filter(
    (adapter) => !hasAdapterKey(adapterSource, adapter.id),
  );
}

export function defaultAcceptanceAdapterSource(): string {
  return `/**
 * Generated app-specific acceptance adapters.
 * VoiceForge compiles the test structure; add only explicitly required adapters.
 */
import type { VoiceForgeAcceptanceAdapters } from "../voiceforge-acceptance";

export const acceptanceAdapters = {} satisfies VoiceForgeAcceptanceAdapters;
`;
}

function acceptanceManifestSource(
  manifest: VoiceForgeAcceptanceManifest,
): string {
  return `/**
 * LOCKED GENERATED FILE - compiled by VoiceForge from the workflow contract.
 */
import type { VoiceForgeAcceptanceManifest } from "../voiceforge-acceptance";

export const voiceForgeAcceptanceManifest = ${JSON.stringify(manifest, null, 2)} as const satisfies VoiceForgeAcceptanceManifest;
`;
}

function acceptanceSpecSource(manifest: VoiceForgeAcceptanceManifest): string {
  const journeys = [...manifest.journeys]
    .sort(
      (left, right) =>
        left.componentId.localeCompare(right.componentId) ||
        left.sequence - right.sequence ||
        left.id.localeCompare(right.id),
    )
    .map((journey) => compileIsolatedJourneyTest(journey, manifest))
    .join("\n\n");
  const imports = acceptanceRuntimeImports(manifest)
    .map((name) => `  ${name},`)
    .join("\n");
  const adapterImport = manifest.adapters.length > 0
    ? 'import { acceptanceAdapters } from "./voiceforge-acceptance-adapters";\n'
    : "";
  return `/**
 * LOCKED GENERATED FILE - deterministic Stage 14I isolated acceptance output.
 * Application-specific behavior belongs in voiceforge-acceptance-adapters.ts.
 */
import { test, expect } from "@playwright/test";
import {
${imports}
} from "../voiceforge-acceptance";
${adapterImport}import { voiceForgeAcceptanceManifest } from "./voiceforge-acceptance-manifest";

void voiceForgeAcceptanceManifest;

test.describe("VoiceForge compiled workflow acceptance", () => {
${indent(journeys, 2)}
});
`;
}

function compileIsolatedJourneyTest(
  journey: AcceptanceManifestJourney,
  manifest: VoiceForgeAcceptanceManifest,
): string {
  const journeyById = new Map(
    manifest.journeys.map((candidate) => [candidate.id, candidate]),
  );
  const prerequisites = journey.prerequisites.flatMap((configuration) => {
    const prerequisite = journeyById.get(configuration.journeyId);
    return prerequisite ? [{ configuration, journey: prerequisite }] : [];
  });
  const executionJourneys = [
    ...prerequisites.map((prerequisite) => prerequisite.journey),
    journey,
  ];
  const title = [
    `[voiceforge-isolated-journey:${journey.id}]`,
    `[voiceforge-journey:${journey.id}]`,
    journey.isolation.parallelSafe ? "[voiceforge-parallel]" : "",
    journey.name,
  ]
    .filter(Boolean)
    .join(" ");
  const needsGeolocation = executionJourneys.some(
    (candidate) => candidate.requiresGeolocation,
  );
  const fixtures = uniqueFixtures(
    executionJourneys.flatMap((candidate) => candidate.fixtures),
  );
  const fixtureNames = fixtureVariableNames(fixtures);
  const setup = prerequisites
    .map((prerequisite) =>
      compilePrerequisiteSetup(
        journey,
        prerequisite.journey,
        prerequisite.configuration,
        fixtureNames,
        manifest,
      ),
    )
    .join("\n");
  return `test(${JSON.stringify(title)}, async ({ page, context, browser, baseURL }, testInfo) => {
  const runSuffix = acceptanceRunSuffix(testInfo, ${JSON.stringify(
    journey.isolation.fixtureNamespace,
  )});
${indent(compileFixtureDeclarations(fixtures, fixtureNames), 2)}
  await context.setExtraHTTPHeaders(voiceForgeIsolationHeaders(${JSON.stringify(
    preferredComponentRole(executionJourneys),
  )}, runSuffix));
${
  needsGeolocation
    ? `  await context.grantPermissions(["geolocation"], { origin: baseURL ?? "http://localhost:4321" });
  await context.setGeolocation({ latitude: 43.6532, longitude: -79.3832 });\n`
    : ""
}${indent(setup, 2)}
  acceptanceRetryProbe(testInfo, ${JSON.stringify(journey.id)});
${indent(compileJourney(journey, fixtureNames, manifest), 2)}
});`;
}

function compilePrerequisiteSetup(
  target: AcceptanceManifestJourney,
  prerequisite: AcceptanceManifestJourney,
  configuration: AcceptanceManifestPrerequisite,
  fixtureNames: Map<string, string>,
  manifest: VoiceForgeAcceptanceManifest,
): string {
  const body = compileJourneyActions(
    prerequisite,
    fixtureNames,
    {
      targetJourneyId: target.id,
      sourceJourneyId: prerequisite.id,
    },
    manifest,
    new Set(configuration.workflowIds),
  );
  return `await test.step(workflowFixtureSetupTitle(${JSON.stringify(
    target.id,
  )}, ${JSON.stringify(prerequisite.id)}), async () => {
  await page.goto(${JSON.stringify(prerequisite.startRoute)});
  await expect(page).toHaveURL(${routeRegex(prerequisite.startRoute)});
${indent(body, 2)}
});`;
}

type FixtureSetupMarker = {
  targetJourneyId: string;
  sourceJourneyId: string;
};

function compileJourney(
  journey: AcceptanceManifestJourney,
  fixtureNames: Map<string, string>,
  manifest: VoiceForgeAcceptanceManifest,
): string {
  const body = compileJourneyActions(journey, fixtureNames, null, manifest);
  return `await test.step(workflowJourneyTitle(${JSON.stringify(
    journey.id,
  )}, ${JSON.stringify(journey.name)}), async () => {
  await page.goto(${JSON.stringify(journey.startRoute)});
  await expect(page).toHaveURL(${routeRegex(journey.startRoute)});
${indent(body, 2)}
});`;
}

function compileJourneyActions(
  journey: AcceptanceManifestJourney,
  fixtureNames: Map<string, string>,
  setup: FixtureSetupMarker | null,
  manifest: VoiceForgeAcceptanceManifest,
  allowedWorkflowIds?: Set<string>,
): string {
  const body: string[] = [];
  const emittedSaves = new Set<string>();
  const emittedHandoffs = new Set<string>();
  const steps = journey.steps.filter(
    (step) => !allowedWorkflowIds || allowedWorkflowIds.has(step.workflowId),
  );
  const saves = journey.saves.filter(
    (save) => !allowedWorkflowIds || allowedWorkflowIds.has(save.workflowId),
  );
  const handoffs = journey.handoffs.filter(
    (handoff) =>
      !allowedWorkflowIds ||
      (allowedWorkflowIds.has(handoff.producerWorkflowId) &&
        allowedWorkflowIds.has(handoff.consumerWorkflowId)),
  );
  const workflowIds = new Set(steps.map((step) => step.workflowId));
  const handoffEmissionSteps = new Map(
    handoffs.map((handoff) => [
      handoff.id,
      handoffEmissionStepKey(handoff, journey, manifest, steps, saves),
    ]),
  );

  for (const handoff of handoffs) {
    if (workflowIds.has(handoff.producerWorkflowId)) continue;
    body.push(compileHandoff(handoff, manifest, fixtureNames, setup));
    emittedHandoffs.add(handoff.id);
  }

  steps.forEach((step, index) => {
    if (index === 0 || steps[index - 1]?.workflowId !== step.workflowId) {
      body.push(`await page.goto(${JSON.stringify(step.route)});
await expect(page).toHaveURL(${routeRegex(step.route)});`);
    }
    body.push(compileStep(step, journey, fixtureNames, setup));
    for (const save of saves.filter(
      (candidate) =>
        candidate.workflowId === step.workflowId &&
        candidate.stepId === step.contractStepId,
    )) {
      body.push(compileSave(save, fixtureNames, setup));
      emittedSaves.add(save.id);
    }
    for (const handoff of handoffs.filter(
      (candidate) =>
        handoffEmissionSteps.get(candidate.id) === stepKey(step) &&
        !emittedHandoffs.has(candidate.id),
    )) {
      body.push(compileHandoff(handoff, manifest, fixtureNames, setup));
      emittedHandoffs.add(handoff.id);
    }
  });

  for (const save of saves) {
    if (!emittedSaves.has(save.id)) {
      body.push(compileSave(save, fixtureNames, setup));
    }
  }
  for (const handoff of handoffs) {
    if (!emittedHandoffs.has(handoff.id)) {
      body.push(compileHandoff(handoff, manifest, fixtureNames, setup));
    }
  }
  if (!setup) {
    journey.roleChecks.forEach((roleCheck, index) => {
      body.push(compileRoleCheck(roleCheck, index));
    });
  }
  return body.join("\n");
}

function handoffEmissionStepKey(
  handoff: AcceptanceManifestHandoff,
  journey: AcceptanceManifestJourney,
  manifest: VoiceForgeAcceptanceManifest,
  steps: AcceptanceManifestStep[],
  saves: AcceptanceManifestSave[],
): string {
  let emissionIndex = steps.findIndex(
    (step) =>
      step.workflowId === handoff.producerWorkflowId &&
      step.contractStepId === handoff.fromStepId,
  );
  const consumerJourney = manifest.journeys.find((candidate) =>
    candidate.steps.some(
      (step) => step.workflowId === handoff.consumerWorkflowId,
    ),
  );
  const consumerSteps =
    consumerJourney?.steps.filter(
      (step) => step.workflowId === handoff.consumerWorkflowId,
    ) ?? [];
  const targetIndex = consumerSteps.findIndex(
    (step) => step.control?.controlId === handoff.consumerControl?.controlId,
  );
  const requiredRecordEntities = new Set(
    consumerSteps
      .slice(0, targetIndex >= 0 ? targetIndex + 1 : 0)
      .flatMap((step) =>
        step.control?.recordScope ? [step.control.recordScope.entityKey] : [],
      ),
  );
  const consumerStartIndex = steps.findIndex(
    (step) => step.workflowId === handoff.consumerWorkflowId,
  );
  const latestPrerequisiteIndex =
    consumerStartIndex >= 0 ? consumerStartIndex - 1 : steps.length - 1;
  for (const entityKey of requiredRecordEntities) {
    for (const save of saves.filter(
      (candidate) =>
        candidate.entityKey === entityKey && candidate.expectedPresence,
    )) {
      const saveIndex = steps.findIndex(
        (step) =>
          step.workflowId === save.workflowId &&
          step.contractStepId === save.stepId,
      );
      if (saveIndex <= latestPrerequisiteIndex) {
        emissionIndex = Math.max(emissionIndex, saveIndex);
      }
    }
  }
  const emissionStep = steps[Math.max(emissionIndex, 0)];
  return emissionStep ? stepKey(emissionStep) : "";
}

function stepKey(step: AcceptanceManifestStep): string {
  return `${step.workflowId}:${step.contractStepId}`;
}

function compileSave(
  save: AcceptanceManifestSave,
  fixtureNames: Map<string, string>,
  setup: FixtureSetupMarker | null,
): string {
  const fixture = save.fixtureId ? fixtureNames.get(save.fixtureId) : null;
  const expected = fixture ?? JSON.stringify(save.expectedText);
  const assertion = save.expectedPresence
    ? `await expect(page.locator("body")).toContainText(${expected});`
    : `await expect(page.locator("body")).not.toContainText(${expected});`;
  const marker = setup
    ? `workflowFixtureSaveTitle(${JSON.stringify(
        setup.targetJourneyId,
      )}, ${JSON.stringify(setup.sourceJourneyId)}, ${JSON.stringify(save.id)})`
    : `workflowSaveTitle(${JSON.stringify(save.id)})`;
  return `await test.step(${marker}, async () => {
  await page.reload();
  ${assertion}
});`;
}

function compileHandoff(
  handoff: AcceptanceManifestHandoff,
  manifest: VoiceForgeAcceptanceManifest,
  fixtureNames: Map<string, string>,
  setup: FixtureSetupMarker | null,
): string {
  const fixture = handoff.fixtureId
    ? fixtureNames.get(handoff.fixtureId)
    : null;
  const expected = fixture ?? JSON.stringify(handoff.expectedText);
  const assertion = handoff.expectedPresence
    ? `await expect(page.locator("body")).toContainText(${expected});`
    : `await expect(page.locator("body")).not.toContainText(${expected});`;
  const consumer = handoff.consumerControl
    ? `${compileControlDeclaration(
        handoff.consumerControl,
        fixtureNames,
        "consumer",
        "consumerRecord",
      )}
  await expectContractControl(consumer, ${JSON.stringify(
    handoff.consumerControl.accessibleName,
  )});`
    : "";
  const consumerJourney = manifest.journeys.find((journey) =>
    journey.steps.some(
      (step) => step.workflowId === handoff.consumerWorkflowId,
    ),
  );
  const revealPath = consumerJourney
    ? compileHandoffRevealPath(handoff, consumerJourney, fixtureNames)
    : "";
  const continuation = consumerJourney
    ? compileHandoffConsumerContinuation(
        handoff,
        consumerJourney,
        fixtureNames,
      )
    : "";
  const marker = setup
    ? `workflowFixtureHandoffTitle(${JSON.stringify(
        setup.targetJourneyId,
      )}, ${JSON.stringify(setup.sourceJourneyId)}, ${JSON.stringify(
        handoff.id,
      )})`
    : `workflowHandoffTitle(${JSON.stringify(handoff.id)})`;
  return `await test.step(${marker}, async () => {
  await page.goto(${JSON.stringify(handoff.consumerRoute)});
  await expect(page).toHaveURL(${routeRegex(handoff.consumerRoute)});
  ${revealPath}
  ${consumer}
  ${continuation}
  ${assertion}
});`;
}

function compileHandoffConsumerContinuation(
  handoff: AcceptanceManifestHandoff,
  journey: AcceptanceManifestJourney,
  fixtureNames: Map<string, string>,
): string {
  if (!handoff.consumerControl) return "";
  const consumerSteps = journey.steps.filter(
    (step) => step.workflowId === handoff.consumerWorkflowId,
  );
  const targetIndex = consumerSteps.findIndex(
    (step) => step.control?.controlId === handoff.consumerControl?.controlId,
  );
  const lines: string[] = [];
  const target = targetIndex >= 0 ? consumerSteps[targetIndex] : null;
  if (
    (target && isSafeHandoffNavigationStep(target)) ||
    isSafeStandaloneNavigationControl(handoff.consumerControl)
  ) {
    lines.push("await consumer.click();");
  }
  const seen = new Set<string>();
  for (const [index, step] of consumerSteps
    .slice(targetIndex >= 0 ? targetIndex + 1 : 0)
    .entries()) {
    if (!isSafeHandoffNavigationStep(step)) continue;
    if (!step.control) {
      lines.push(`await page.goto(${JSON.stringify(step.expectedRoute)});`);
      continue;
    }
    const key = `${step.control.workflowId}:${step.control.controlId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const controlName = `consumerPathControl${index}`;
    lines.push(
      compileControlDeclaration(
        step.control,
        fixtureNames,
        controlName,
        `consumerPathRecord${index}`,
      ),
      `await expectContractControl(${controlName}, ${JSON.stringify(
        step.control.accessibleName,
      )});`,
      `await ${controlName}.click();`,
    );
  }
  return lines.join("\n");
}

function isSafeStandaloneNavigationControl(
  control: AcceptanceManifestControl,
): boolean {
  const identity = `${control.controlId} ${control.accessibleName}`;
  return (
    /\b(nav|navigate|open|view|go|back|next|previous|screen|page)\b/i.test(
      identity.replaceAll("-", " "),
    ) &&
    !/\b(add|create|save|edit|update|delete|remove|archive|complete|finish|submit|confirm|cancel)\b/i.test(
      identity,
    )
  );
}

function isSafeHandoffNavigationStep(step: AcceptanceManifestStep): boolean {
  if (step.primitive !== "navigate") return false;
  if (!step.control) return true;
  return !/\b(save|update|delete|remove|archive|complete|finish|submit|confirm|cancel)\b/i.test(
    `${step.control.controlId} ${step.control.accessibleName}`,
  );
}

function compileHandoffRevealPath(
  handoff: AcceptanceManifestHandoff,
  journey: AcceptanceManifestJourney,
  fixtureNames: Map<string, string>,
): string {
  if (!handoff.consumerControl) return "";
  const consumerSteps = journey.steps.filter(
    (step) => step.workflowId === handoff.consumerWorkflowId,
  );
  const targetIndex = consumerSteps.findIndex(
    (step) => step.control?.controlId === handoff.consumerControl?.controlId,
  );
  if (targetIndex <= 0) return "";
  const seen = new Set<string>();
  return consumerSteps
    .slice(0, targetIndex)
    .flatMap((step, index) => {
      if (step.primitive === "navigate" && !step.control) {
        return [
          `await page.goto(${JSON.stringify(step.expectedRoute)});\nawait expect(page).toHaveURL(${routeRegex(step.expectedRoute)});`,
        ];
      }
      if (
        !step.control ||
        !["click", "navigate"].includes(step.primitive) ||
        seen.has(`${step.control.workflowId}:${step.control.controlId}`)
      ) {
        return [];
      }
      seen.add(`${step.control.workflowId}:${step.control.controlId}`);
      const controlName = `revealControl${index}`;
      return [
        `${compileControlDeclaration(
          step.control,
          fixtureNames,
          controlName,
          `revealRecord${index}`,
        )}\nawait expectContractControl(${controlName}, ${JSON.stringify(
          step.control.accessibleName,
        )});\nawait ${controlName}.click();`,
      ];
    })
    .join("\n");
}

function compileRoleCheck(
  roleCheck: AcceptanceManifestRoleCheck,
  index: number,
): string {
  const locator =
    roleCheck.hiddenControl.locatorMode === "accessible_name_fallback"
      ? `resolveAcceptanceControl(rolePage${index}, ${JSON.stringify(
          roleCheck.hiddenControl.workflowId,
        )}, ${JSON.stringify(roleCheck.hiddenControl.controlId)}, ${JSON.stringify(
          roleCheck.hiddenControl.accessibleName,
        )})`
      : `vfControl(rolePage${index}, ${JSON.stringify(
          roleCheck.hiddenControl.workflowId,
        )}, ${JSON.stringify(roleCheck.hiddenControl.controlId)})`;
  return `await test.step(${JSON.stringify(
    `[voiceforge-role:${roleCheck.id}] ${roleCheck.role} is read only`,
  )}, async () => {
  const roleContext${index} = await browser.newContext({
    baseURL: baseURL ?? "http://localhost:4321",
    extraHTTPHeaders: voiceForgeRoleHeaders(${JSON.stringify(roleCheck.role)}),
  });
  const rolePage${index} = await roleContext${index}.newPage();
  await rolePage${index}.goto(${JSON.stringify(roleCheck.route)});
  await expect(${locator}).toHaveCount(0);
  await roleContext${index}.close();
});`;
}

function compileStep(
  step: AcceptanceManifestStep,
  journey: AcceptanceManifestJourney,
  fixtureNames: Map<string, string>,
  setup: FixtureSetupMarker | null,
): string {
  const marker = setup
    ? `workflowFixtureStepTitle(${JSON.stringify(
        setup.targetJourneyId,
      )}, ${JSON.stringify(setup.sourceJourneyId)}, ${JSON.stringify(
        step.workflowId,
      )}, ${JSON.stringify(step.contractStepId)}, ${JSON.stringify(
        step.description,
      )})`
    : `workflowStepTitle(${JSON.stringify(
        step.workflowId,
      )}, ${JSON.stringify(step.contractStepId)}, ${JSON.stringify(
        step.description,
      )})`;
  const control = step.control
    ? compileControlDeclaration(step.control, fixtureNames)
    : "";
  const fixtures = step.fixtureIds
    .map((id) => fixtureNames.get(id))
    .filter((value): value is string => Boolean(value));
  const primaryFixture = fixtures[0] ?? JSON.stringify(step.expectedText);
  let action: string;
  switch (step.primitive) {
    case "navigate":
      action = step.control
        ? `await control.click();
await expect(page).toHaveURL(${routeRegex(step.expectedRoute)});`
        : `await page.goto(${JSON.stringify(step.expectedRoute)});
await expect(page).toHaveURL(${routeRegex(step.expectedRoute)});`;
      break;
    case "fill":
      action = `await control.fill(String(${primaryFixture}));
await expect(control).toHaveValue(String(${primaryFixture}));`;
      break;
    case "complete_form":
      action = `await completeAcceptanceForm(page, control, ${fixtureArray(
        step,
        journey,
        fixtureNames,
      )});
await expect(control).toBeVisible();`;
      break;
    case "select":
      action = `await selectAcceptanceOption(control, ${primaryFixture});
await expect(control).not.toHaveValue("");`;
      break;
    case "check":
      action = `await control.check();
await expect(control).toBeChecked();`;
      break;
    case "upload":
      action = `await control.setInputFiles(tinyPngUpload(String(${primaryFixture})));
await expect(control).toHaveValue(/.+/);`;
      break;
    case "download":
      action = `const downloadPromise = page.waitForEvent("download");
await control.click();
const download = await downloadPromise;
await expectDownloadedFile(download, /.+/);`;
      break;
    case "assert_visible":
      action = assertionForStep(step, fixtureNames);
      break;
    case "adapter":
      action = `await runAcceptanceAdapter(acceptanceAdapters, ${JSON.stringify(
        step.adapterId,
      )}, {
  page,
  context,
  control: ${step.control ? "control" : "null"},
  fixtures: ${fixtureRecord(step, fixtureNames)},
  step: ${JSON.stringify({
    journeyId: journey.id,
    workflowId: step.workflowId,
    contractStepId: step.contractStepId,
    description: step.description,
  })},
});
${assertionForStep(step, fixtureNames)}`;
      break;
    case "click":
    default:
      action = step.control
        ? `await control.click();
${assertionForStep(step, fixtureNames)}`
        : assertionForStep(step, fixtureNames);
      break;
  }
  const accessible = step.control?.accessibleName
    ? `await expectContractControl(control, ${JSON.stringify(
        step.control.accessibleName,
      )});\n`
    : "";
  return `await test.step(${marker}, async () => {
${indent(control, 2)}
${indent(accessible + action, 2)}
});`;
}

function compileControlDeclaration(
  control: AcceptanceManifestControl,
  fixtureNames: Map<string, string>,
  controlName = "control",
  recordName = "record",
): string {
  if (control.recordScope) {
    const fixture =
      fixtureNames.get(control.recordScope.fixtureId) ?? JSON.stringify("");
    const locator =
      control.locatorMode === "accessible_name_fallback"
        ? `await resolveUniqueAcceptanceControl(${recordName}, ${JSON.stringify(
            control.workflowId,
          )}, ${JSON.stringify(control.controlId)}, ${JSON.stringify(
            control.accessibleName,
          )})`
        : `vfRecordControl(${recordName}, ${JSON.stringify(
            control.workflowId,
          )}, ${JSON.stringify(control.controlId)})`;
    return `const ${recordName} = vfRecords(page, ${JSON.stringify(
      control.recordScope.entityKey,
    )}).filter({ hasText: String(${fixture}) }).first();
const ${controlName} = ${locator};`;
  }
  if (control.locatorMode === "accessible_name_fallback") {
    return `const ${controlName} = await resolveUniqueAcceptanceControl(page, ${JSON.stringify(
      control.workflowId,
    )}, ${JSON.stringify(control.controlId)}, ${JSON.stringify(
      control.accessibleName,
    )});`;
  }
  return `const ${controlName} = vfControl(page, ${JSON.stringify(
    control.workflowId,
  )}, ${JSON.stringify(control.controlId)});`;
}

function assertionForStep(
  step: AcceptanceManifestStep,
  fixtureNames: Map<string, string>,
): string {
  const assertionFixture = step.assertionFixtureId
    ? fixtureNames.get(step.assertionFixtureId)
    : null;
  const expected = step.assertionText
    ? JSON.stringify(step.assertionText)
    : assertionFixture;
  if (step.assertionScope) {
    const scopeFixture =
      fixtureNames.get(step.assertionScope.fixtureId) ?? JSON.stringify("");
    const records = `vfRecords(page, ${JSON.stringify(
      step.assertionScope.entityKey,
    )}).filter({ hasText: String(${scopeFixture}) })`;
    if (!step.expectedPresence) return `await expect(${records}).toHaveCount(0);`;
    const record = `${records}.first()`;
    return expected
      ? `await expect(${record}).toBeVisible();\nawait expect(${record}).toContainText(${expected});`
      : `await expect(${record}).toBeVisible();`;
  }
  if (!expected) return 'await expect(page.locator("body")).toBeVisible();';
  return step.expectedPresence
    ? `await expect(page.locator("body")).toContainText(${expected});`
    : `await expect(page.locator("body")).not.toContainText(${expected});`;
}

function fixtureArray(
  step: AcceptanceManifestStep,
  journey: AcceptanceManifestJourney,
  fixtureNames: Map<string, string>,
): string {
  const fixtures = step.fixtureIds
    .map((id) => journey.fixtures.find((fixture) => fixture.id === id))
    .filter((fixture): fixture is AcceptanceManifestFixture => Boolean(fixture));
  return `[${fixtures
    .map((fixture) => {
      const variable = fixtureNames.get(fixture.id) ?? "undefined";
      return `{ id: ${JSON.stringify(fixture.id)}, label: ${JSON.stringify(
        fixture.label,
      )}, type: ${JSON.stringify(fixture.type)}, value: ${variable} }`;
    })
    .join(", ")}]`;
}

function fixtureRecord(
  step: AcceptanceManifestStep,
  fixtureNames: Map<string, string>,
): string {
  return `{ ${step.fixtureIds
    .map(
      (id) =>
        `${JSON.stringify(id)}: ${fixtureNames.get(id) ?? "undefined"}`,
    )
    .join(", ")} }`;
}

function compileFixtureDeclarations(
  fixtures: AcceptanceManifestFixture[],
  fixtureNames: Map<string, string>,
): string {
  if (fixtures.length === 0) return "void runSuffix;";
  return orderRelationFixtures(fixtures)
    .map((fixture) => {
      const name = fixtureNames.get(fixture.id)!;
      return `const ${name} = ${fixtureExpression(fixture, fixtureNames)};`;
    })
    .join("\n");
}

function fixtureExpression(
  fixture: AcceptanceManifestFixture,
  fixtureNames: Map<string, string>,
): string {
  if (fixture.relationFixtureId) {
    return fixtureNames.get(fixture.relationFixtureId) ?? JSON.stringify(fixture.value);
  }
  if (fixture.type === "file" || fixture.type === "image") {
    return `\`voiceforge-\${runSuffix}.png\``;
  }
  if (fixture.runScoped && typeof fixture.value === "string") {
    if (/email/i.test(`${fixture.fieldKey} ${fixture.label}`)) {
      return `\`vf-\${runSuffix}@example.com\``;
    }
    return `${JSON.stringify(fixture.value)} + " " + runSuffix`;
  }
  return JSON.stringify(fixture.value);
}

function orderRelationFixtures(
  fixtures: AcceptanceManifestFixture[],
): AcceptanceManifestFixture[] {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const ordered: AcceptanceManifestFixture[] = [];
  const visited = new Set<string>();
  const visit = (fixture: AcceptanceManifestFixture, active: Set<string>) => {
    if (visited.has(fixture.id) || active.has(fixture.id)) return;
    const nextActive = new Set(active).add(fixture.id);
    const relation = fixture.relationFixtureId
      ? byId.get(fixture.relationFixtureId)
      : null;
    if (relation) visit(relation, nextActive);
    visited.add(fixture.id);
    ordered.push(fixture);
  };
  fixtures.forEach((fixture) => visit(fixture, new Set()));
  return ordered;
}

function fixtureVariableNames(
  fixtures: AcceptanceManifestFixture[],
): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const fixture of fixtures) {
    const base = `fixture_${identifier(fixture.entityKey)}_${identifier(
      fixture.fieldKey,
    )}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}_${suffix++}`;
    used.add(name);
    names.set(fixture.id, name);
  }
  return names;
}

function uniqueFixtures(
  fixtures: AcceptanceManifestFixture[],
): AcceptanceManifestFixture[] {
  const seen = new Set<string>();
  return fixtures.filter((fixture) => {
    if (seen.has(fixture.id)) return false;
    seen.add(fixture.id);
    return true;
  });
}

function preferredComponentRole(
  journeys: AcceptanceManifestJourney[],
): "owner" | "editor" | "viewer" | "public" {
  const roles = journeys.map((journey) => journey.executionRole);
  return (
    (["owner", "editor", "viewer", "public"] as const).find((role) =>
      roles.includes(role),
    ) ?? "public"
  );
}

function acceptanceRuntimeImports(
  manifest: VoiceForgeAcceptanceManifest,
): string[] {
  const steps = manifest.journeys.flatMap((journey) => journey.steps);
  const interactionControls = [
    ...steps.flatMap((step) => (step.control ? [step.control] : [])),
    ...manifest.journeys.flatMap((journey) =>
      journey.handoffs.flatMap((handoff) =>
        handoff.consumerControl ? [handoff.consumerControl] : [],
      ),
    ),
  ];
  const roleControls = manifest.journeys.flatMap((journey) =>
    journey.roleChecks.map((role) => role.hiddenControl),
  );
  const controls = [...interactionControls, ...roleControls];
  const names = new Set<string>([
    "acceptanceRetryProbe",
    "acceptanceRunSuffix",
    "voiceForgeRoleHeaders",
    "voiceForgeIsolationHeaders",
    "workflowJourneyTitle",
    "workflowStepTitle",
  ]);
  if (manifest.journeys.some((journey) => journey.prerequisites.length > 0)) {
    names.add("workflowFixtureSetupTitle");
    names.add("workflowFixtureStepTitle");
    names.add("workflowFixtureSaveTitle");
    names.add("workflowFixtureHandoffTitle");
  }
  if (controls.length > 0) {
    names.add("expectContractControl");
  }
  if (controls.some((control) => control.locatorMode === "contract")) {
    names.add("vfControl");
  }
  if (
    interactionControls.some((control) =>
      control.locatorMode === "accessible_name_fallback",
    )
  ) {
    names.add("resolveUniqueAcceptanceControl");
  }
  if (
    roleControls.some(
      (control) => control.locatorMode === "accessible_name_fallback",
    )
  ) {
    names.add("resolveAcceptanceControl");
  }
  if (
    controls.some(
      (control) => control.recordScope && control.locatorMode === "contract",
    )
  ) {
    names.add("vfRecordControl");
  }
  if (
    controls.some((control) => control.recordScope) ||
    steps.some((step) => step.assertionScope)
  ) {
    names.add("vfRecords");
  }
  if (steps.some((step) => step.primitive === "complete_form")) {
    names.add("completeAcceptanceForm");
  }
  if (steps.some((step) => step.primitive === "select")) {
    names.add("selectAcceptanceOption");
  }
  if (steps.some((step) => step.primitive === "upload")) {
    names.add("tinyPngUpload");
  }
  if (steps.some((step) => step.primitive === "download")) {
    names.add("expectDownloadedFile");
  }
  if (steps.some((step) => step.primitive === "adapter")) {
    names.add("runAcceptanceAdapter");
  }
  if (manifest.journeys.some((journey) => journey.saves.length > 0)) {
    names.add("workflowSaveTitle");
  }
  if (manifest.journeys.some((journey) => journey.handoffs.length > 0)) {
    names.add("workflowHandoffTitle");
  }
  return [...names].sort();
}

function compilerPhase(input: {
  filesWritten: string[];
  deletedFiles: string[];
}): GenerationPhaseResult {
  return {
    id: "deterministic-acceptance-compiler",
    label: "Deterministic acceptance compiler",
    agentKey: "acceptance_compiler",
    filesWritten: input.filesWritten,
    filesDeleted: input.deletedFiles,
    notes:
      "Compiled each workflow journey with visible prerequisite setup, per-attempt fixture namespaces, retry validation, and a protected app-specific adapter boundary.",
    turnContinuations: 0,
    turnLimit: 0,
  };
}

function acceptanceCompilerLineMap(
  source: string,
  manifest: VoiceForgeAcceptanceManifest,
): AcceptanceCompilerLine[] {
  const lines: AcceptanceCompilerLine[] = [];
  for (const journey of manifest.journeys) {
    addLine(lines, source, "journey", journey.id, `workflowJourneyTitle(${JSON.stringify(journey.id)}`);
    for (const step of journey.steps) {
      addLine(
        lines,
        source,
        "step",
        `${step.workflowId}/${step.contractStepId}`,
        `workflowStepTitle(${JSON.stringify(step.workflowId)}, ${JSON.stringify(step.contractStepId)}`,
      );
    }
    for (const save of journey.saves) {
      addLine(lines, source, "save", save.id, `workflowSaveTitle(${JSON.stringify(save.id)})`);
    }
    for (const handoff of journey.handoffs) {
      addLine(
        lines,
        source,
        "handoff",
        handoff.id,
        `workflowHandoffTitle(${JSON.stringify(handoff.id)})`,
      );
    }
    for (const role of journey.roleChecks) {
      addLine(lines, source, "role", role.id, `[voiceforge-role:${role.id}]`);
    }
  }
  return lines;
}

function addLine(
  lines: AcceptanceCompilerLine[],
  source: string,
  kind: AcceptanceCompilerLine["kind"],
  id: string,
  needle: string,
): void {
  const index = source.indexOf(needle);
  if (index < 0) return;
  lines.push({
    kind,
    id,
    line: source.slice(0, index).split("\n").length,
  });
}

function hasAdapterKey(source: string, adapterId: string): boolean {
  const escaped = escapeRegExp(adapterId);
  return new RegExp(`["']${escaped}["']\\s*:`).test(source);
}

function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function routeRegex(route: string): string {
  const normalized = route === "/" ? "/" : route.replace(/\/+$/, "");
  const escaped = normalized
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("/", "\\/");
  return `/${escaped}(?:[?#].*)?$/`;
}

function identifier(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_$]+/g, "_");
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `_${normalized}`;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : line))
    .join("\n");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
