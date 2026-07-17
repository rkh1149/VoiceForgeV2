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
