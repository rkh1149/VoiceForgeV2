import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import { computeSpecComplexity } from "../spec";
import { GOLDEN_REGRESSION_SPECS } from "./golden-regression-specs";
import { createWorkflowImplementationMatrix } from "./workflow-implementation-matrix";

describe("workflow implementation matrix", () => {
  it("maps controls, exact writes, saves, and journeys before generation", () => {
    const golden = GOLDEN_REGRESSION_SPECS.find((item) => item.id === "shared-platform-data");
    if (!golden) throw new Error("missing golden spec");
    const architecture = createFallbackArchitecturePlan(
      golden.spec,
      computeSpecComplexity(golden.spec),
    );
    const matrix = createWorkflowImplementationMatrix({ spec: golden.spec, architecture });

    expect(matrix.blockingIssues).toEqual([]);
    expect(matrix.rows).toHaveLength(architecture.workflowContracts.length);
    expect(matrix.rows[0]?.controls.length).toBeGreaterThan(0);
    expect(matrix.rows[0]?.writes).toContain("chore");
    expect(matrix.rows[0]?.acceptanceJourneyRequired).toBe(true);
  });
});
