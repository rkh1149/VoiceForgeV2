import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import { computeSpecComplexity, normalizeAppSpec, type AppSpec } from "../spec";
import {
  createHumanCompletenessEvidence,
  humanCompletenessPostGenerationReview,
  normalizeHumanCompletenessReview,
  unavailableHumanCompletenessReview,
  type HumanCompletenessReviewCandidate,
} from "./human-completeness-review";
import type { FileMap } from "./template";

function spec(): AppSpec {
  const base = normalizeAppSpec({
    appName: "Family Story Shelf",
    purpose: "Let a child choose and play a built-in story.",
    targetUsers: "Young children and their family",
    screens: [
      { name: "Story shelf", description: "Choose a story to play." },
      { name: "Story player", description: "Read the selected story." },
    ],
    features: ["Choose a story", "Start another story"],
    dataToStore: [],
    needsLogin: false,
    sharingModel: "private" as const,
    aiFeatures: [],
    testPlan: ["Choose and play a story", "Start another story"],
    deploymentNotes: "",
  });
  return {
    ...base,
    workflows: [
      {
        name: "Choose and play a story",
        actor: "Child",
        trigger: "The child opens the story shelf.",
        steps: ["Choose a story", "Read the story", "See the ending"],
        successOutcome: "The selected story ending is visible.",
        failureStates: [],
      },
      {
        name: "Start another story",
        actor: "Child",
        trigger: "The child reaches a story ending.",
        steps: ["Choose another story", "Return to the story shelf"],
        successOutcome: "The story shelf is visible again.",
        failureStates: [],
      },
    ],
    acceptanceCriteria: [
      {
        name: "Play a story",
        scenario: "A child completes a story.",
        given: "The shelf is open.",
        when: "The child chooses a story.",
        then: "The ending is visible.",
      },
    ],
    testScenarios: [
      {
        name: "Play a story",
        type: "browser",
        steps: ["Choose a story", "Read the ending"],
        expectedResult: "The story ending is visible.",
      },
    ],
  };
}

const files: FileMap = {
  "src/app/page.tsx": `export default function Page() { return <a href="/story">Choose a story</a>; }`,
  "src/app/story/page.tsx": `export default function Story() { return <main><h1>Story ending</h1><a href="/">Start another story</a></main>; }`,
  "e2e/generated/story.spec.ts": `test("story", async ({ page }) => { await page.getByRole("link", { name: "Choose a story" }).click(); await expect(page.getByRole("heading", { name: "Story ending" })).toBeVisible(); });`,
};

function evidence() {
  const appSpec = spec();
  const architecture = createFallbackArchitecturePlan(
    appSpec,
    computeSpecComplexity(appSpec),
  );
  return createHumanCompletenessEvidence({
    spec: appSpec,
    architecture,
    files,
    source: {
      provenance: "linked_conversation",
      userMessages: ["Please make a story app for my grandchild."],
      approvedSummary: "Choose and play built-in stories.",
      changeSummary: "",
    },
    changedFilePaths: Object.keys(files),
    deletedFilePaths: [],
    phases: [
      {
        id: "pages-workflows",
        label: "Pages and workflows",
        filesWritten: Object.keys(files),
        notes: "Added the story shelf, player, and browser journey.",
      },
    ],
    deterministicReviews: [],
  });
}

function supportedCandidate(): HumanCompletenessReviewCandidate {
  return {
    overallAssessment: "The requested story experience is present.",
    assessments: evidence().promises.map((promise) => ({
      promiseId: promise.id,
      verdict: "supported" as const,
      confidence: "high" as const,
      finding: "The visible workflow is implemented.",
      userImpact: "The child can complete the promised experience.",
      repairRecommendation: "No repair needed.",
      workflowIds: promise.workflowIds,
      codeEvidence: [
        { path: "src/app/page.tsx", explanation: "Visible story choice." },
      ],
      testEvidence: [
        {
          path: "e2e/generated/story.spec.ts",
          explanation: "The browser journey reaches the ending.",
        },
      ],
    })),
    limitations: [],
  };
}

