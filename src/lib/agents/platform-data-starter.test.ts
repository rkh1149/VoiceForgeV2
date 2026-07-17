import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import { computeSpecComplexity, normalizeAppSpec } from "../spec";
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

describe("platform data starter generator", () => {
  it("generates a locked-platform-data CRUD starter for no-login shared apps", () => {
    const spec = normalizeAppSpec(sharedGroceryInput);
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
    const spec = normalizeAppSpec({
      ...sharedGroceryInput,
      needsLogin: true,
    });
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
});
