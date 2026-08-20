import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import {
  computeSpecComplexity,
  normalizeAppSpec,
  type AppSpec,
} from "../spec";
import { GOLDEN_REGRESSION_SPECS } from "./golden-regression-specs";
import { analyzeGeneratedAcceptanceTests } from "./acceptance-test-review";
import {
  ACCEPTANCE_ADAPTERS_PATH,
  ACCEPTANCE_COMPILED_SPEC_PATH,
  ACCEPTANCE_MANIFEST_SOURCE_PATH,
  compileAcceptanceTests,
} from "./acceptance-compiler";
import {
  extractAcceptanceTraceCalls,
  findAcceptanceTraceCall,
} from "./acceptance-trace-parser";
import {
  synthesizeWorkflowAcceptancePlan,
  type WorkflowAcceptanceJourney,
  type WorkflowAcceptanceStep,
} from "./workflow-acceptance-plan";

function sharedApp() {
  const spec = GOLDEN_REGRESSION_SPECS.find(
    (golden) => golden.id === "shared-platform-data",
  )!.spec;
  const architecture = createFallbackArchitecturePlan(
    spec,
    computeSpecComplexity(spec),
  );
  return { spec, architecture };
}

function builtInStoryApp() {
  const base = normalizeAppSpec({
    appName: "Story Sprout",
    purpose: "Play a built-in illustrated story without saving progress.",
    targetUsers: "A young child",
    screens: [
      { name: "Story Garden", description: "Choose a built-in story cover." },
    ],
    features: ["Choose a story"],
    dataToStore: [],
    needsLogin: false,
    sharingModel: "private" as const,
    aiFeatures: [],
    testPlan: ["A story cover opens its illustrated first page"],
    deploymentNotes: "",
  });
  const spec: AppSpec = {
    ...base,
    dataEntities: [
      {
        name: "Story",
        description: "A built-in illustrated story.",
        ownership: "system",
        fields: [
          {
            name: "title",
            label: "Story title",
            type: "text",
            required: true,
            validation: "Required",
          },
          {
            name: "coverImage",
            label: "Cover picture",
            type: "image",
            required: true,
            validation: "Built in",
          },
        ],
        relationships: [],
      },
    ],
    workflows: [
      {
        name: "Choose a story",
        actor: "Child",
        trigger: "The child opens Story Sprout.",
        steps: [
          "Child taps a story cover.",
          "The illustrated first page appears.",
        ],
        successOutcome: "The built-in story is ready to play.",
        failureStates: [],
      },
    ],
  };
  const architecture = createFallbackArchitecturePlan(
    spec,
    computeSpecComplexity(spec),
  );
  return { spec, architecture };
}

function compliantTest(journey: WorkflowAcceptanceJourney): string {
  const fixture = journey.fixtures.find(
    (candidate) =>
      typeof candidate.value === "string" &&
      !String(candidate.value).startsWith("@"),
  );
  const fixtureValue = String(fixture?.value ?? "VoiceForge acceptance record");
  const stepBlocks = journey.steps
    .map((step) => stepBlock(step, fixtureValue))
    .join("\n");
  const saveBlocks = journey.saves
    .map(
      (save) => `await test.step(workflowSaveTitle(${JSON.stringify(save.id)}), async () => {
  await page.reload();
  await expect(page.getByText(${JSON.stringify(fixtureValue)})).toBeVisible();
});`,
    )
    .join("\n");
  const handoffBlocks = journey.handoffs
    .map(
      (handoff) => `await test.step(workflowHandoffTitle(${JSON.stringify(handoff.id)}), async () => {
  await page.goto(${JSON.stringify(handoff.consumerRoute)});
  await expect(page.getByText(${JSON.stringify(fixtureValue)})).toBeVisible();
});`,
    )
    .join("\n");
  const roleBlocks = journey.roleScenarios
    .flatMap((scenario) =>
      scenario.readOnlyRoles.map(
        (role) => `const ${role}Context = await browser.newContext({ extraHTTPHeaders: voiceForgeRoleHeaders(${JSON.stringify(role)}) });
const ${role}Page = await ${role}Context.newPage();
await ${role}Page.goto(${JSON.stringify(journey.startRoute)});
await expect(${role}Page.getByRole("button", { name: ${JSON.stringify(scenario.visibleControlNames[0] ?? "Save record")} })).not.toBeVisible();
await ${role}Context.close();`,
      ),
    )
    .join("\n");

  return `import { test, expect } from "@playwright/test";
import { workflowJourneyTitle, workflowStepTitle, workflowSaveTitle, workflowHandoffTitle, voiceForgeRoleHeaders } from "../voiceforge-acceptance";
test(workflowJourneyTitle(${JSON.stringify(journey.id)}, ${JSON.stringify(journey.name)}), async ({ page, browser }) => {
  const fixture = ${JSON.stringify(fixtureValue)};
  void fixture;
  await page.goto(${JSON.stringify(journey.startRoute)});
  ${stepBlocks}
  ${saveBlocks}
  ${handoffBlocks}
  ${roleBlocks}
});`;
}

