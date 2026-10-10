import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import { GOLDEN_REGRESSION_SPECS } from "../build/golden-regression-specs";
import { computeSpecComplexity } from "../spec";
import { ensureWorkflowContracts } from "../workflow-contract";
import {
  canUseSimpleLocalStorageStarter,
  generateSimpleLocalStorageStarterApp,
} from "./simple-local-storage-starter";

describe("deterministic simple localStorage starter", () => {
  it("generates the canonical one-screen CRUD app without AI structure", () => {
    const golden = GOLDEN_REGRESSION_SPECS.find(
      (candidate) => candidate.id === "simple-local-storage",
    );
    if (!golden) throw new Error("Missing simple localStorage golden spec");
    const architecture = createFallbackArchitecturePlan(
      golden.spec,
      computeSpecComplexity(golden.spec),
    );

    expect(
      canUseSimpleLocalStorageStarter({ spec: golden.spec, architecture }),
    ).toBe(true);
    const result = generateSimpleLocalStorageStarterApp({
      spec: golden.spec,
      architecture,
    });

    expect(result.phases[0]?.turnLimit).toBe(0);
    expect(result.files["src/lib/simple-app-storage.ts"]).toContain(
      "window.localStorage",
    );
    expect(result.files["src/components/SimpleLocalApp.tsx"]).toContain(
      "data-vf-control",
    );
    expect(result.files["src/components/SimpleLocalApp.tsx"]).not.toContain(
      "contractAttributes(",
    );
    expect(result.files["src/components/SimpleLocalApp.test.tsx"]).toContain(
      "validates, adds, edits, completes, filters, deletes, and restores records",
    );
  });

  it("leaves multi-screen or server-backed apps on the normal generator path", () => {
    const golden = GOLDEN_REGRESSION_SPECS.find(
      (candidate) => candidate.id === "shared-platform-data",
    );
    if (!golden) throw new Error("Missing shared platform-data golden spec");
    const architecture = createFallbackArchitecturePlan(
      golden.spec,
      computeSpecComplexity(golden.spec),
    );

    expect(
      canUseSimpleLocalStorageStarter({ spec: golden.spec, architecture }),
    ).toBe(false);
  });

  it("recompiles malformed AI controls before selecting the simple blueprint", () => {
    const golden = GOLDEN_REGRESSION_SPECS.find(
      (candidate) => candidate.id === "simple-local-storage",
    );
    if (!golden) throw new Error("Missing simple localStorage golden spec");
    const spec = structuredClone(golden.spec);
    const editWorkflow = spec.workflows.find((workflow) =>
      /\bedit\b/i.test(workflow.name),
    );
    const completionWorkflow = spec.workflows.find((workflow) =>
      /\bcompletion\b/i.test(workflow.name),
    );
    const filterWorkflow = spec.workflows.find((workflow) =>
      /\bfilter\b/i.test(workflow.name),
    );
    if (!editWorkflow || !completionWorkflow || !filterWorkflow) {
      throw new Error("Missing simple workflow fixtures");
    }
    editWorkflow.steps = [
      "Open editing for an item.",
      "Change the name.",
      "Save the change.",
      "Check that the revised name is not blank.",
      "Update the saved item in the browser.",
    ];
    completionWorkflow.name = "Toggle completion";
    completionWorkflow.steps = [
      "Choose the completion control for an item.",
      "Update its completed status.",
      "Save the changed status in the browser.",
      "Refresh the filtered view if needed.",
    ];
    filterWorkflow.name = "Filter list";
    filterWorkflow.steps = [
      "Select one of the three filters.",
      "Display only items that match the selected status.",
      "Show a clear empty state if the selected filter has no matching items.",
    ];
    const malformed = structuredClone(
      createFallbackArchitecturePlan(
        spec,
        computeSpecComplexity(spec),
      ),
    );
    const edit = malformed.workflowContracts.find((contract) =>
      /\bedit\b/i.test(contract.name),
    );
    const filter = malformed.workflowContracts.find((contract) =>
      /\bfilter\b/i.test(contract.name),
    );
    if (!edit || !filter) throw new Error("Missing simple CRUD contracts");
    const editInput = edit.steps.find((step) => step.kind === "input");
    const editSave = edit.steps.find((step) =>
      edit.expectedSaves.some((save) => save.stepId === step.id),
    );
    const saveControl = edit.controls.find(
      (control) => control.id === editSave?.controlId,
    );
    if (!editInput || !editSave || !saveControl) {
      throw new Error("Missing edit controls");
    }
    edit.controls = edit.controls.filter(
      (control) => control.id !== editInput.controlId,
    );
    editInput.controlId = saveControl.id;
    editSave.controlId = "";
    filter.controls[0].kind = "textbox";
    filter.controls[0].accessibleName = "Select one of the three filters";
    filter.controls[0].action = "Select one of the three filters.";
    filter.steps[0].description = "Select one of the three filters.";

    const normalized = ensureWorkflowContracts(spec, malformed);
    const normalizedEdit = normalized.workflowContracts.find((contract) =>
      /\bedit\b/i.test(contract.name),
    );
    const normalizedFilter = normalized.workflowContracts.find((contract) =>
      /\bfilter\b/i.test(contract.name),
    );
    const normalizedCompletion = normalized.workflowContracts.find((contract) =>
      /\bcompletion\b/i.test(contract.name),
    );
    const normalizedSave = normalizedEdit?.steps.find((step) =>
      normalizedEdit.expectedSaves.some((save) => save.stepId === step.id),
    );
    const normalizedInput = normalizedEdit?.steps.find(
      (step) => step.kind === "input",
    );

    expect(normalizedFilter?.controls[0]).toMatchObject({ kind: "combobox" });
    expect(normalizedInput?.controlId).not.toBe(normalizedSave?.controlId);
    expect(
      canUseSimpleLocalStorageStarter({
        spec,
        architecture: normalized,
      }),
    ).toBe(true);
    const completionControlIds = new Set(
      normalizedCompletion?.controls.map((control) => control.id) ?? [],
    );
    const completionHandoffs = normalized.workflowContracts.flatMap((contract) =>
      contract.handoffs.filter(
        (handoff) => handoff.consumerWorkflowId === normalizedCompletion?.id,
      ),
    );
    expect(completionHandoffs.length).toBeGreaterThan(0);
    expect(
      completionHandoffs.every((handoff) =>
        completionControlIds.has(handoff.consumerControlId),
      ),
    ).toBe(true);
  });
});
