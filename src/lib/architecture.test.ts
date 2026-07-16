import { describe, expect, it } from "vitest";
import {
  createFallbackArchitecturePlan,
  validateArchitecturePlan,
  type ArchitecturePlan,
} from "./architecture";
import { computeSpecComplexity, normalizeAppSpec } from "./spec";

const personalSpecInput = {
  appName: "Reading Timer",
  purpose: "Track one person's reading sessions.",
  targetUsers: "One person",
  screens: [
    {
      name: "Home",
      description: "Start and review reading sessions.",
    },
  ],
  features: ["Start a session", "Save notes"],
  dataToStore: ["reading sessions with title and notes"],
  needsLogin: false,
  sharingModel: "private" as const,
  aiFeatures: [],
  testPlan: ["Start a session"],
  deploymentNotes: "",
};

const sharedSpecInput = {
  ...personalSpecInput,
  appName: "Family Chore Board",
  purpose: "Help the family share chores.",
  targetUsers: "A family of five",
  features: ["Add chores", "Assign chores", "Mark chores complete"],
  dataToStore: ["chores with assignee, due date, and status"],
  needsLogin: true,
  sharingModel: "shared" as const,
  testPlan: ["Assign and complete a chore"],
};

describe("architecture planning", () => {
  it("allows personal browser-only apps to continue to code generation", () => {
    const spec = normalizeAppSpec(personalSpecInput);
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan);

    expect(plan.capabilityValidation.canBuildNow).toBe(true);
    expect(validation.canBuildNow).toBe(true);
    expect(validation.blockingIssues).toEqual([]);
  });

  it("blocks shared apps until generated-app data and user services exist", () => {
    const spec = normalizeAppSpec(sharedSpecInput);
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan);

    expect(plan.capabilityValidation.canBuildNow).toBe(false);
    expect(validation.canBuildNow).toBe(false);
    expect(validation.blockingIssues.some((issue) => issue.startsWith("data:"))).toBe(
      true,
    );
    expect(validation.blockingIssues.some((issue) => issue.startsWith("users:"))).toBe(
      true,
    );
  });

  it("blocks required unavailable platform services even if the agent misses them", () => {
    const spec = normalizeAppSpec(personalSpecInput);
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const planWithFiles: ArchitecturePlan = {
      ...plan,
      platformServices: [
        ...plan.platformServices,
        {
          service: "files",
          required: true,
          availability: "later",
          reason: "Files need platform blob storage.",
        },
      ],
      capabilityValidation: {
        ...plan.capabilityValidation,
        canBuildNow: true,
        blockingIssues: [],
      },
    };

    const validation = validateArchitecturePlan(planWithFiles);

    expect(validation.canBuildNow).toBe(false);
    expect(validation.blockingIssues).toContain(
      "files: Files need platform blob storage.",
    );
  });
});
