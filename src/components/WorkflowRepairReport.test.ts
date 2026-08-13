import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("WorkflowRepairReport", () => {
  it("shows classification, validation, and protected-file evidence", () => {
    const source = readFileSync(
      new URL("./WorkflowRepairReport.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Workflow repairs");
    expect(source).toContain("repair.classification.category");
    expect(source).toContain("repair.classification.targetSurface");
    expect(source).toContain("repair.validation.browserJourney");
    expect(source).toContain("repair.validation.fullGauntlet");
    expect(source).toContain("Changed application files");
    expect(source).toContain("generated tests:");
    expect(source).toContain("repair.scope.protectedPaths.length");
  });
});