function stepBlock(step: WorkflowAcceptanceStep, fixture: string): string {
  const marker = `workflowStepTitle(${JSON.stringify(step.workflowId)}, ${JSON.stringify(step.contractStepId)}, ${JSON.stringify(step.description)})`;
  if (step.kind === "navigate") {
    return step.accessibleName
      ? `await test.step(${marker}, async () => { await page.getByRole("link", { name: ${JSON.stringify(step.accessibleName)} }).click(); await expect(page).toHaveURL(${JSON.stringify(step.route)}); });`
      : `await test.step(${marker}, async () => { await page.goto(${JSON.stringify(step.route)}); await expect(page).toHaveURL(${JSON.stringify(step.route)}); });`;
  }
  if (step.kind === "input") {
    return `await test.step(${marker}, async () => { await page.getByLabel(${JSON.stringify(step.accessibleName)}).fill(${JSON.stringify(fixture)}); });`;
  }
  if (step.kind === "result" || step.kind === "automatic") {
    return `await test.step(${marker}, async () => { await expect(page.getByText(${JSON.stringify(step.visibleResult || fixture)})).toBeVisible(); });`;
  }
  return `await test.step(${marker}, async () => { await page.getByRole("button", { name: ${JSON.stringify(step.accessibleName)} }).click(); });`;
}

