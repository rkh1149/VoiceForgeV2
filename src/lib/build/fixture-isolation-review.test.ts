import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import { computeSpecComplexity } from "../spec";
import { compileAcceptanceTests } from "./acceptance-compiler";
import { analyzeFixtureIsolation } from "./fixture-isolation-review";
import { GOLDEN_REGRESSION_SPECS } from "./golden-regression-specs";

function compiledGolden() {
  const golden = GOLDEN_REGRESSION_SPECS.find(
    (candidate) => candidate.id === "shared-platform-data",
  );
  if (!golden) throw new Error("Shared golden spec missing");
  const architecture = createFallbackArchitecturePlan(
    golden.spec,
    computeSpecComplexity(golden.spec),
  );
  return compileAcceptanceTests({ spec: golden.spec, architecture });
}

describe("Stage 14I fixture isolation review", () => {
  it("verifies the deterministic golden acceptance source", () => {
    const compiled = compiledGolden();

    expect(compiled.isolationReview.status).toBe("verified");
    expect(compiled.isolationReview.blockingIssues).toEqual([]);
    expect(compiled.isolationReview.summary.journeys).toBeGreaterThan(0);
    expect(compiled.isolationReview.summary.sharedNamespaces).toBe(
      compiled.manifest.summary.journeys,
    );
  });

  it("rejects serial execution and mutable module state", () => {
    const compiled = compiledGolden();
    const report = analyzeFixtureIsolation({
      manifest: compiled.manifest,
      compiledSource: `${compiled.compiledSource}\nlet savedRecordId = "";\ntest.describe.serial("bad", () => {});`,
    });

    expect(report.status).toBe("needs_repair");
    expect(report.blockingIssues.join(" ")).toContain("serial execution");
    expect(report.blockingIssues.join(" ")).toContain("mutable module variables");
  });

  it("rejects a declared prerequisite without visible setup", () => {
    const compiled = compiledGolden();
    const journey = compiled.manifest.journeys[0];
    if (!journey) throw new Error("Golden journey missing");
    journey.prerequisites = [
      {
        id: "setup-missing",
        journeyId: "missing-producer",
        workflowIds: ["missing-workflow"],
        storage: ["localStorage"],
        entityKeys: ["record"],
        fixtureIds: [],
        setupStrategy: "visible_ui",
      },
    ];

    const report = analyzeFixtureIsolation({
      manifest: compiled.manifest,
      compiledSource: compiled.compiledSource,
    });

    expect(report.blockingIssues.join(" ")).toContain(
      "missing visible setup for missing-producer",
    );
  });

  it("rejects replay of a workflow outside the selected prerequisite closure", () => {
    const compiled = compiledGolden();
    const target = compiled.manifest.journeys[0];
    const sourceJourney = compiled.manifest.journeys[0];
    const selected = sourceJourney?.steps[0];
    if (!target || !sourceJourney || !selected) {
      throw new Error("Golden journey fixture missing");
    }
    const unrelated = {
      ...selected,
      id: "unrelated-workflow:unrelated-step",
      workflowId: "unrelated-workflow",
      contractStepId: "unrelated-step",
    };
    sourceJourney.steps.push(unrelated);
    const prerequisite = {
      id: "setup-selected-workflow",
      journeyId: sourceJourney.id,
      workflowIds: [selected.workflowId],
      storage: ["platformData" as const],
      entityKeys: [],
      fixtureIds: [],
      setupStrategy: "visible_ui" as const,
    };
    target.prerequisites = [prerequisite];
    const setupMarker = `workflowFixtureSetupTitle(${JSON.stringify(
      target.id,
    )}, ${JSON.stringify(sourceJourney.id)})`;
    const selectedMarker = `workflowFixtureStepTitle(${JSON.stringify(
      target.id,
    )}, ${JSON.stringify(sourceJourney.id)}, ${JSON.stringify(
      selected.workflowId,
    )}, ${JSON.stringify(selected.contractStepId)}, "selected")`;
    const marker = `workflowFixtureStepTitle(${JSON.stringify(
      target.id,
    )}, ${JSON.stringify(prerequisite.journeyId)}, ${JSON.stringify(
      unrelated.workflowId,
    )}, ${JSON.stringify(unrelated.contractStepId)}, "injected")`;

    const report = analyzeFixtureIsolation({
      manifest: compiled.manifest,
      compiledSource: `${setupMarker}\n${selectedMarker}\n${compiled.compiledSource}\n${marker}`,
    });

    expect(report.blockingIssues).toContainEqual(
      expect.stringContaining("replays unrelated prerequisite workflow"),
    );
  });
});
