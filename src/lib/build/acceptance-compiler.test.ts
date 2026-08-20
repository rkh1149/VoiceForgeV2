import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import type { CodegenResult } from "../agents/coder";
import { computeSpecComplexity } from "../spec";
import type { WorkflowContract } from "../workflow-contract";
import { analyzeGeneratedAcceptanceTests } from "./acceptance-test-review";
import {
  ACCEPTANCE_ADAPTERS_PATH,
  ACCEPTANCE_COMPILED_SPEC_PATH,
  ACCEPTANCE_MANIFEST_SOURCE_PATH,
  applyDeterministicAcceptanceCompiler,
  compileAcceptanceTests,
  refreshDeterministicAcceptanceCompiler,
  reviewAcceptanceCompiler,
} from "./acceptance-compiler";
import { GOLDEN_REGRESSION_SPECS } from "./golden-regression-specs";
import { synthesizeWorkflowAcceptancePlan } from "./workflow-acceptance-plan";
import type { FileMap } from "./template";

function golden(id: (typeof GOLDEN_REGRESSION_SPECS)[number]["id"]) {
  const item = GOLDEN_REGRESSION_SPECS.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Missing golden spec ${id}`);
  const architecture = createFallbackArchitecturePlan(
    item.spec,
    computeSpecComplexity(item.spec),
  );
  return { spec: item.spec, architecture };
}

describe("Stage 14I isolated acceptance compiler", () => {
  it("produces structurally identical source for the same workflow contract", () => {
    const input = golden("shared-platform-data");
    const first = compileAcceptanceTests(input);
    const second = compileAcceptanceTests(input);

    expect(second.manifest).toEqual(first.manifest);
    expect(second.manifestSource).toBe(first.manifestSource);
    expect(second.compiledSource).toBe(first.compiledSource);
    expect(second.compilerHash).toBe(first.compilerHash);
    expect(second.lineMap).toEqual(first.lineMap);
  });

  it("compiles every planned journey step, save, and handoff exactly once", () => {
    for (const item of GOLDEN_REGRESSION_SPECS) {
      const architecture = createFallbackArchitecturePlan(
        item.spec,
        computeSpecComplexity(item.spec),
      );
      const plan = synthesizeWorkflowAcceptancePlan(item.spec, architecture);
      const compiled = compileAcceptanceTests({ spec: item.spec, architecture });

      expect.soft(compiled.blockingIssues, item.id).toEqual([]);
      expect.soft(compiled.manifest.summary.journeys, item.id).toBe(
        plan.journeys.length,
      );
      expect.soft(compiled.manifest.summary.steps, item.id).toBe(
        plan.summary.contractSteps,
      );
      expect.soft(compiled.manifest.summary.saves, item.id).toBe(
        plan.summary.saves,
      );
      expect.soft(compiled.manifest.summary.handoffs, item.id).toBe(
        plan.summary.handoffs,
      );
      expect.soft(compiled.compiledSource, item.id).not.toMatch(
        /TODO|test\.skip|test\.fixme|placeholder assertion/i,
      );
      for (const journey of plan.journeys) {
        expect
          .soft(
            occurrences(
              compiled.compiledSource,
              `workflowJourneyTitle(${JSON.stringify(journey.id)}`,
            ),
            `${item.id}:${journey.id}`,
          )
          .toBe(1);
        for (const step of journey.steps) {
          expect
            .soft(
              occurrences(
                compiled.compiledSource,
                `workflowStepTitle(${JSON.stringify(step.workflowId)}, ${JSON.stringify(step.contractStepId)}`,
              ),
              `${item.id}:${step.workflowId}/${step.contractStepId}`,
            )
            .toBe(1);
        }
      }
    }
  });

  it("passes the existing static acceptance reviewer for all golden contracts", () => {
    for (const item of GOLDEN_REGRESSION_SPECS) {
      const architecture = createFallbackArchitecturePlan(
        item.spec,
        computeSpecComplexity(item.spec),
      );
      const compiled = compileAcceptanceTests({ spec: item.spec, architecture });
      const review = analyzeGeneratedAcceptanceTests({
        spec: item.spec,
        architecture,
        files: {
          [ACCEPTANCE_COMPILED_SPEC_PATH]: compiled.compiledSource,
          [ACCEPTANCE_MANIFEST_SOURCE_PATH]: compiled.manifestSource,
          [ACCEPTANCE_ADAPTERS_PATH]: compiled.adapterSource,
        },
        requireStableControlLocators: true,
      });

      expect.soft(review.blockingIssues, item.id).toEqual([]);
      expect.soft(review.summary.stepsVerified, item.id).toBe(
        review.summary.stepsRequired,
      );
    }
  });

  it("replaces AI-authored specs and preserves only the app adapter boundary", () => {
    const input = golden("simple-local-storage");
    const files: FileMap = {
      "src/app/page.tsx": "export default function Page() { return null; }",
      "e2e/generated/ai-authored.spec.ts": "test('partial', async () => {});",
    };
    const generated: CodegenResult = {
      files: { ...files },
      deletedFiles: [],
      notes: "AI generation",
      filesWritten: Object.keys(files),
      phases: [],
      operations: [],
    };

    const compiled = applyDeterministicAcceptanceCompiler({
      ...input,
      files,
      generated,
    });

    expect(files["e2e/generated/ai-authored.spec.ts"]).toBeUndefined();
    expect(files[ACCEPTANCE_COMPILED_SPEC_PATH]).toBe(compiled.compiledSource);
    expect(files[ACCEPTANCE_MANIFEST_SOURCE_PATH]).toBe(compiled.manifestSource);
    expect(files[ACCEPTANCE_ADAPTERS_PATH]).toContain(
      "VoiceForgeAcceptanceAdapters",
    );
    expect(generated.deletedFiles).toContain(
      "e2e/generated/ai-authored.spec.ts",
    );
    expect(generated.phases.at(-1)?.agentKey).toBe("acceptance_compiler");
  });

  it("rejects an unresolved drag-and-drop adapter before E2E", () => {
    const input = golden("simple-local-storage");
    const contract = input.architecture.workflowContracts[0];
    const step = contract.steps.find((candidate) => candidate.controlId);
    const control = contract.controls.find(
      (candidate) => candidate.id === step?.controlId,
    );
    if (!step || !control) throw new Error("Golden contract has no control");
    step.kind = "input";
    control.kind = "drag_drop";

    const unresolved = compileAcceptanceTests(input);
    const adapter = unresolved.manifest.adapters[0];
    expect(adapter).toBeDefined();
    expect(unresolved.blockingIssues.join(" ")).toContain("is unresolved");

    const adapterSource = `export const acceptanceAdapters = { ${JSON.stringify(
      adapter.id,
    )}: async () => {} };`;
    const resolved = compileAcceptanceTests({
      ...input,
      existingAdapterSource: adapterSource,
    });
    expect(resolved.blockingIssues).toEqual([]);
  });

  it("detects protected compiler output that was changed after compilation", () => {
    const input = golden("shared-platform-data");
    const compiled = compileAcceptanceTests(input);
    const review = reviewAcceptanceCompiler({
      ...input,
      files: {
        [ACCEPTANCE_MANIFEST_SOURCE_PATH]: compiled.manifestSource,
        [ACCEPTANCE_COMPILED_SPEC_PATH]: `${compiled.compiledSource}\n// changed`,
        [ACCEPTANCE_ADAPTERS_PATH]: compiled.adapterSource,
      },
    });

    expect(review.status).toBe("needs_repair");
    expect(review.blockingIssues.join(" ")).toContain("was modified");
  });

  it("refreshes stale protected compiler artifacts in a durable checkpoint", () => {
    const input = golden("shared-platform-data");
    const files: FileMap = {
      [ACCEPTANCE_MANIFEST_SOURCE_PATH]: "stale manifest",
      [ACCEPTANCE_COMPILED_SPEC_PATH]: "stale compiled spec",
      [ACCEPTANCE_ADAPTERS_PATH]:
        "export const acceptanceAdapters = {} satisfies VoiceForgeAcceptanceAdapters;",
    };
    const generated: CodegenResult = {
      files: { ...files },
      deletedFiles: [],
      notes: "checkpoint",
      filesWritten: Object.keys(files),
      phases: [],
      operations: [],
    };

    const refreshed = refreshDeterministicAcceptanceCompiler({
      ...input,
      files,
      generated,
      changeMode: true,
    });

    expect(refreshed.refreshedPaths).toEqual([
      ACCEPTANCE_MANIFEST_SOURCE_PATH,
      ACCEPTANCE_COMPILED_SPEC_PATH,
    ]);
    expect(files[ACCEPTANCE_MANIFEST_SOURCE_PATH]).toContain('"version": 3');
    expect(files[ACCEPTANCE_COMPILED_SPEC_PATH]).toContain(
      "VoiceForge compiled workflow acceptance",
    );
    expect(generated.files[ACCEPTANCE_COMPILED_SPEC_PATH]).toBe(
      files[ACCEPTANCE_COMPILED_SPEC_PATH],
    );
  });

  it("orders a create-to-complete handoff before the consumer mutation", () => {
    const input = completionHandoffInput();
    const compiled = compileAcceptanceTests({ ...input, changeMode: true });
    const journey = compiled.manifest.journeys[0];

    expect(compiled.blockingIssues).toEqual([]);
    expect(journey.handoffs[0]?.consumerControl?.recordScope).toMatchObject({
      entityKey: "chore",
    });
    expect(
      journey.roleChecks.find(
        (check) => check.id === "complete-a-chore:viewer:read-only",
      )?.hiddenControl,
    ).toMatchObject({
      workflowId: "complete-a-chore",
      controlId: "complete-chore",
    });

    const producerResult = compiled.compiledSource.indexOf(
      'workflowStepTitle("add-a-chore", "show-created-chore"',
    );
    const producerSave = compiled.compiledSource.indexOf(
      `workflowSaveTitle(${JSON.stringify(journey.saves[0]?.id)})`,
    );
    const handoff = compiled.compiledSource.indexOf(
      'workflowHandoffTitle("created-chore-for-completion")',
    );
    const consumerAction = compiled.compiledSource.indexOf(
      'workflowStepTitle("complete-a-chore", "select-complete"',
    );
    expect(producerSave).toBeGreaterThan(-1);
    expect(producerResult).toBeGreaterThan(-1);
    expect(handoff).toBeGreaterThan(producerSave);
    expect(producerResult).toBeGreaterThan(handoff);
    expect(consumerAction).toBeGreaterThan(handoff);
    expect(compiled.compiledSource).toContain('toContainText("Not completed")');
    expect(compiled.compiledSource).toContain('toContainText("Completed")');
    expect(compiled.compiledSource).toContain("const consumerRecord = vfRecords");
    expect(compiled.compiledSource).not.toContain(
      "The selected chore begins updating and its Complete control is temporarily disabled.",
    );
  });

  it("recreates a complete prerequisite chain inside each split journey test", () => {
    const input = splitJourneyInput();
    const compiled = compileAcceptanceTests(input);
    const target = compiled.manifest.journeys.find(
      (journey) => journey.prerequisites.length > 0,
    );
    if (!target) throw new Error("Expected a split dependent journey");

    expect(compiled.blockingIssues).toEqual([]);
    expect(compiled.isolationReview.status).toBe("verified");
    expect(compiled.compiledSource).not.toContain("test.describe.serial");
    expect(compiled.compiledSource).not.toMatch(/^(?:let|var)\s+/m);
    expect(target.isolation.prerequisiteJourneyIds).toEqual(
      target.prerequisites.map((prerequisite) => prerequisite.journeyId),
    );
    for (const prerequisite of target.prerequisites) {
      const setup = `workflowFixtureSetupTitle(${JSON.stringify(
        target.id,
      )}, ${JSON.stringify(prerequisite.journeyId)})`;
      expect(compiled.compiledSource).toContain(setup);
      expect(compiled.compiledSource.indexOf(setup)).toBeLessThan(
        compiled.compiledSource.indexOf(
          `workflowJourneyTitle(${JSON.stringify(target.id)}`,
        ),
      );
    }
    expect(compiled.compiledSource).toContain(
      `acceptanceRunSuffix(testInfo, ${JSON.stringify(
        target.isolation.fixtureNamespace,
      )})`,
    );
    expect(compiled.compiledSource).toContain(
      `acceptanceRetryProbe(testInfo, ${JSON.stringify(target.id)})`,
    );
    const handoffJourney = compiled.manifest.journeys.find((journey) =>
      journey.handoffs.some(
        (handoff) => handoff.id === "workflow-3-to-workflow-4",
      ),
    );
    const crossJourneyHandoff = handoffJourney?.handoffs.find(
      (handoff) => handoff.id === "workflow-3-to-workflow-4",
    );
    expect(handoffJourney?.id).not.toBe(target.id);
    expect(crossJourneyHandoff?.fixtureId).toContain(
      "workflow-1-to-workflow-2-to-workflow-3",
    );
    expect(crossJourneyHandoff?.consumerControl?.recordScope).toBeNull();
    for (const journey of compiled.manifest.journeys) {
      for (const step of journey.steps) {
        expect(
          occurrences(
            compiled.compiledSource,
            `workflowStepTitle(${JSON.stringify(step.workflowId)}, ${JSON.stringify(step.contractStepId)}`,
          ),
        ).toBe(1);
      }
    }
  });

  it("does not replay an alternative delete workflow as prerequisite setup", () => {
    const input = splitJourneyInput();
    const contracts = input.architecture.workflowContracts;
    const create = contracts[0];
    const destructive = contracts[2];
    const target = contracts[3];
    if (!create || !destructive || !target) {
      throw new Error("Split contracts missing");
    }
    destructive.expectedSaves = destructive.expectedSaves.map((save) => ({
      ...save,
      operation: "delete" as const,
    }));
    target.dependencies.workflowIds = [create.id, destructive.id];

    const compiled = compileAcceptanceTests(input);
    const dependent = compiled.manifest.journeys.at(-1);
    const prerequisiteWorkflowIds =
      dependent?.prerequisites.flatMap((prerequisite) => prerequisite.workflowIds) ??
      [];

    expect(prerequisiteWorkflowIds).toContain(create.id);
    expect(prerequisiteWorkflowIds).not.toContain(destructive.id);
    const destructiveHandoff = compiled.manifest.journeys
      .flatMap((journey) => journey.handoffs)
      .find((handoff) => handoff.producerWorkflowId === destructive.id);
    expect(destructiveHandoff).toMatchObject({
      expectedPresence: false,
      consumerControl: null,
    });
    expect(compiled.compiledSource).not.toContain(
      `workflowFixtureStepTitle(${JSON.stringify(dependent?.id)}, ${JSON.stringify(
        dependent?.prerequisites[0]?.journeyId,
      )}, ${JSON.stringify(destructive.id)}`,
    );
  });

  it("splits a destructive workflow before a later reader and rebuilds fresh state", () => {
    const input = completionHandoffInput();
    const [create, remove] = input.architecture.workflowContracts;
    const removeSave = remove?.expectedSaves[0];
    if (!create || !remove || !removeSave) {
      throw new Error("Destructive workflow contracts missing");
    }
    remove.expectedSaves = [
      {
        ...removeSave,
        operation: "delete",
        producedReference: "deleted-chore",
      },
    ];
    const review = structuredClone(remove);
    review.id = "review-remaining-chores";
    review.name = "Review remaining chores";
    review.controls = [
      {
        id: "view-remaining-chores",
        kind: "link",
        accessibleName: "View remaining chores",
        route: "/",
        roles: ["owner", "editor"],
        action: "Open the remaining chore list.",
      },
    ];
    review.steps = [
      {
        id: "view-remaining-chores",
        description: "Open the remaining chore list.",
        kind: "navigate",
        route: "/",
        controlId: "view-remaining-chores",
        reads: ["chore"],
        writes: [],
        visibleResult: "The remaining chores are visible.",
      },
    ];
    review.expectedSaves = [];
    review.handoffs = [];
    review.dependencies = {
      ...review.dependencies,
      workflowIds: [remove.id],
    };
    review.source = {
      ...review.source,
      workflowName: review.name,
    };
    remove.handoffs = [
      {
        id: "deleted-chore-for-review",
        fromStepId: removeSave.stepId,
        produces: "deleted-chore",
        storage: removeSave.storage,
        consumerWorkflowId: review.id,
        consumerRoute: review.start.route,
        consumerControlId: "view-remaining-chores",
        loadRule: "Reload the remaining chore list after deletion.",
      },
    ];
    input.architecture.workflowContracts.push(review);

    const compiled = compileAcceptanceTests(input);
    const destructivePart = compiled.manifest.journeys.find((journey) =>
      journey.saves.some((save) => save.operation === "delete"),
    );
    const readerPart = compiled.manifest.journeys.find((journey) =>
      journey.steps.some((step) => step.workflowId === review.id),
    );
    const readerPrerequisites =
      readerPart?.prerequisites.flatMap(
        (prerequisite) => prerequisite.workflowIds,
      ) ?? [];

    expect(compiled.blockingIssues).toEqual([]);
    expect(destructivePart?.id).toMatch(/-part-1$/);
    expect(readerPart?.id).toMatch(/-part-2$/);
    expect(readerPrerequisites).toContain(create.id);
    expect(readerPrerequisites).not.toContain(remove.id);
    for (const contract of input.architecture.workflowContracts) {
      for (const step of contract.steps) {
        expect(
          occurrences(
            compiled.compiledSource,
            `workflowStepTitle(${JSON.stringify(contract.id)}, ${JSON.stringify(
              step.id,
            )}`,
          ),
        ).toBe(1);
      }
    }
  });

  it("expects a deleted record to remain absent in later reload result steps", () => {
    const input = completionHandoffInput();
    const remove = input.architecture.workflowContracts[1];
    const removeSave = remove?.expectedSaves[0];
    if (!remove || !removeSave) throw new Error("Remove workflow missing");
    remove.expectedSaves = [{ ...removeSave, operation: "delete" }];
    remove.steps.push({
      id: "show-remaining-chores",
      description: "Reload remaining chores from shared storage.",
      kind: "result",
      route: remove.start.route,
      controlId: "",
      reads: [removeSave.entityKey],
      writes: [],
      visibleResult: "The deleted chore is absent from the remaining chores.",
    });

    const compiled = compileAcceptanceTests(input);
    const resultStep = compiled.manifest.journeys
      .flatMap((journey) => journey.steps)
      .find((step) => step.contractStepId === "show-remaining-chores");

    expect(resultStep).toMatchObject({
      assertionScope: null,
      expectedPresence: false,
    });
    expect(compiled.compiledSource).toContain(".not.toContainText(");
  });

  it("uses the entity named by a dashboard result for page-level assertions", () => {
    const input = relationJourneyInput();
    const consumer = input.architecture.workflowContracts[1];
    if (!consumer) throw new Error("Relation consumer missing");
    consumer.steps.unshift({
      id: "load-trip-overview",
      description: "Load trip and trip day information on Overview.",
      kind: "result",
      route: "/",
      controlId: "",
      reads: ["trip", "trip_day"],
      writes: [],
      visibleResult: "Overview shows upcoming trip days.",
    });

    const compiled = compileAcceptanceTests(input);
    const resultStep = compiled.manifest.journeys
      .flatMap((journey) => journey.steps)
      .find((step) => step.contractStepId === "load-trip-overview");
    const assertionFixture = compiled.manifest.journeys
      .flatMap((journey) => journey.fixtures)
      .find((fixture) => fixture.id === resultStep?.assertionFixtureId);

    expect(assertionFixture?.entityKey).toBe("trip_day");
    expect(resultStep?.assertionScope).toBeNull();
  });

  it("namespaces names, emails, and uploaded filenames for every attempt", () => {
    const shared = golden("shared-platform-data");
    const sharedCompiled = compileAcceptanceTests(shared);
    expect(sharedCompiled.compiledSource).toContain(' + " " + runSuffix');

    const emailInput = golden("shared-platform-data");
    const emailField = emailInput.spec.dataEntities[0]?.fields[0];
    if (!emailField) throw new Error("Golden identifying field missing");
    emailField.label = "Contact email";
    const emailCompiled = compileAcceptanceTests(emailInput);
    expect(emailCompiled.compiledSource).toContain(
      "`vf-${runSuffix}@example.com`",
    );

    const files = golden("file-export");
    files.spec.dataEntities[0]?.fields.push({
      name: "Attachment",
      label: "Attachment",
      type: "file",
      required: true,
      validation: "",
    });
    files.architecture = createFallbackArchitecturePlan(
      files.spec,
      computeSpecComplexity(files.spec),
    );
    const fileCompiled = compileAcceptanceTests(files);
    expect(fileCompiled.compiledSource).toContain(
      "`voiceforge-${runSuffix}.png`",
    );
    expect(
      fileCompiled.manifest.journeys.flatMap((journey) => journey.fixtures),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file", runScoped: true }),
      ]),
    );
  });

  it("completes every explicitly named form field with its matching fixture", () => {
    const input = golden("shared-platform-data");
    input.spec.dataEntities = [
      {
        name: "Helper",
        description: "A helper available for errands.",
        ownership: "shared",
        fields: [
          {
            name: "Name",
            label: "Name",
            type: "text",
            required: true,
            validation: "Required",
          },
          {
            name: "Phone Number",
            label: "Phone number",
            type: "text",
            required: false,
            validation: "",
          },
          {
            name: "Notes",
            label: "Notes",
            type: "long_text",
            required: false,
            validation: "",
          },
        ],
        relationships: [],
      },
    ];
    input.spec.workflows = [
      {
        name: "Add helper",
        actor: "Editor",
        trigger: "A helper needs to be saved",
        steps: [
          "Open the helper form",
          "Enter the required name and optional phone number and notes",
          "Save the helper",
        ],
        successOutcome: "The helper is visible.",
        failureStates: ["Validation error"],
      },
    ];
    input.architecture = createFallbackArchitecturePlan(
      input.spec,
      computeSpecComplexity(input.spec),
    );
    const contract = input.architecture.workflowContracts[0];
    const entryStep = contract?.steps.find((step) =>
      step.description.includes("required name"),
    );
    const entryControl = contract?.controls.find(
      (control) => control.id === entryStep?.controlId,
    );
    if (!entryStep || !entryControl) {
      throw new Error("Helper entry contract missing");
    }
    if (contract.requiredData[0]) {
      contract.requiredData[0].requiredFieldKeys = [
        "name",
        "phone_number",
        "notes",
      ];
    }
    entryControl.id = "helper-name-input";
    entryControl.kind = "textbox";
    entryControl.accessibleName = "Name";
    entryStep.controlId = entryControl.id;
    entryStep.kind = "input";
    entryStep.description =
      "Enter the required name and optional phone number and notes.";

    const compiled = compileAcceptanceTests(input);
    const manifestStep = compiled.manifest.journeys
      .flatMap((journey) => journey.steps)
      .find((step) => step.contractStepId === entryStep.id);

    expect(manifestStep?.primitive).toBe("complete_form");
    expect(manifestStep?.fixtureIds).toHaveLength(3);
    expect(compiled.compiledSource).toContain(
      "await completeAcceptanceForm(page, control",
    );
    expect(compiled.compiledSource).toContain('label: "Name"');
    expect(compiled.compiledSource).toContain('label: "Phone number"');
    expect(compiled.compiledSource).toContain('label: "Notes"');
    expect(compiled.compiledSource).not.toContain(
      "control.fill(String(fixture_helper_phone_number))",
    );
  });

  it("compiles assertion-only steps without inventing a control variable", () => {
    const input = golden("shared-platform-data");
    const workflow = input.architecture.workflowContracts[0];
    if (!workflow) throw new Error("Golden workflow missing");
    workflow.steps = [
      {
        id: "verify-read-only",
        description: "Confirm editing controls are absent.",
        kind: "automatic",
        route: workflow.start.route,
        controlId: "",
        reads: workflow.requiredData.map((entity) => entity.entityKey),
        writes: [],
        visibleResult: "The shared records remain visible.",
      },
    ];
    workflow.controls = [];

    const compiled = compileAcceptanceTests(input);

    expect(compiled.compiledSource).not.toContain("await control.click()");
    expect(compiled.compiledSource).toContain('page.locator("body")');
  });

  it("scopes repeated record actions but keeps modal confirmation controls global", () => {
    const input = golden("shared-platform-data");
    const workflow = input.architecture.workflowContracts[0];
    const entity = workflow?.requiredData[0];
    if (!workflow || !entity) throw new Error("Golden workflow data missing");
    workflow.controls.push(
      {
        id: "add-record",
        kind: "button",
        accessibleName: "Add record",
        route: workflow.start.route,
        roles: workflow.actor.roles,
        action: "Open the add form.",
      },
      {
        id: "delete-record",
        kind: "button",
        accessibleName: "Delete record",
        route: workflow.start.route,
        roles: workflow.actor.roles,
        action: "Open the delete confirmation.",
      },
      {
        id: "confirm-delete-record",
        kind: "button",
        accessibleName: "Confirm delete record",
        route: workflow.start.route,
        roles: workflow.actor.roles,
        action: "Confirm deletion in the modal.",
      },
    );
    workflow.steps.push(
      {
        id: "open-add-record",
        description: "Open the blank record form.",
        kind: "action",
        route: workflow.start.route,
        controlId: "add-record",
        reads: [entity.entityKey],
        writes: [],
        visibleResult: "A blank form opens.",
      },
      {
        id: "open-delete-record",
        description: "Delete the selected record.",
        kind: "action",
        route: workflow.start.route,
        controlId: "delete-record",
        reads: [entity.entityKey],
        writes: [],
        visibleResult: "A confirmation dialog opens.",
      },
      {
        id: "confirm-delete-record",
        description: "Confirm deletion of the selected record.",
        kind: "action",
        route: workflow.start.route,
        controlId: "confirm-delete-record",
        reads: [entity.entityKey],
        writes: [entity.entityKey],
        visibleResult: "The record is removed.",
      },
    );

    const compiled = compileAcceptanceTests(input);
    const steps = compiled.manifest.journeys.flatMap((journey) => journey.steps);

    expect(
      steps.find((step) => step.contractStepId === "open-add-record")?.control
        ?.recordScope,
    ).toBeNull();
    expect(
      steps.find((step) => step.contractStepId === "open-delete-record")?.control
        ?.recordScope,
    ).not.toBeNull();
    expect(
      steps.find((step) => step.contractStepId === "confirm-delete-record")?.control
        ?.recordScope,
    ).toBeNull();
  });

  it("keeps edit form fields and global navigation outside repeated record scope", () => {
    const input = golden("shared-platform-data");
    const workflow = input.architecture.workflowContracts[0];
    const entity = workflow?.requiredData[0];
    if (!workflow || !entity) throw new Error("Golden workflow data missing");
    workflow.controls.push(
      {
        id: "edit-record-name-input",
        kind: "textbox",
        accessibleName: "Name",
        route: workflow.start.route,
        roles: workflow.actor.roles,
        action: "Change the selected record name.",
      },
      {
        id: "open-records-link",
        kind: "link",
        accessibleName: "Records",
        route: workflow.start.route,
        roles: workflow.actor.roles,
        action: "Navigate to the records screen.",
      },
    );
    workflow.steps.push(
      {
        id: "change-record-name",
        description: "Change the selected record name.",
        kind: "input",
        route: workflow.start.route,
        controlId: "edit-record-name-input",
        reads: [entity.entityKey],
        writes: [entity.entityKey],
        visibleResult: "The edit form contains the changed name.",
      },
      {
        id: "open-records",
        description: "Open the records screen.",
        kind: "navigate",
        route: workflow.start.route,
        controlId: "open-records-link",
        reads: [entity.entityKey],
        writes: [],
        visibleResult: "The records screen is visible.",
      },
    );

    const compiled = compileAcceptanceTests(input);
    const steps = compiled.manifest.journeys.flatMap((journey) => journey.steps);

    expect(
      steps.find((step) => step.contractStepId === "change-record-name")?.control
        ?.recordScope,
    ).toBeNull();
    expect(
      steps.find((step) => step.contractStepId === "open-records")?.control
        ?.recordScope,
    ).toBeNull();
  });

  it("resolves relation fixtures to a visible producer record before form setup", () => {
    const input = relationJourneyInput();
    const compiled = compileAcceptanceTests(input);
    const fixtures = compiled.manifest.journeys.flatMap(
      (journey) => journey.fixtures,
    );
    const relation = fixtures.find((fixture) => fixture.relationEntityKey);
    const producer = fixtures.find(
      (fixture) => fixture.id === relation?.relationFixtureId,
    );

    expect(compiled.blockingIssues).toEqual([]);
    expect(relation).toMatchObject({
      entityKey: "trip_day",
      relationEntityKey: "trip",
    });
    expect(producer).toMatchObject({ entityKey: "trip", runScoped: true });
    expect(
      compiled.manifest.journeys
        .flatMap((journey) => journey.handoffs)
        .find((handoff) => handoff.id === "saved-trip-for-trip-day")
        ?.consumerControl?.recordScope,
    ).toBeNull();
    const producerDeclaration = compiled.compiledSource.indexOf(
      "const fixture_trip_trip_name =",
    );
    const relationDeclaration = compiled.compiledSource.indexOf(
      "const fixture_trip_day_trip = fixture_trip_trip_name;",
    );
    expect(producerDeclaration).toBeGreaterThan(-1);
    expect(relationDeclaration).toBeGreaterThan(producerDeclaration);
  });

  it("uses visible consumer controls to reveal a nested handoff target", () => {
    const input = relationJourneyInput();
    const [producer, consumer] = input.architecture.workflowContracts;
    const handoff = producer?.handoffs[0];
    const controlledSteps = consumer?.steps.filter((step) => step.controlId) ?? [];
    const revealStep = controlledSteps[0];
    const entity = consumer?.requiredData[0];
    if (!handoff || !consumer || !revealStep || !entity) {
      throw new Error("Relation consumer reveal path missing");
    }
    const targetControl = {
      id: "edit-trip-day",
      kind: "link" as const,
      accessibleName: "Edit trip day",
      route: consumer.start.route,
      roles: consumer.actor.roles,
      action: "Open the saved trip day for editing.",
    };
    consumer.controls.push(targetControl);
    consumer.steps.push({
      id: "open-saved-trip-day",
      description: "Open the saved trip day for editing.",
      kind: "navigate",
      route: consumer.start.route,
      controlId: targetControl.id,
      reads: [entity.entityKey],
      writes: [],
      visibleResult: "The saved trip day is visible.",
    });
    handoff.consumerControlId = targetControl.id;

    const compiled = compileAcceptanceTests(input);
    const compiledHandoff = compiled.manifest.journeys
      .flatMap((journey) => journey.handoffs)
      .find((candidate) => candidate.id === handoff.id);
    const reveal = compiled.compiledSource.indexOf(
      `const revealControl0 = vfControl(page, ${JSON.stringify(
        consumer.id,
      )}, ${JSON.stringify(revealStep.controlId)})`,
    );
    const target = compiled.compiledSource.indexOf(
      JSON.stringify(targetControl.id),
      reveal,
    );

    expect(reveal).toBeGreaterThan(-1);
    expect(target).toBeGreaterThan(reveal);
    expect(compiledHandoff?.consumerControl?.recordScope?.entityKey).toBe(
      entity.entityKey,
    );
    expect(
      compiled.compiledSource.indexOf("await consumer.click();", target),
    ).toBeGreaterThan(target);
  });

  it("clicks a clearly named global navigation handoff even when its workflow step is result-shaped", () => {
    const input = relationJourneyInput();
    const producer = input.architecture.workflowContracts[0];
    const consumer = input.architecture.workflowContracts[1];
    const entity = producer?.requiredData[0];
    const handoff = producer?.handoffs[0];
    if (!producer || !consumer || !entity || !handoff) {
      throw new Error("Relation producer, consumer, entity, or handoff missing");
    }
    const navigationControl = {
      id: "open-records-link",
      kind: "link" as const,
      accessibleName: "Records",
      route: consumer.start.route,
      roles: consumer.actor.roles,
      action: "Open the records screen.",
    };
    consumer.controls.push(navigationControl);
    consumer.steps.unshift({
      id: "records-visible",
      description: "The saved records are visible.",
      kind: "result",
      route: consumer.start.route,
      controlId: navigationControl.id,
      reads: [entity.entityKey],
      writes: [],
      visibleResult: "The saved record is visible.",
    });
    handoff.consumerControlId = navigationControl.id;
    handoff.consumerRoute = consumer.start.route;

    const compiled = compileAcceptanceTests(input);

    expect(compiled.compiledSource).toMatch(
      /const consumer = vfControl\([\s\S]*?"open-records-link"\);[\s\S]*?await consumer\.click\(\);/,
    );
  });

  it("uses the control type when an input interaction is described as an action", () => {
    const input = relationJourneyInput();
    const consumer = input.architecture.workflowContracts[1];
    const selectStep = consumer?.steps.find((step) => step.controlId);
    const selectControl = consumer?.controls.find(
      (control) => control.id === selectStep?.controlId,
    );
    if (!consumer || !selectStep || !selectControl) {
      throw new Error("Relation selector missing");
    }
    selectControl.kind = "combobox";
    selectStep.kind = "action";

    const compiled = compileAcceptanceTests(input);
    const manifestStep = compiled.manifest.journeys
      .flatMap((journey) => journey.steps)
      .find(
        (step) =>
          step.workflowId === consumer.id &&
          step.contractStepId === selectStep.id,
      );

    expect(manifestStep?.primitive).toBe("select");
  });

  it("asserts the written record when a save result also names a related entity", () => {
    const input = relationJourneyInput();
    const consumer = input.architecture.workflowContracts[1];
    const save = consumer?.expectedSaves[0];
    if (!consumer || !save) throw new Error("Relation consumer save missing");
    const saveStep = consumer.steps.find((step) => step.id === save.stepId);
    if (!saveStep) throw new Error("Relation consumer save step missing");
    saveStep.reads = ["trip", "trip_day"];
    saveStep.writes = ["trip_day"];
    saveStep.visibleResult =
      "The selected trip appears on the saved trip day record.";

    const compiled = compileAcceptanceTests(input);
    const manifestStep = compiled.manifest.journeys
      .flatMap((journey) => journey.steps)
      .find(
        (step) =>
          step.workflowId === consumer.id &&
          step.contractStepId === saveStep.id,
      );
    const fixture = compiled.manifest.journeys
      .flatMap((journey) => journey.fixtures)
      .find((candidate) => candidate.id === manifestStep?.assertionFixtureId);

    expect(fixture?.entityKey).toBe(saveStep.writes[0]);
  });
});

