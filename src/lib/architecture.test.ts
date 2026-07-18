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

  it("allows signed-in shared apps to use VoiceForge member roles", () => {
    const spec = normalizeAppSpec(sharedSpecInput);
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan);

    expect(plan.capabilityValidation.canBuildNow).toBe(true);
    expect(validation.canBuildNow).toBe(true);
    expect(plan.platformServices).toContainEqual(
      expect.objectContaining({
        service: "users",
        availability: "available",
        required: true,
      }),
    );
    expect(validation.blockingIssues.some((issue) => issue.startsWith("data:"))).toBe(
      false,
    );
    expect(validation.blockingIssues.some((issue) => issue.startsWith("users:"))).toBe(
      false,
    );
  });

  it("allows no-login shared apps to use platform data", () => {
    const spec = normalizeAppSpec({
      ...sharedSpecInput,
      needsLogin: false,
    });
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan);

    expect(plan.dataModel[0].storage).toBe("platformData");
    expect(plan.dependencyProfile).toContain("platformData");
    expect(validation.canBuildNow).toBe(true);
    expect(validation.blockingIssues).toEqual([]);
  });

  it("does not let stale data blockers from the architect stop Stage 9B builds", () => {
    const spec = normalizeAppSpec({
      ...sharedSpecInput,
      needsLogin: false,
    });
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan({
      ...plan,
      capabilityValidation: {
        ...plan.capabilityValidation,
        canBuildNow: false,
        blockingIssues: ["data: Shared server-side records are now available."],
      },
    });

    expect(validation.canBuildNow).toBe(true);
    expect(validation.blockingIssues).toEqual([]);
  });

  it("allows apps with file requirements to use platform files", () => {
    const spec = normalizeAppSpec({
      ...sharedSpecInput,
      features: [...sharedSpecInput.features, "Attach receipts"],
      dataToStore: [...sharedSpecInput.dataToStore, "receipt files"],
    });
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan);

    expect(plan.platformServices).toContainEqual(
      expect.objectContaining({
        service: "files",
        availability: "available",
        required: true,
      }),
    );
    expect(validation.canBuildNow).toBe(true);
    expect(validation.blockingIssues).toEqual([]);
  });

  it("blocks required unavailable platform services even if the agent misses them", () => {
    const spec = normalizeAppSpec(personalSpecInput);
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const planWithEmail: ArchitecturePlan = {
      ...plan,
      platformServices: [
        ...plan.platformServices,
        {
          service: "email",
          required: true,
          availability: "later",
          reason: "Email needs notification delivery.",
        },
      ],
      capabilityValidation: {
        ...plan.capabilityValidation,
        canBuildNow: true,
        blockingIssues: [],
      },
    };

    const validation = validateArchitecturePlan(planWithEmail);

    expect(validation.canBuildNow).toBe(false);
    expect(validation.blockingIssues).toContain(
      "email: Email needs notification delivery.",
    );
  });

  it("allows personal apps with in-app reminders because they are local UI state", () => {
    const base = normalizeAppSpec(personalSpecInput);
    const spec = {
      ...base,
      notifications: [
        {
          name: "In-app expiration reminder",
          trigger: "A saved item is close to its expiration date.",
          recipients: ["Owner"],
          channel: "in_app" as const,
        },
      ],
    };
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan);

    expect(validation.canBuildNow).toBe(true);
    expect(validation.blockingIssues).toEqual([]);
    expect(validation.warnings.some((warning) => warning.startsWith("jobs:"))).toBe(
      true,
    );
  });

  it("blocks email reminders until platform notifications exist", () => {
    const base = normalizeAppSpec(personalSpecInput);
    const spec = {
      ...base,
      notifications: [
        {
          name: "Email expiration reminder",
          trigger: "A saved item is close to its expiration date.",
          recipients: ["Owner"],
          channel: "email" as const,
        },
      ],
    };
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan);

    expect(validation.canBuildNow).toBe(false);
    expect(validation.blockingIssues).toContain(
      "email: Email and notifications are planned for Stage 11B.",
    );
  });
});