describe("generated acceptance test review", () => {
  it("verifies a traceable UI journey with save refresh and viewer proof", () => {
    const { spec, architecture } = sharedApp();
    const plan = synthesizeWorkflowAcceptancePlan(spec, architecture);
    const source = compliantTest(plan.journeys[0]);
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues).toEqual([]);
    expect(review.summary.journeysVerified).toBe(1);
    expect(review.summary.stepsVerified).toBe(review.summary.stepsRequired);
    expect(review.summary.refreshChecksVerified).toBe(
      review.summary.refreshChecksRequired,
    );
    expect(review.summary.roleScenariosVerified).toBe(
      review.summary.roleScenariosRequired,
    );
  });

  it("does not require an upload for a read-only built-in illustration", () => {
    const { spec, architecture } = builtInStoryApp();
    const plan = synthesizeWorkflowAcceptancePlan(spec, architecture);
    const journey = plan.journeys[0];
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: {
        "e2e/generated/story-journey.spec.ts": compliantTest(journey),
      },
    });

    expect(journey.fixtures.some((fixture) => fixture.type === "image")).toBe(
      true,
    );
    expect(review.blockingIssues.join(" ")).not.toContain(
      "includes a file/image workflow",
    );
  });

  it("accepts a visual selection performed by clicking a card", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    const inputStep = journey.steps.find((step) => step.kind === "input")!;
    const contract = architecture.workflowContracts.find(
      (candidate) => candidate.id === inputStep.workflowId,
    )!;
    const contractStep = contract.steps.find(
      (candidate) => candidate.id === inputStep.contractStepId,
    )!;
    const control = contract.controls.find(
      (candidate) => candidate.id === contractStep.controlId,
    )!;
    control.kind = "button";
    inputStep.controlKind = "button";
    const source = compliantTest(journey).replace(
      /await page\.getByLabel\([^;]+?\)\.fill\([^;]+?\);/,
      `await page.getByRole("button", { name: ${JSON.stringify(inputStep.accessibleName)} }).click();`,
    );
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/card-selection.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).not.toContain(
      `labels ${inputStep.contractStepId} but does not perform`,
    );
  });

  it("recognizes trace helpers that use aliases and statically declared ids", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    const source = compliantTest(journey)
      .replace(
        "workflowJourneyTitle,",
        "workflowJourneyTitle as journeyTitle,",
      )
      .replace(
        `test(workflowJourneyTitle(${JSON.stringify(journey.id)},`,
        `const TRACE_IDS = { journey: ${JSON.stringify(journey.id)} } as const;\ntest(journeyTitle(TRACE_IDS.journey,`,
      );
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.summary.journeysGenerated).toBe(1);
    expect(review.summary.journeysVerified).toBe(1);
    expect(review.blockingIssues).toEqual([]);
  });

  it("accepts visible navigation proven with a destination URL assertion", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    let source = compliantTest(journey);
    for (const handoff of journey.handoffs) {
      source = source.replaceAll(
        `await page.goto(${JSON.stringify(handoff.consumerRoute)});`,
        `await page.getByRole("link", { name: "Open destination" }).click();\n  await expect(page).toHaveURL(${JSON.stringify(handoff.consumerRoute)});`,
      );
    }
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues).toEqual([]);
    expect(review.summary.handoffsVerified).toBe(
      review.summary.handoffsRequired,
    );
  });

  it("accepts visible navigation proven with a regular-expression URL assertion", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    let source = compliantTest(journey);
    for (const handoff of journey.handoffs) {
      const routePattern = handoff.consumerRoute
        .replaceAll("/", "\\/")
        .replaceAll("-", "\\-");
      source = source.replaceAll(
        `await page.goto(${JSON.stringify(handoff.consumerRoute)});`,
        `await page.getByRole("link", { name: "Open destination" }).click();\n  await expect(page).toHaveURL(/${routePattern}$/);`,
      );
    }
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/regex-route.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).not.toContain(
      "does not reach",
    );
    expect(review.summary.handoffsVerified).toBe(
      review.summary.handoffsRequired,
    );
  });

  it("accepts run-scoped fixtures and ordinary toBe result assertions", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(spec, architecture).journeys[0];
    const fixture = journey.fixtures.find(
      (candidate) =>
        typeof candidate.value === "string" &&
        !String(candidate.value).startsWith("@"),
    );
    const fixtureValue = String(fixture?.value ?? "VoiceForge acceptance record");
    const source = compliantTest(journey)
      .replace(
        'import { test, expect } from "@playwright/test";',
        'import { test, expect } from "@playwright/test";\nconst suffix = acceptanceRunSuffix();\nconst runScopedTitle = `VF Movie ${suffix}`;',
      )
      .replaceAll(JSON.stringify(fixtureValue), "runScopedTitle")
      .replace(
        ".toBeVisible();",
        ".toBeVisible();\n  expect(runScopedTitle).not.toBe(\"\");",
      );
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/run-scoped.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).not.toContain(
      "does not use its unique",
    );
    expect(review.blockingIssues.join(" ")).not.toContain(
      "does not perform its result action",
    );
  });

  it("accepts run-scoped values returned by a fixture factory", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(spec, architecture).journeys[0];
    const fixture = journey.fixtures.find(
      (candidate) =>
        typeof candidate.value === "string" &&
        !String(candidate.value).startsWith("@"),
    );
    const fixtureValue = String(fixture?.value ?? "VoiceForge acceptance record");
    const source = compliantTest(journey)
      .replace(
        `const fixture = ${JSON.stringify(fixtureValue)};\n  void fixture;`,
        `function fixtures() {
    const suffix = acceptanceRunSuffix();
    return { title: \`VF errand \${suffix}\` };
  }
  const values = fixtures();`,
      )
      .replaceAll(JSON.stringify(fixtureValue), "values.title");
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/fixture-factory.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).not.toContain(
      "does not use its unique",
    );
  });

  it("assigns nested workflow actions to both owning trace blocks", () => {
    const source = `await test.step(workflowHandoffTitle("member-to-loan"), async () => {
  await test.step(workflowStepTitle("lend-equipment", "open-active-loans", "Open active loans"), async () => {
    await page.goto("/active-loans");
    await expect(page).toHaveURL("/active-loans");
  });
  await expect(page.getByRole("option", { name: "Alex Morgan" })).toBeVisible();
});`;
    const calls = extractAcceptanceTraceCalls(source);
    const handoff = findAcceptanceTraceCall(calls, "workflowHandoffTitle", [
      "member-to-loan",
    ])!;
    const step = findAcceptanceTraceCall(calls, "workflowStepTitle", [
      "lend-equipment",
      "open-active-loans",
    ])!;
    const handoffScope = source.slice(handoff.scopeStart!, handoff.scopeEnd!);
    const stepScope = source.slice(step.scopeStart!, step.scopeEnd!);

    expect(handoffScope).toContain('page.goto("/active-loans")');
    expect(handoffScope).toContain('name: "Alex Morgan"');
    expect(stepScope).toContain('page.goto("/active-loans")');
    expect(stepScope).not.toContain('name: "Alex Morgan"');
  });

  it("blocks a save marker that does not prove persistence after reload", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(spec, architecture).journeys[0];
    const source = compliantTest(journey).replace("await page.reload();", "void page;");
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).toContain(
      "does not reload and visibly assert saved",
    );
  });

  it("blocks skipped journeys and direct localStorage setup", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(spec, architecture).journeys[0];
    const source = compliantTest(journey)
      .replace("test(workflowJourneyTitle", "test.skip(workflowJourneyTitle")
      .replace("void fixture;", 'localStorage.setItem("records", fixture);');
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues).toContain(
      "acceptance_test:quality Generated workflow acceptance tests may not use test.skip or test.fixme.",
    );
    expect(review.blockingIssues.join(" ")).toContain(
      "not direct storage or platform API setup",
    );
  });

  it("requires dependent localStorage journeys to recreate prerequisites in their fresh browser context", () => {
    const { spec, architecture } = sharedApp();
    const template = architecture.workflowContracts.find(
      (contract) => contract.trigger === "user_action",
    )!;
    architecture.workflowContracts = Array.from({ length: 4 }, (_, index) => ({
      ...template,
      id: `movie-workflow-${index + 1}`,
      name: `Movie workflow ${index + 1}`,
      dependencies: {
        ...template.dependencies,
        workflowIds: index === 0 ? [] : [`movie-workflow-${index}`],
      },
      expectedSaves: template.expectedSaves.map((save) => ({
        ...save,
        storage: "localStorage" as const,
      })),
      handoffs: [],
    }));
    const plan = synthesizeWorkflowAcceptancePlan(spec, architecture);
    expect(plan.journeys).toHaveLength(2);
    const [producer, dependent] = plan.journeys;
    const producerSource = compliantTest(producer).replace(
      'import { test, expect } from "@playwright/test";',
      "",
    );
    const dependentSource = compliantTest(dependent).replace(
      'import { test, expect } from "@playwright/test";',
      "",
    );
    const withoutSetup = `import { test, expect } from "@playwright/test";
test.describe.serial("movie workflows", () => {
${producerSource}
${dependentSource}
});`;
    const blocked = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/movie.spec.ts": withoutSetup },
    });

    expect(blocked.blockingIssues.join(" ")).toContain(
      "does not recreate those prerequisites through visible UI",
    );
    expect(blocked.blockingIssues.join(" ")).toContain(
      "does not preserve localStorage",
    );

    const startNavigation = `await page.goto(${JSON.stringify(dependent.startRoute)});`;
    const withSetup = withoutSetup.replace(
      dependentSource,
      dependentSource.replace(
        startNavigation,
        `${startNavigation}\n  await createMoviePrerequisites(page);`,
      ),
    );
    const repaired = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/movie.spec.ts": withSetup },
    });

    expect(repaired.blockingIssues.join(" ")).not.toContain(
      "does not recreate those prerequisites through visible UI",
    );
  });

  it("accepts the compiler-selected create prerequisite instead of replaying a destructive journey", () => {
    const { spec, architecture } = sharedApp();
    const template = architecture.workflowContracts.find(
      (contract) => contract.trigger === "user_action",
    );
    if (!template) throw new Error("Shared workflow template missing");
    architecture.workflowContracts = Array.from({ length: 7 }, (_, index) => {
      const contract = structuredClone(template);
      const number = index + 1;
      const stepIds = new Map<string, string>();
      const controlIds = new Map<string, string>();
      contract.id = `errand-workflow-${number}`;
      contract.name = `Errand workflow ${number}`;
      contract.controls = contract.controls.map((control, controlIndex) => {
        const id = `errand-workflow-${number}-control-${controlIndex + 1}`;
        controlIds.set(control.id, id);
        return { ...control, id };
      });
      contract.steps = contract.steps.map((step, stepIndex) => {
        const id = `errand-workflow-${number}-step-${stepIndex + 1}`;
        stepIds.set(step.id, id);
        return {
          ...step,
          id,
          controlId: controlIds.get(step.controlId) ?? "",
        };
      });
      contract.expectedSaves = contract.expectedSaves.map((save) => ({
        ...save,
        stepId: stepIds.get(save.stepId) ?? save.stepId,
        operation:
          number === 6
            ? ("delete" as const)
            : number >= 4
              ? ("update" as const)
              : save.operation,
        producedReference: `errand-workflow-${number}-record`,
      }));
      contract.dependencies = {
        ...contract.dependencies,
        workflowIds: number === 1 ? [] : [`errand-workflow-${number - 1}`],
      };
      contract.handoffs = [];
      contract.source = {
        ...contract.source,
        workflowName: contract.name,
      };
      return contract;
    });
    const finalReader = architecture.workflowContracts[6];
    const entityKey = finalReader?.requiredData[0]?.entityKey;
    if (!finalReader || !entityKey) {
      throw new Error("Final read-only workflow missing");
    }
    finalReader.controls = [];
    finalReader.steps = [
      {
        id: "view-remaining-records",
        description: "View the records that remain after deletion.",
        kind: "result",
        route: finalReader.start.route,
        controlId: "",
        reads: [entityKey],
        writes: [],
        visibleResult: "The remaining records are visible.",
      },
    ];
    finalReader.expectedSaves = [];

    const plan = synthesizeWorkflowAcceptancePlan(spec, architecture);
    const compiled = compileAcceptanceTests({ spec, architecture });
    const targetPlanJourney = plan.journeys.at(-1);
    const targetManifestJourney = compiled.manifest.journeys.find(
      (journey) => journey.id === targetPlanJourney?.id,
    );
    const directDependency = targetPlanJourney?.dependsOnJourneyIds[0];

    expect(plan.journeys).toHaveLength(3);
    expect(targetManifestJourney?.prerequisites).toHaveLength(1);
    expect(targetManifestJourney?.prerequisites[0]?.journeyId).not.toBe(
      directDependency,
    );

    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: {
        [ACCEPTANCE_COMPILED_SPEC_PATH]: compiled.compiledSource,
        [ACCEPTANCE_MANIFEST_SOURCE_PATH]: compiled.manifestSource,
        [ACCEPTANCE_ADAPTERS_PATH]: compiled.adapterSource,
      },
      requireStableControlLocators: true,
    });

    expect(review.blockingIssues).not.toContainEqual(
      expect.stringContaining("must recreate"),
    );
    expect(review.blockingIssues).toEqual([]);
  });

  it("does not accept a labeled contract step without its UI action", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(spec, architecture).journeys[0];
    const actionable = journey.steps.find(
      (step) => step.kind === "action" || step.kind === "save",
    )!;
    const source = compliantTest(journey).replace(
      `await page.getByRole("button", { name: ${JSON.stringify(actionable.accessibleName)} }).click();`,
      "void page;",
    );
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).toContain(
      `labels ${actionable.contractStepId} but does not perform`,
    );
  });

  it("defers locator wording uncertainty to the real browser journey", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    const actionable = journey.steps.find(
      (step) => step.kind === "action" || step.kind === "save",
    )!;
    const source = compliantTest(journey).replace(
      `await page.getByRole("button", { name: ${JSON.stringify(actionable.accessibleName)} }).click();`,
      'await page.getByRole("button", { name: "Save this item" }).click();',
    );
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).not.toContain(
      "does not use the contracted control",
    );
    expect(review.warnings.join(" ")).toContain(
      "locator wording is equivalent",
    );
    expect(review.warnings.join(" ")).toContain("actual Playwright result");
  });

  it("defers an opaque helper implementation to the actual Playwright run", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(spec, architecture).journeys[0];
    const actionable = journey.steps.find(
      (step) => step.kind === "action" || step.kind === "save",
    )!;
    const source = compliantTest(journey).replace(
      `await page.getByRole("button", { name: ${JSON.stringify(actionable.accessibleName)} }).click();`,
      "await completeContractedAction(page);",
    );
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).not.toContain(
      `labels ${actionable.contractStepId} but does not perform`,
    );
    expect(review.warnings.join(" ")).toContain(
      "actual Playwright result",
    );
  });
});

