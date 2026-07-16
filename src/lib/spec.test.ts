import { describe, expect, it } from "vitest";
import {
  appSpecSchema,
  computeSpecComplexity,
  normalizeAppSpec,
  type AppSpec,
} from "./spec";

const legacySpec = {
  appName: "Family Chore Board",
  purpose: "Help the family track chores and who is doing them.",
  targetUsers: "A family of five",
  screens: [
    {
      name: "Dashboard",
      description: "See chores that need attention.",
    },
  ],
  features: ["Add chores", "Mark chores complete", "Search chores"],
  dataToStore: ["chores with title, assignee, due date, and status"],
  needsLogin: true,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Create and complete a chore", "Search for a saved chore"],
  deploymentNotes: "",
};

describe("normalizeAppSpec", () => {
  it("upgrades legacy Stage 1-7 specs into the rich Stage 8A shape", () => {
    const spec = normalizeAppSpec(legacySpec);

    expect(appSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.capabilityTier).toBe("shared");
    expect(spec.userRoles.map((role) => role.name)).toEqual([
      "Owner",
      "Editor",
      "Viewer",
    ]);
    expect(spec.dataEntities).toHaveLength(1);
    expect(spec.dataEntities[0].fields.map((field) => field.name)).toEqual([
      "title",
      "notes",
    ]);
    expect(spec.workflows).toHaveLength(3);
    expect(spec.searchRequirements).toHaveLength(1);
    expect(spec.acceptanceCriteria).toHaveLength(2);
    expect(spec.testScenarios).toHaveLength(2);
  });

  it("passes through already-rich specs unchanged", () => {
    const spec = normalizeAppSpec(legacySpec);

    expect(normalizeAppSpec(spec)).toEqual(spec);
  });
});

describe("computeSpecComplexity", () => {
  it("classifies small personal apps as simple", () => {
    const spec = normalizeAppSpec({
      ...legacySpec,
      appName: "Reading Timer",
      purpose: "Track one person's reading sessions.",
      targetUsers: "One person",
      features: ["Start a reading session"],
      dataToStore: [],
      needsLogin: false,
      sharingModel: "private" as const,
      testPlan: ["Start a session"],
    });

    const complexity = computeSpecComplexity(spec);

    expect(complexity.level).toBe("simple");
    expect(complexity.score).toBeLessThanOrEqual(15);
  });

  it("classifies role-based, multi-entity, connected apps as advanced", () => {
    const base = normalizeAppSpec(legacySpec);
    const entity = base.dataEntities[0];
    const advancedSpec: AppSpec = {
      ...base,
      capabilityTier: "advanced",
      screens: [
        ...base.screens,
        { name: "Calendar", description: "Schedule recurring chores." },
        { name: "Reports", description: "Review completion trends." },
      ],
      features: [
        ...base.features,
        "Upload photos",
        "Email reminders",
        "Export reports",
      ],
      dataEntities: [
        entity,
        { ...entity, name: "Assignment" },
        { ...entity, name: "Reminder" },
        { ...entity, name: "Comment" },
      ],
      workflows: [
        ...base.workflows,
        {
          name: "Send overdue reminder",
          actor: "Owner",
          trigger: "A chore is overdue.",
          steps: ["Find overdue chores", "Choose recipients", "Send reminder"],
          successOutcome: "The right people are reminded.",
          failureStates: ["No email address", "Reminder service unavailable"],
        },
      ],
      fileRequirements: [
        {
          name: "Completion photos",
          attachedTo: "Chore",
          acceptedTypes: ["image/*"],
          maxSizeMb: 5,
          required: false,
        },
      ],
      integrations: [
        {
          name: "Calendar import",
          purpose: "Bring school calendar dates into reminders.",
          direction: "import",
          requiredForLaunch: false,
        },
      ],
      notifications: [
        {
          name: "Overdue reminder",
          trigger: "A chore is overdue.",
          recipients: ["Owner", "Editor"],
          channel: "email",
        },
      ],
      reports: [
        {
          name: "Completion report",
          description: "Show chore completion by person.",
          dataNeeded: ["Chores", "Assignments"],
          exportFormats: ["screen", "csv"],
        },
      ],
      aiFeatures: ["Suggest fair chore assignments"],
      expectedDataVolume: "large",
      offlineSupport: "full",
    };

    const complexity = computeSpecComplexity(advancedSpec);

    expect(complexity.level).toBe("advanced");
    expect(complexity.score).toBeGreaterThan(35);
    expect(complexity.signals).toContain("advanced capability tier");
  });
});