function relationJourneyInput() {
  const input = golden("simple-local-storage");
  input.spec.dataEntities = [
    {
      name: "Trip",
      description: "A saved trip.",
      ownership: "per_user",
      fields: [
        {
          name: "Trip Name",
          label: "Trip name",
          type: "text",
          required: true,
          validation: "",
        },
      ],
      relationships: [],
    },
    {
      name: "Trip Day",
      description: "One day belonging to a trip.",
      ownership: "per_user",
      fields: [
        {
          name: "Day Name",
          label: "Day name",
          type: "text",
          required: true,
          validation: "",
        },
        {
          name: "Trip",
          label: "Trip",
          type: "relation",
          required: true,
          validation: "Choose a saved trip.",
        },
      ],
      relationships: [
        {
          type: "belongs_to",
          targetEntity: "Trip",
          description: "Each day belongs to one trip.",
        },
      ],
    },
  ];
  input.spec.workflows = [
    {
      name: "Create trip",
      actor: "Traveler",
      trigger: "A trip is planned",
      steps: ["Enter trip name", "Save trip", "See saved trip"],
      successOutcome: "The trip is visible.",
      failureStates: ["Validation error"],
    },
    {
      name: "Add trip day",
      actor: "Traveler",
      trigger: "A saved trip needs a day",
      steps: ["Choose saved trip", "Enter day name", "Save trip day"],
      successOutcome: "The day appears under the trip.",
      failureStates: ["Validation error"],
    },
  ];
  input.architecture = createFallbackArchitecturePlan(
    input.spec,
    computeSpecComplexity(input.spec),
  );
  const [producer, consumer] = input.architecture.workflowContracts;
  if (!producer || !consumer) throw new Error("Relation contracts missing");
  consumer.dependencies.workflowIds = [producer.id];
  const producerSave = producer.expectedSaves[0];
  const consumerControl = consumer.controls.find((control) =>
    consumer.steps.some((step) => step.controlId === control.id),
  );
  if (!producerSave || !consumerControl) {
    throw new Error("Relation handoff contract missing");
  }
  producer.handoffs = [
    {
      id: "saved-trip-for-trip-day",
      fromStepId: producerSave.stepId,
      produces: producerSave.producedReference,
      storage: producerSave.storage,
      consumerWorkflowId: consumer.id,
      consumerRoute: consumer.start.route,
      consumerControlId: consumerControl.id,
      loadRule: "Load the saved trip in the trip-day selector.",
    },
  ];
  return input;
}

