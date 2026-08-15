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
  type AcceptanceManifestRoleCheck,
  type AcceptanceManifestSave,
  type AcceptanceManifestStep,
  type VoiceForgeAcceptanceManifest,
} from "./acceptance-manifest";
import { synthesizeWorkflowAcceptancePlan } from "./workflow-acceptance-plan";

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
  summary: {
    components: number;
    journeys: number;
    stepsCompiled: number;
    savesCompiled: number;
    handoffsCompiled: number;
    adaptersRequired: number;
    adaptersResolved: number;
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
    blockingIssues: uniqueStrings([
      ...validation.blockingIssues,
      ...missingAdapters.map(
        (adapter) =>
          `acceptance_compiler: Required adapter ${adapter.id} is unresolved for ${adapter.workflowId}/${adapter.contractStepId}. Implement that exact quoted key in ${ACCEPTANCE_ADAPTERS_PATH} before browser tests begin.`,
      ),
    ]),
    warnings: validation.warnings,
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
    summary: {
      components: compiled.manifest.summary.components,
      journeys: compiled.manifest.summary.journeys,
      stepsCompiled: compiled.manifest.summary.steps,
      savesCompiled: compiled.manifest.summary.saves,
      handoffsCompiled: compiled.manifest.summary.handoffs,
      adaptersRequired: adapterRequirements.length,
      adaptersResolved,
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
  const componentIds = uniqueStrings(
    manifest.journeys.map((journey) => journey.componentId),
  );
  const components = componentIds
    .map((componentId) =>
      compileComponent(
        componentId,
        manifest.journeys.filter(
          (journey) => journey.componentId === componentId,
        ),
      ),
    )
    .join("\n\n");
  const imports = acceptanceRuntimeImports(manifest)
    .map((name) => `  ${name},`)
    .join("\n");
  const adapterImport = manifest.adapters.length > 0
    ? 'import { acceptanceAdapters } from "./voiceforge-acceptance-adapters";\n'
    : "";
  return `/**
 * LOCKED GENERATED FILE - deterministic Stage 14H acceptance test output.
 * Application-specific behavior belongs in voiceforge-acceptance-adapters.ts.
 */
import { test, expect } from "@playwright/test";
import {
${imports}
} from "../voiceforge-acceptance";
${adapterImport}import { voiceForgeAcceptanceManifest } from "./voiceforge-acceptance-manifest";

void voiceForgeAcceptanceManifest;

test.describe.serial("VoiceForge compiled workflow acceptance", () => {
${indent(components, 2)}
});
`;
}

function compileComponent(
  componentId: string,
  journeys: AcceptanceManifestJourney[],
): string {
  const ordered = [...journeys].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  const title = `[voiceforge-compiled-component:${componentId}] ${ordered
    .map((journey) => journey.name)
    .join(" -> ")}`;
  const needsGeolocation = ordered.some((journey) => journey.requiresGeolocation);
  const referencedFixtureIds = new Set(
    ordered.flatMap((journey) => [
      ...journey.steps.flatMap((step) => [
        ...(stepUsesFixtureValues(step) ? step.fixtureIds : []),
        ...(step.assertionFixtureId ? [step.assertionFixtureId] : []),
        ...(step.assertionScope ? [step.assertionScope.fixtureId] : []),
        ...(step.control?.recordScope
          ? [step.control.recordScope.fixtureId]
          : []),
      ]),
      ...journey.saves.flatMap((save) =>
        save.fixtureId ? [save.fixtureId] : [],
      ),
      ...journey.handoffs.flatMap((handoff) =>
        handoff.fixtureId ? [handoff.fixtureId] : [],
      ),
    ]),
  );
  const fixtures = uniqueFixtures(
    ordered
      .flatMap((journey) => journey.fixtures)
      .filter((fixture) => referencedFixtureIds.has(fixture.id)),
  );
  const fixtureNames = fixtureVariableNames(fixtures);
  const body = ordered
    .map((journey) => compileJourney(journey, fixtureNames))
    .join("\n");
  return `test(${JSON.stringify(title)}, async ({ page, context, browser, baseURL }) => {
  const runSuffix = acceptanceRunSuffix();
${indent(compileFixtureDeclarations(fixtures, fixtureNames), 2)}
  await context.setExtraHTTPHeaders(voiceForgeRoleHeaders(${JSON.stringify(
    preferredComponentRole(ordered),
  )}));
${
  needsGeolocation
    ? `  await context.grantPermissions(["geolocation"], { origin: baseURL ?? "http://localhost:4321" });
  await context.setGeolocation({ latitude: 43.6532, longitude: -79.3832 });\n`
    : ""
}${indent(body, 2)}
});`;
}

function compileJourney(
  journey: AcceptanceManifestJourney,
  fixtureNames: Map<string, string>,
): string {
  const body: string[] = [];
  const emittedSaves = new Set<string>();
  const emittedHandoffs = new Set<string>();
  const workflowIds = new Set(journey.steps.map((step) => step.workflowId));

  for (const handoff of journey.handoffs) {
    if (workflowIds.has(handoff.producerWorkflowId)) continue;
    body.push(compileHandoff(handoff, fixtureNames));
    emittedHandoffs.add(handoff.id);
  }

  journey.steps.forEach((step, index) => {
    body.push(compileStep(step, journey, fixtureNames));
    for (const save of journey.saves.filter(
      (candidate) =>
        candidate.workflowId === step.workflowId &&
        candidate.stepId === step.contractStepId,
    )) {
      body.push(compileSave(save, fixtureNames));
      emittedSaves.add(save.id);
    }
    const nextWorkflowId = journey.steps[index + 1]?.workflowId;
    if (nextWorkflowId === step.workflowId) return;
    for (const handoff of journey.handoffs.filter(
      (candidate) => candidate.producerWorkflowId === step.workflowId,
    )) {
      body.push(compileHandoff(handoff, fixtureNames));
      emittedHandoffs.add(handoff.id);
    }
  });

  for (const save of journey.saves) {
    if (!emittedSaves.has(save.id)) body.push(compileSave(save, fixtureNames));
  }
  for (const handoff of journey.handoffs) {
    if (!emittedHandoffs.has(handoff.id)) {
      body.push(compileHandoff(handoff, fixtureNames));
    }
  }
  journey.roleChecks.forEach((roleCheck, index) => {
    body.push(compileRoleCheck(roleCheck, index));
  });
  return `await test.step(workflowJourneyTitle(${JSON.stringify(
    journey.id,
  )}, ${JSON.stringify(journey.name)}), async () => {
  await page.goto(${JSON.stringify(journey.startRoute)});
  await expect(page).toHaveURL(${routeRegex(journey.startRoute)});
${indent(body.join("\n"), 2)}
});`;
}

function compileSave(
  save: AcceptanceManifestSave,
  fixtureNames: Map<string, string>,
): string {
  const fixture = save.fixtureId ? fixtureNames.get(save.fixtureId) : null;
  const expected = fixture ?? JSON.stringify(save.expectedText);
  const assertion = save.expectedPresence
    ? `await expect(page.locator("body")).toContainText(${expected});`
    : `await expect(page.locator("body")).not.toContainText(${expected});`;
  return `await test.step(workflowSaveTitle(${JSON.stringify(save.id)}), async () => {
  await page.reload();
  ${assertion}
});`;
}

function compileHandoff(
  handoff: AcceptanceManifestHandoff,
  fixtureNames: Map<string, string>,
): string {
  const fixture = handoff.fixtureId
    ? fixtureNames.get(handoff.fixtureId)
    : null;
  const expected = fixture ?? JSON.stringify(handoff.expectedText);
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
  return `await test.step(workflowHandoffTitle(${JSON.stringify(
    handoff.id,
  )}), async () => {
  await page.goto(${JSON.stringify(handoff.consumerRoute)});
  await expect(page).toHaveURL(${routeRegex(handoff.consumerRoute)});
  ${consumer}
  await expect(page.locator("body")).toContainText(${expected});
});`;
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
): string {
  const marker = `workflowStepTitle(${JSON.stringify(
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
      action = `await control.click();
${assertionForStep(step, fixtureNames)}`;
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
        ? `resolveAcceptanceControl(${recordName}, ${JSON.stringify(
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
    return `const ${controlName} = resolveAcceptanceControl(page, ${JSON.stringify(
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
  return fixtures
    .map((fixture) => {
      const name = fixtureNames.get(fixture.id)!;
      return `const ${name} = ${fixtureExpression(fixture)};`;
    })
    .join("\n");
}

function fixtureExpression(fixture: AcceptanceManifestFixture): string {
  if (fixture.runScoped && typeof fixture.value === "string") {
    if (/email/i.test(`${fixture.fieldKey} ${fixture.label}`)) {
      return `\`vf-\${runSuffix}@example.com\``;
    }
    return `${JSON.stringify(fixture.value)} + " " + runSuffix`;
  }
  if (fixture.type === "file" || fixture.type === "image") {
    return `\`voiceforge-\${runSuffix}.png\``;
  }
  return JSON.stringify(fixture.value);
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
  const controls = [
    ...steps.flatMap((step) => (step.control ? [step.control] : [])),
    ...manifest.journeys.flatMap((journey) =>
      journey.handoffs.flatMap((handoff) =>
        handoff.consumerControl ? [handoff.consumerControl] : [],
      ),
    ),
    ...manifest.journeys.flatMap((journey) =>
      journey.roleChecks.map((role) => role.hiddenControl),
    ),
  ];
  const names = new Set<string>([
    "acceptanceRunSuffix",
    "voiceForgeRoleHeaders",
    "workflowJourneyTitle",
    "workflowStepTitle",
  ]);
  if (controls.length > 0) {
    names.add("expectContractControl");
  }
  if (controls.some((control) => control.locatorMode === "contract")) {
    names.add("vfControl");
  }
  if (
    controls.some((control) =>
      control.locatorMode === "accessible_name_fallback",
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

function stepUsesFixtureValues(step: AcceptanceManifestStep): boolean {
  return ["fill", "complete_form", "select", "upload", "adapter"].includes(
    step.primitive,
  );
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
      "Compiled the workflow acceptance manifest into protected Playwright structure and retained only the app-specific adapter boundary.",
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