describe("Stage 14G acceptance locators", () => {
  function stableCompliantTest(journey: WorkflowAcceptanceJourney): string {
    let source = compliantTest(journey).replace(
      "workflowHandoffTitle, voiceForgeRoleHeaders",
      "workflowHandoffTitle, voiceForgeRoleHeaders, vfControl",
    );
    for (const step of journey.steps.filter((candidate) => candidate.controlId)) {
      const stable = `vfControl(page, ${JSON.stringify(step.workflowId)}, ${JSON.stringify(step.controlId)})`;
      const label = JSON.stringify(step.accessibleName);
      const candidates = [
        `page.getByRole("link", { name: ${label} })`,
        `page.getByRole("button", { name: ${label} })`,
        `page.getByLabel(${label})`,
      ];
      const current = candidates.find((candidate) => source.includes(candidate));
      if (current) source = source.replace(current, stable);
    }
    return source;
  }

  it("requires exact workflow/control locator helpers for new builds", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    const legacy = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: {
        "e2e/generated/chore-journey.spec.ts": compliantTest(journey),
      },
      requireStableControlLocators: true,
    });

    expect(legacy.blockingIssues.join(" ")).toContain(
      "must locate [voiceforge-workflow:",
    );

    const stable = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: {
        "e2e/generated/chore-journey.spec.ts": stableCompliantTest(journey),
      },
      requireStableControlLocators: true,
    });

    expect(stable.blockingIssues).toEqual([]);
    expect(stable.summary.stableLocatorsVerified).toBe(
      stable.summary.stableLocatorsRequired,
    );
  });

  it("accepts a canonical locator shared by an equivalent contract control", () => {
    const { spec, architecture } = sharedApp();
    const original = architecture.workflowContracts[0];
    const canonical = structuredClone(original);
    canonical.id = "canonical-shared-controls";
    canonical.name = "Canonical shared controls";
    canonical.trigger = "system";
    architecture.workflowContracts = [original, canonical];
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    const step = journey.steps.find((candidate) => candidate.controlId)!;
    const source = stableCompliantTest(journey).replace(
      `vfControl(page, ${JSON.stringify(step.workflowId)}, ${JSON.stringify(step.controlId)})`,
      `vfControl(page, "canonical-shared-controls", ${JSON.stringify(step.controlId)})`,
    );

    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
      requireStableControlLocators: true,
    });

    expect(review.blockingIssues).toEqual([]);
    expect(review.summary.stableLocatorsVerified).toBe(
      review.summary.stableLocatorsRequired,
    );
  });

  it("accepts a permanent consumer control locator as handoff evidence", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    let source = stableCompliantTest(journey);
    for (const handoff of journey.handoffs) {
      source = source.replace(
        `await page.goto(${JSON.stringify(handoff.consumerRoute)});`,
        `const consumer = vfControl(page, ${JSON.stringify(handoff.consumerWorkflowId)}, ${JSON.stringify(handoff.consumerControlId)});\n  await expect(consumer).toBeVisible();`,
      );
    }

    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
      requireStableControlLocators: true,
    });

    expect(review.blockingIssues.join(" ")).not.toContain("does not reach");
    expect(review.summary.handoffsVerified).toBe(
      review.summary.handoffsRequired,
    );
  });

  it("accepts an assertion-only action step that verifies controls are absent", () => {
    const { spec, architecture } = sharedApp();
    const contract = architecture.workflowContracts[0];
    contract.steps[0] = {
      ...contract.steps[0],
      kind: "action",
      controlId: "",
      visibleResult: "Editing controls are hidden.",
    };
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    const source = stableCompliantTest(journey).replace(
      'await page.getByRole("button", { name: "" }).click();',
      'await expect(page.getByRole("button", { name: "Save chore" })).toHaveCount(0);',
    );

    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
      requireStableControlLocators: true,
    });

    expect(review.blockingIssues.join(" ")).not.toContain(
      `labels ${contract.steps[0].id} but does not perform`,
    );
  });
});