function splitJourneyInput() {
  const input = golden("simple-local-storage");
  const template = input.architecture.workflowContracts[0];
  if (!template) throw new Error("Golden contract missing");
  const contracts = Array.from({ length: 4 }, (_, index) => {
    const contract = structuredClone(template);
    const number = index + 1;
    const stepIds = new Map<string, string>();
    const controlIds = new Map<string, string>();
    contract.id = `workflow-${number}`;
    contract.name = `Workflow ${number}`;
    contract.controls = contract.controls.map((control, controlIndex) => {
      const id = `workflow-${number}-control-${controlIndex + 1}`;
      controlIds.set(control.id, id);
      return { ...control, id };
    });
    contract.steps = contract.steps.map((step, stepIndex) => {
      const id = `workflow-${number}-step-${stepIndex + 1}`;
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
      producedReference: `workflow-${number}-record`,
    }));
    contract.dependencies = {
      ...contract.dependencies,
      workflowIds: index === 0 ? [] : [`workflow-${number - 1}`],
    };
    contract.handoffs = [];
    contract.source = {
      ...contract.source,
      workflowName: contract.name,
    };
    return contract;
  });
  const producer = contracts[2];
  const consumer = contracts[3];
  const producerSave = producer?.expectedSaves[0];
  const consumerControl = consumer?.controls.find((control) =>
    consumer.steps.some((step) => step.controlId === control.id),
  );
  if (!producer || !consumer || !producerSave || !consumerControl) {
    throw new Error("Split handoff contracts are incomplete");
  }
  producer.handoffs = [
    {
      id: "workflow-3-to-workflow-4",
      fromStepId: producerSave.stepId,
      produces: producerSave.producedReference,
      storage: producerSave.storage,
      consumerWorkflowId: consumer.id,
      consumerRoute: consumer.start.route,
      consumerControlId: consumerControl.id,
      loadRule: "Load the producer record before the dependent workflow.",
    },
  ];
  input.architecture.workflowContracts = contracts;
  return input;
}

