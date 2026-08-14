import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectChangeWorkflow } from "./change-workflow";

describe("selectChangeWorkflow", () => {
  it("keeps routine feature changes in standard mode", () => {
    const workflow = selectChangeWorkflow({
      changeSummary: "Add a printable summary view for next week's meals.",
    });

    expect(workflow.mode).toBe("standard");
    expect(workflow.reasons).toEqual(["routine targeted change"]);
  });

  it("uses deep diagnostics for save and submit failures", () => {
    const workflow = selectChangeWorkflow({
      changeSummary: "The Save button does not save the new activity.",
    });

    expect(workflow.mode).toBe("deep-diagnostic");
    expect(workflow.reasons).toContain("bug-like change request");
    expect(workflow.acceptanceFocus.join(" ")).toContain("persists after refresh");
  });

  it("uses deep diagnostics when manually requested for routine wording", () => {
    const workflow = selectChangeWorkflow({
      changeSummary: "Change the activity cards to use a compact layout.",
      forceDeepDiagnostic: true,
    });

    expect(workflow.mode).toBe("deep-diagnostic");
    expect(workflow.forceDeepDiagnostic).toBe(true);
    expect(workflow.reasons).toContain(
      "manual Deep Diagnostic Change Mode requested",
    );
  });

  it("escalates after prior failed change attempts", () => {
    const workflow = selectChangeWorkflow({
      changeSummary: "Adjust the activity card spacing.",
      previousFailedChangeCount: 2,
    });

    expect(workflow.mode).toBe("deep-diagnostic");
    expect(workflow.previousFailedChangeCount).toBe(2);
    expect(workflow.reasons).toContain("2 prior failed change attempt(s)");
  });
});

describe("coder shared rules", () => {
  it("requires drag/drop tests to mock DataTransfer as a MIME-keyed store", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("DataTransfer");
    expect(source).toContain("MIME-keyed store");
    expect(source).toContain("Map<string, string>");
    expect(source).toContain("text/plain fallback overwrite");
  });

  it("forbids raw generated images in platform data payloads", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("64 KB");
    expect(source).toContain("imageBase64");
    expect(source).toContain("generatedImage");
    expect(source).toContain("uploadPlatformFileData");
    expect(source).toContain("save only the returned file id/reference");
  });

  it("requires relation validation to separate field values from errors", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("recipeIdError");
    expect(source).toContain("valid saved relation id is accepted");
    expect(source).toContain("unknown relation id is rejected");
    expect(source).toContain("valid save test must reach createPlatformRecord");
    expect(source).toContain("Do not patch only the test or mock");
  });

  it("requires contracted workflows to be visibly discoverable", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("UI AFFORDANCE CONTRACT");
    expect(source).toContain("reachable from / through visible");
    expect(source).toContain("exact contract route");
    expect(source).toContain("contract accessibleName");
    expect(source).toContain("action-specific aria-label");
    expect(source).toContain("placeholder-only workflow pages");
    expect(source).toContain("literal href and label fields");
  });

  it("requires durable saves, refresh loads, and downstream handoffs", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("PERSISTENCE AND HANDOFF CONTRACT");
    expect(source).toContain("exact entity key and exact field keys");
    expect(source).toContain("React state alone is never proof of persistence");
    expect(source).toContain("saved record id and required relationship ids");
    expect(source).toContain("remount or refresh");
    expect(source).toContain("persist only the returned file id/reference");
  });

  it("requires Stage 12B helpers when architecture requires search or reports", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("searchPlatformRecords is mandatory");
    expect(source).toContain("filtering it only in React does not satisfy");
    expect(source).toContain("runPlatformRecordReport");
    expect(source).toContain("exportPlatformRecordsCsv");
  });

  it("requires traceable Stage 14D browser journeys", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("STAGE 14D BROWSER ACCEPTANCE CONTRACT");
    expect(source).toContain("workflowJourneyTitle");
    expect(source).toContain("workflowStepTitle");
    expect(source).toContain("workflowSaveTitle");
    expect(source).toContain("workflowHandoffTitle");
    expect(source).toContain("Every navigate trace block must itself");
    expect(source).toContain("nest the workflowStepTitle block");
    expect(source).toContain("every supplied saveId still needs its own reload");
    expect(source).toContain("expectPersistedAfterReload");
    expect(source).toContain("test.describe.serial");
    expect(source).toContain("dependsOnJourneyIds");
    expect(source).toContain("fresh browser context");
    expect(source).toContain("replay the necessary prerequisite workflows");
    expect(source).toContain("Before a state-clearing action");
    expect(source).toContain("stable visible navigation link");
    expect(source).toContain("acceptanceRunSuffix");
    expect(source).toContain("substring-based by default");
    expect(source).toContain("strict-mode locator failure");
    expect(source).toContain("exact: true");
    expect(source).toContain("scope the locator to the named form or dialog");
    expect(source).toContain("audit the rest of that journey");
    expect(source).toContain("Native select option elements are hidden");
    expect(source).toContain("toHaveCount(1), never toBeVisible()");
    expect(source).toContain("never click a Next.js link and immediately reload");
    expect(source).toContain("Do not use test.skip");
  });

  it("requires stable Stage 14G contract controls and record scoping", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("STAGE 14G STABLE CONTRACT CONTROLS");
    expect(source).toContain('data-vf-workflow="<workflowId>"');
    expect(source).toContain('data-vf-control="<controlId>"');
    expect(source).toContain("data-vf-record={record.id}");
    expect(source).toContain("vfRecordControl");
    expect(source).toContain("Accessible-name fallback is only");
  });

  it("continues a generation phase once when its initial turn budget is exhausted", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("MaxTurnsExceededError");
    expect(source).toContain("error.state");
    expect(source).toContain("GENERATION_PHASE_CONTINUATION_TURNS");
    expect(source).toContain("after one automatic continuation");
  });

  it("requires the debug agent to apply an actionable repair before replying", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("MUST apply it with patch_file or write_file");
    expect(source).toContain("do not stop after merely describing the edit");
  });

  it("keeps Stage 14F repairs inside the classified workflow graph", () => {
    const source = readFileSync(new URL("./coder.ts", import.meta.url), "utf8");

    expect(source).toContain("WORKFLOW-AWARE REPAIR RULES");
    expect(source).toContain("producer, save, consumer, and targeted journey");
    expect(source).toContain('targetSurface "generated_test"');
    expect(source).toContain('targetSurface "application_source"');
    expect(source).toContain("Never disguise a failure");
    expect(source).toContain(
      "must preserve every existing workflowStepTitle block",
    );
    expect(source).toContain("leave an empty step marker");
    expect(source).toContain("allowedMutationPaths");
    expect(source).toContain("WORKFLOW REPAIR PACKAGE");
  });
});
