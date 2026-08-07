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
  });
});
