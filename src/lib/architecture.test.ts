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

  it("blocks required unavailable integrations even if the agent misses them", () => {
    const spec = normalizeAppSpec(personalSpecInput);
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const planWithIntegration: ArchitecturePlan = {
      ...plan,
      platformServices: [
        ...plan.platformServices,
        {
          service: "integrations",
          required: true,
          availability: "later",
          reason: "Calendar sync needs an external integration.",
        },
      ],
      capabilityValidation: {
        ...plan.capabilityValidation,
        canBuildNow: true,
        blockingIssues: [],
      },
    };

    const validation = validateArchitecturePlan(planWithIntegration);

    expect(validation.canBuildNow).toBe(false);
    expect(validation.blockingIssues).toContain(
      "integrations: Calendar sync needs an external integration.",
    );
  });

  it("allows approved Stage 12C catalogue integrations", () => {
    const base = normalizeAppSpec(personalSpecInput);
    const spec = {
      ...base,
      capabilityTier: "advanced" as const,
      integrations: [
        {
          name: "Demo Directory",
          purpose: "Search sample external contacts from the approved catalogue.",
          direction: "import" as const,
          requiredForLaunch: true,
        },
        {
          name: "Google Maps",
          purpose: "Search trip places and estimate route travel time.",
          direction: "import" as const,
          requiredForLaunch: true,
        },
      ],
    };
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan, spec);

    expect(validation.canBuildNow).toBe(true);
    expect(validation.blockingIssues).toEqual([]);
    expect(plan.platformServices).toContainEqual(
      expect.objectContaining({
        service: "integrations",
        availability: "available",
        required: true,
      }),
    );
    expect(plan.filePlan).toContainEqual(
      expect.objectContaining({
        path: "src/lib/platform-integrations.ts",
        kind: "locked",
      }),
    );
  });

  it("allows Stage 12B platform search and reports for shared records", () => {
    const base = normalizeAppSpec(sharedSpecInput);
    const spec = {
      ...base,
      capabilityTier: "advanced" as const,
      searchRequirements: [
        {
          target: "Chores",
          fields: ["title", "assignee"],
          filters: ["status", "due date"],
        },
      ],
      reports: [
        {
          name: "Chore status report",
          description: "Count chores by status.",
          dataNeeded: ["status"],
          exportFormats: ["screen", "csv"] as Array<"screen" | "csv">,
        },
      ],
    };
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan, spec);

    expect(validation.canBuildNow).toBe(true);
    expect(plan.platformServices).toContainEqual(
      expect.objectContaining({
        service: "search",
        availability: "available",
        required: true,
      }),
    );
    expect(plan.platformServices).toContainEqual(
      expect.objectContaining({
        service: "reports",
        availability: "available",
        required: true,
      }),
    );
  });

  it("keeps unsupported external providers blocked after Stage 12C", () => {
    const base = normalizeAppSpec(personalSpecInput);
    const spec = {
      ...base,
      capabilityTier: "advanced" as const,
      integrations: [
        {
          name: "Google Calendar",
          purpose: "Two-way calendar sync.",
          direction: "two_way" as const,
          requiredForLaunch: true,
        },
      ],
    };
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan, spec);

    expect(validation.canBuildNow).toBe(false);
    expect(validation.blockingIssues.join(" ")).toContain("Google Calendar");
  });

  it("allows personal apps with in-app reminders through platform jobs", () => {
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
    expect(plan.platformServices).toContainEqual(
      expect.objectContaining({
        service: "jobs",
        availability: "available",
        required: true,
      }),
    );
    expect(validation.warnings.some((warning) => warning.startsWith("jobs:"))).toBe(
      false,
    );
  });

  it("allows email reminders through locked notification delivery", () => {
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

    expect(validation.canBuildNow).toBe(true);
    expect(validation.blockingIssues).toEqual([]);
    expect(plan.platformServices).toContainEqual(
      expect.objectContaining({
        service: "email",
        availability: "available",
        required: true,
      }),
    );
  });

  it("does not block when the planner labels VoiceForge platform services as integrations", () => {
    const base = normalizeAppSpec(sharedSpecInput);
    const spec = {
      ...base,
      integrations: [
        {
          name: "VoiceForge sign-in and member roles",
          purpose:
            "Require invited member access and enforce owner, editor, and viewer permissions.",
          direction: "two_way" as const,
          requiredForLaunch: true,
        },
        {
          name: "VoiceForge platform notifications",
          purpose:
            "Send immediate email and in-app reminder notifications according to member preferences.",
          direction: "two_way" as const,
          requiredForLaunch: true,
        },
        {
          name: "VoiceForge platform scheduled jobs",
          purpose:
            "Run owner-created daily and weekly reminder notification jobs and provide job status.",
          direction: "two_way" as const,
          requiredForLaunch: true,
        },
      ],
      notifications: [
        {
          name: "Immediate reminder notification",
          trigger: "A reminder is created.",
          recipients: ["Family members"],
          channel: "both" as const,
        },
      ],
    };
    const complexity = computeSpecComplexity(spec);
    const plan = createFallbackArchitecturePlan(spec, complexity);
    const validation = validateArchitecturePlan(plan);

    expect(validation.canBuildNow).toBe(true);
    expect(validation.blockingIssues).toEqual([]);
    expect(plan.platformServices).not.toContainEqual(
      expect.objectContaining({ service: "integrations" }),
    );
    expect(plan.platformServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: "email", availability: "available" }),
        expect.objectContaining({ service: "jobs", availability: "available" }),
      ]),
    );
  });
});
