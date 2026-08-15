import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import {
  computeSpecComplexity,
  normalizeAppSpec,
  type AppSpec,
} from "../spec";
import { applyDeterministicAcceptanceCompiler } from "../build/acceptance-compiler";
import { runPostGenerationReviews } from "../build/post-generation-reviews";
import { loadTemplate } from "../build/template";
import {
  canUsePlatformDataStarter,
  generatePlatformDataStarterApp,
} from "./platform-data-starter";

const sharedGroceryInput = {
  appName: "Family Grocery List",
  purpose: "Everyone can share one grocery list.",
  targetUsers: "A family",
  screens: [{ name: "List", description: "Manage shared grocery items." }],
  features: ["Add items", "Mark items bought", "Delete mistakes"],
  dataToStore: ["grocery items with name, quantity, and bought status"],
  needsLogin: false,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Add an item", "Mark an item bought"],
  deploymentNotes: "",
};

const richActivityPlannerInput = {
  appName: "Family Activity Planner",
  purpose: "Plan weekend activities with charts, calendar, board, and CSV export.",
  targetUsers: "A family",
  screens: [
    {
      name: "Planner",
      description: "Search, filter, schedule, and organize activities.",
    },
  ],
  features: [
    "Dashboard charts",
    "Sortable activity table",
    "Search and filters",
    "Calendar date picker",
    "Drag/drop planning board",
    "CSV export",
    "Comments and activity history",
  ],
  dataToStore: [
    "activities with name, category, location, planned date, priority, status, notes, comments, and history",
  ],
  needsLogin: false,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Add, schedule, move, and export an activity"],
  deploymentNotes: "",
};

function simpleAddItemSpec(needsLogin: boolean): AppSpec {
  const spec = normalizeAppSpec({
    ...sharedGroceryInput,
    needsLogin,
    features: ["Add an item"],
    testPlan: ["Add an item and see it after refresh"],
  });
  spec.workflows = [
    {
      name: "Add an item",
      actor: "Editor",
      trigger: "The editor opens the list.",
      steps: ["Enter item name", "Save item"],
      successOutcome: "The saved item appears in the list.",
      failureStates: ["Item name is missing"],
    },
  ];
  spec.acceptanceCriteria = [];
  spec.testScenarios = [];
  return spec;
}

function sharedQuickNoteSpec(): AppSpec {
  const base = normalizeAppSpec({
    ...sharedGroceryInput,
    appName: "Shared Quick Notes",
    purpose: "Let family members save and revisit a shared quick note.",
    features: ["Add a note"],
    dataToStore: ["Notes with text"],
    screens: [{ name: "Notes", description: "Add and review notes." }],
    testPlan: ["Add a note and see it after refresh"],
  });
  return {
    ...base,
    dataEntities: [
      {
        name: "Note",
        description: "A shared note.",
        ownership: "shared",
        fields: [
          {
            name: "text",
            label: "Note text",
            type: "text",
            required: true,
            validation: "Required",
          },
        ],
        relationships: [],
      },
    ],
    workflows: [
      {
        name: "Add a note",
        actor: "Editor",
        trigger: "The editor opens Notes.",
        steps: ["Enter note text", "Save note"],
        successOutcome: "The saved note appears in the list.",
        failureStates: ["Note text is missing"],
      },
    ],
    acceptanceCriteria: [],
    testScenarios: [],
  };
}