const inspections = [
  { operation: "read" as const, path: "src/app/page.tsx" },
  { operation: "read" as const, path: "src/app/story/page.tsx" },
  { operation: "read" as const, path: "e2e/generated/story.spec.ts" },
];

describe("human completeness review", () => {
  it("builds a bounded product evidence packet from the approved app", () => {
    const packet = evidence();

    expect(packet.source.provenance).toBe("linked_conversation");
    expect(
      packet.promises.some((promise) => promise.kind === "original_request"),
    ).toBe(true);
    expect(packet.promises.some((promise) => promise.kind === "workflow")).toBe(
      true,
    );
    expect(packet.promises.some((promise) => promise.kind === "feature")).toBe(
      true,
    );
    expect(packet.generated.routeFiles).toContain("src/app/story/page.tsx");
    expect(packet.generated.testFiles).toContain(
      "e2e/generated/story.spec.ts",
    );
  });

  it("passes when every approved promise has inspected implementation evidence", () => {
    const report = normalizeHumanCompletenessReview({
      evidence: evidence(),
      files,
      candidate: supportedCandidate(),
      inspections,
    });

    expect(report.verdict).toBe("complete");
    expect(report.blockingIssues).toEqual([]);
    expect(report.summary.supported).toBe(report.summary.promisesReviewed);
    expect(humanCompletenessPostGenerationReview(report).status).toBe("passed");
  });

  it("blocks a high-confidence core promise gap with inspected evidence", () => {
    const packet = evidence();
    const candidate = supportedCandidate();
    const target = packet.promises.find(
      (promise) => promise.kind === "workflow",
    );
    if (!target) throw new Error("Missing workflow promise fixture");
    const assessment = candidate.assessments.find(
      (item) => item.promiseId === target.id,
    );
    if (!assessment) throw new Error("Missing workflow assessment fixture");
    Object.assign(assessment, {
      verdict: "missing",
      confidence: "high",
      finding: "The story ending cannot be reached from the story shelf.",
      userImpact: "A child cannot finish the selected story.",
      repairRecommendation: "Connect the story choice to the story player.",
    });

    const report = normalizeHumanCompletenessReview({
      evidence: packet,
      files,
      candidate,
      inspections,
    });

    expect(report.verdict).toBe("incomplete");
    expect(report.blockingIssues).toHaveLength(1);
    expect(report.blockingIssues[0]).toContain(`human_completeness:${target.id}`);
    expect(report.blockingIssues[0]).toContain("src/app/page.tsx");
  });

  it("downgrades ungrounded or low-confidence findings to preview warnings", () => {
    const packet = evidence();
    const candidate = supportedCandidate();
    const target = packet.promises.find(
      (promise) => promise.kind === "feature",
    );
    if (!target) throw new Error("Missing feature promise fixture");
    const assessment = candidate.assessments.find(
      (item) => item.promiseId === target.id,
    );
    if (!assessment) throw new Error("Missing feature assessment fixture");
    Object.assign(assessment, {
      verdict: "partially_supported",
      confidence: "low",
      finding: "Runtime behavior is uncertain.",
      userImpact: "The preview should confirm the interaction.",
      repairRecommendation: "Verify the interaction in the browser.",
      codeEvidence: [
        { path: "src/components/Invented.tsx", explanation: "Not a real file." },
      ],
      testEvidence: [],
    });

    const report = normalizeHumanCompletenessReview({
      evidence: packet,
      files,
      candidate,
      inspections,
    });

    expect(report.blockingIssues).toEqual([]);
    expect(report.verdict).toBe("complete_with_notes");
    expect(report.warnings.some((warning) => warning.includes(target.id))).toBe(
      true,
    );
  });

  it("continues with a warning when the semantic reviewer is unavailable", () => {
    const report = unavailableHumanCompletenessReview({
      evidence: evidence(),
      reason: "temporary model timeout",
    });

    expect(report.available).toBe(false);
    expect(report.blockingIssues).toEqual([]);
    expect(report.warnings[0]).toContain("review_unavailable");
  });
});