function completionHandoffInput() {
  const item = GOLDEN_REGRESSION_SPECS.find(
    (candidate) => candidate.id === "shared-platform-data",
  );
  if (!item) throw new Error("Missing shared platform-data golden spec");
  const spec = structuredClone(item.spec);
  const chore = spec.dataEntities[0];
  if (!chore) throw new Error("Shared golden spec has no Chore entity");
  chore.fields = [
    {
      name: "Chore Title",
      label: "Chore title",
      type: "text",
      required: true,
      validation: "",
    },
    {
      name: "Completed",
      label: "Completed",
      type: "boolean",
      required: true,
      validation: "",
    },
  ];
  const architecture = createFallbackArchitecturePlan(
    spec,
    computeSpecComplexity(spec),
  );
  architecture.workflowContracts = completionContracts();
  return { spec, architecture };
}

function completionContracts(): WorkflowContract[] {
  const shared: Pick<
    WorkflowContract,
    | "actor"
    | "trigger"
    | "start"
    | "requiredData"
    | "failureStates"
    | "dependencies"
  > = {
    actor: { persona: "Family editor", roles: ["owner", "editor"] },
    trigger: "user_action",
    start: {
      route: "/",
      screen: "Chores",
      preconditions: ["The user is signed in to VoiceForge."],
    },
    requiredData: [
      {
        entityName: "Chore",
        entityKey: "chore",
        operations: ["read", "create", "update"],
        requiredFieldKeys: ["chore_title", "completed"],
      },
    ],
    failureStates: ["Validation error", "Save error"],
    dependencies: { workflowIds: [], platformServices: ["data"] },
  };
  return [
    {
      ...shared,
      id: "add-a-chore",
      name: "Add a chore",
      controls: [
        {
          id: "chore-title",
          kind: "textbox",
          accessibleName: "Chore title",
          route: "/",
          roles: ["owner", "editor"],
          action: "Enter the chore title.",
        },
        {
          id: "save-chore",
          kind: "button",
          accessibleName: "Save chore",
          route: "/",
          roles: ["owner", "editor"],
          action: "Save the chore.",
        },
      ],
      steps: [
        {
          id: "enter-chore-title",
          description: "Enter a chore title.",
          kind: "input",
          route: "/",
          controlId: "chore-title",
          reads: [],
          writes: ["chore"],
          visibleResult: "The entered title is visible.",
        },
        {
          id: "save-chore-record",
          description: "Save the new chore.",
          kind: "save",
          route: "/",
          controlId: "save-chore",
          reads: [],
          writes: ["chore"],
          visibleResult: "The chore is added as Not completed.",
        },
        {
          id: "show-created-chore",
          description: "Show the saved chore.",
          kind: "result",
          route: "/",
          controlId: "",
          reads: ["chore"],
          writes: [],
          visibleResult: "The saved chore shows Not completed.",
        },
      ],
      expectedSaves: [
        {
          stepId: "save-chore-record",
          operation: "create",
          entityName: "Chore",
          entityKey: "chore",
          fieldKeys: ["chore_title", "completed"],
          storage: "platformData",
          producedReference: "saved-chore",
        },
      ],
      success: {
        message: "Chore saved.",
        visibleResult: "The saved chore shows Not completed.",
        route: "/",
      },
      handoffs: [
        {
          id: "created-chore-for-completion",
          fromStepId: "save-chore-record",
          produces: "saved-chore",
          storage: "platformData",
          consumerWorkflowId: "complete-a-chore",
          consumerRoute: "/",
          consumerControlId: "complete-chore",
          loadRule: "Load the saved chore from platform data.",
        },
      ],
      source: {
        workflowName: "Add a chore",
        acceptanceCriteria: ["A saved chore is visible."],
        testScenarios: ["Add a chore."],
      },
    },
    {
      ...shared,
      id: "complete-a-chore",
      name: "Complete a chore",
      controls: [
        {
          id: "complete-chore",
          kind: "button",
          accessibleName: "Complete",
          route: "/",
          roles: ["owner", "editor"],
          action: "Complete the selected chore.",
        },
      ],
      steps: [
        {
          id: "select-complete",
          description: "Select Complete for the saved chore.",
          kind: "action",
          route: "/",
          controlId: "complete-chore",
          reads: ["chore"],
          writes: ["chore"],
          visibleResult:
            "The selected chore begins updating and its Complete control is temporarily disabled.",
        },
        {
          id: "save-completed-status",
          description: "Save completed as true.",
          kind: "automatic",
          route: "/",
          controlId: "",
          reads: ["chore"],
          writes: ["chore"],
          visibleResult: "The chore remains visible and displays Completed.",
        },
      ],
      expectedSaves: [
        {
          stepId: "save-completed-status",
          operation: "update",
          entityName: "Chore",
          entityKey: "chore",
          fieldKeys: ["completed"],
          storage: "platformData",
          producedReference: "completed-chore",
        },
      ],
      success: {
        message: "Chore completed.",
        visibleResult: "The chore remains visible and displays Completed.",
        route: "/",
      },
      handoffs: [],
      dependencies: {
        workflowIds: ["add-a-chore"],
        platformServices: ["data"],
      },
      source: {
        workflowName: "Complete a chore",
        acceptanceCriteria: ["A completed chore remains visible."],
        testScenarios: ["Complete a saved chore."],
      },
    },
  ];
}

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}