describe("platform data starter generator", () => {
  it("generates a locked-platform-data CRUD starter for no-login shared apps", () => {
    const spec = simpleAddItemSpec(false);
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );

    expect(canUsePlatformDataStarter({ spec, architecture })).toBe(true);

    const result = generatePlatformDataStarterApp({ spec, architecture });

    expect(result.filesWritten).toContain("src/app/page.tsx");
    expect(result.filesWritten).toContain("src/components/PlatformDataApp.tsx");
    expect(result.filesWritten).toContain("src/lib/platform-app-config.ts");
    expect(result.files["src/components/PlatformDataApp.tsx"]).toContain(
      "createPlatformRecord",
    );
    expect(result.files["src/components/PlatformDataApp.tsx"]).toContain(
      "listPlatformRecords",
    );
    expect(result.files["src/lib/platform-app-config.ts"]).toContain(
      "prepareDataForSave",
    );
    expect(result.files["src/lib/platform-app-config.ts"]).toContain(
      'key": "bought"',
    );
    expect(result.files["src/lib/platform-app-config.ts"]).toContain(
      'ENTITY_KEY = "grocery_items_with"',
    );
  });

  it("generates role-aware session UI for signed-in shared apps", () => {
    const spec = simpleAddItemSpec(true);
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );

    expect(canUsePlatformDataStarter({ spec, architecture })).toBe(true);

    const result = generatePlatformDataStarterApp({ spec, architecture });
    expect(result.files["src/components/PlatformDataApp.tsx"]).toContain(
      "getPlatformSession",
    );
    expect(result.files["src/components/PlatformDataApp.tsx"]).toContain(
      "Sign in required",
    );
    expect(result.files["src/components/PlatformDataApp.tsx"]).toContain(
      "Your role is viewer",
    );
    expect(result.files["src/lib/platform-app-config.ts"]).toContain(
      "REQUIRE_SIGN_IN: boolean = true",
    );
    expect(result.files["src/lib/platform-app-config.ts"]).toContain(
      'SHARING_MODEL: "private" | "shared" | "public" = "shared"',
    );
    expect(result.files["src/components/PlatformDataApp.tsx"]).toContain(
      "accessModeLabel",
    );
    expect(result.files["src/components/PlatformDataApp.tsx"]).toContain(
      'data-vf-entity="grocery_items_with"',
    );
  });

  it("binds a simple workflow contract to fields and the save command", () => {
    const spec = sharedQuickNoteSpec();
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );

    expect(canUsePlatformDataStarter({ spec, architecture })).toBe(true);
    const result = generatePlatformDataStarterApp({ spec, architecture });
    const config = result.files["src/lib/platform-app-config.ts"];
    const component = result.files["src/components/PlatformDataApp.tsx"];

    expect(config).toContain('controlId: string');
    expect(config).toContain('"accessibleName": "Enter note text"');
    expect(config).toContain('"accessibleName": "Save note"');
    expect(config).toContain("The saved note appears in the list.");
    expect(component).toContain(
      'data-vf-workflow={field.key === "text" ? "add-a-note-1" : undefined}',
    );
    expect(component).toContain(
      'data-vf-control={"add-a-note-1-control-2"}',
    );
    expect(component).toContain("{session?.canWrite && (");
    expect(component).toContain("data-vf-record={record.id}");
  });

  it("passes every static workflow gate with deterministic acceptance output", async () => {
    const spec = sharedQuickNoteSpec();
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const template = await loadTemplate({
      slug: "shared-quick-notes",
      name: spec.appName,
      purpose: spec.purpose,
    });
    const generated = generatePlatformDataStarterApp({ spec, architecture });
    const files = { ...template, ...generated.files };
    const compilation = applyDeterministicAcceptanceCompiler({
      spec,
      architecture,
      files,
      generated,
    });
    const reviews = runPostGenerationReviews({
      spec,
      architecture,
      allFiles: files,
      changedFiles: generated.files,
      changedFilePaths: generated.filesWritten,
      deletedFilePaths: generated.deletedFiles,
      changeMode: false,
    });

    expect(compilation.blockingIssues).toEqual([]);
    expect(compilation.manifest.summary).toMatchObject({
      journeys: 1,
      steps: 2,
      saves: 1,
      adapterRequirements: 0,
    });
    expect(
      reviews.flatMap((review) => review.blockingIssues),
    ).toEqual([]);
  });

  it("does not use the simple starter for Stage 10 rich shared apps", () => {
    const spec = normalizeAppSpec(richActivityPlannerInput);
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );

    expect(architecture.dependencyProfile).toEqual(
      expect.arrayContaining([
        "dataDisplay",
        "dateScheduling",
        "advancedInterface",
        "fileExport",
      ]),
    );
    expect(canUsePlatformDataStarter({ spec, architecture })).toBe(false);
  });

  it("does not turn a multi-screen built-in story into a CRUD app", () => {
    const base = normalizeAppSpec({
      ...sharedGroceryInput,
      appName: "Story Sprout",
      purpose: "Play built-in illustrated stories without saving progress.",
      screens: [
        { name: "Story Garden", description: "Choose a story." },
        { name: "Story Time", description: "Play the story." },
        { name: "The End", description: "Choose another story." },
      ],
      features: ["Choose a built-in story", "Start another story"],
      dataToStore: [],
      needsLogin: false,
      sharingModel: "private",
      testPlan: ["No child data is saved"],
    });
    const spec: AppSpec = {
      ...base,
      dataEntities: [
        {
          name: "Story",
          description: "Built-in story content.",
          ownership: "system",
          fields: [
            {
              name: "title",
              label: "Title",
              type: "text",
              required: true,
              validation: "Required",
            },
          ],
          relationships: [],
        },
      ],
    };
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );

    expect(architecture.dataModel[0]?.storage).toBe("none");
    expect(canUsePlatformDataStarter({ spec, architecture })).toBe(false);
  });

  it("does not use the simple starter for notification workflows", () => {
    const base = normalizeAppSpec({
      ...sharedGroceryInput,
      features: [...sharedGroceryInput.features, "Send a reminder to the family"],
    });
    const spec = {
      ...base,
      notifications: [
        {
          name: "Weekly grocery reminder",
          trigger: "Every Sunday evening",
          recipients: ["Family members"],
          channel: "both" as const,
        },
      ],
    };
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );

    expect(canUsePlatformDataStarter({ spec, architecture })).toBe(false);
  });
});
