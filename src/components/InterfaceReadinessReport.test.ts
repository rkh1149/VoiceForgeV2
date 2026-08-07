import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("InterfaceReadinessReport", () => {
  it("keeps the workflow, route, control, and entity readiness summary visible", () => {
    const source = readFileSync(
      new URL("./InterfaceReadinessReport.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Interface readiness");
    expect(source).toContain("Can each promised workflow be found and started?");
    expect(source).toContain("workflowsDiscoverable");
    expect(source).toContain("reachableRoutes");
    expect(source).toContain("controlsMatched");
    expect(source).toContain("entityPathsAvailable");
    expect(source).toContain("Needs repair");
    expect(source).toContain("Review details");
  });
});
