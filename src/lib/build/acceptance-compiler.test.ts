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

describe("Stage 14H deterministic acceptance compiler", () => {
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
    expect(files[ACCEPTANCE_MANIFEST_SOURCE_PATH]).toContain('"version": 2');
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
    const handoff = compiled.compiledSource.indexOf(
      'workflowHandoffTitle("created-chore-for-completion")',
    );
    const consumerAction = compiled.compiledSource.indexOf(
      'workflowStepTitle("complete-a-chore", "select-complete"',
    );
    expect(producerResult).toBeGreaterThan(-1);
    expect(handoff).toBeGreaterThan(producerResult);
    expect(consumerAction).toBeGreaterThan(handoff);
    expect(compiled.compiledSource).toContain('toContainText("Not completed")');
    expect(compiled.compiledSource).toContain('toContainText("Completed")');
    expect(compiled.compiledSource).toContain("const consumerRecord = vfRecords");
    expect(compiled.compiledSource).not.toContain(
      "The selected chore begins updating and its Complete control is temporarily disabled.",
    );
  });
});

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
