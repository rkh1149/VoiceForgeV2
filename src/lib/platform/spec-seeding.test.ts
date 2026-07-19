import { describe, expect, it } from "vitest";
import { normalizeAppSpec } from "../spec";
import {
  platformEntityFromSpec,
  platformSearchConfigFromSpec,
} from "./spec-seeding";

describe("platform entity seeding", () => {
  it("maps approved spec entities into platform entity definitions", () => {
    const spec = normalizeAppSpec({
      appName: "Shared Pantry",
      purpose: "Track pantry items together.",
      targetUsers: "A family",
      screens: [{ name: "Home", description: "Manage pantry items." }],
      features: ["Add items"],
      dataToStore: ["pantry items with status"],
      needsLogin: false,
      sharingModel: "shared",
      aiFeatures: [],
      testPlan: ["Add an item"],
      deploymentNotes: "",
    });

    const entity = platformEntityFromSpec(spec.dataEntities[0]);

    expect(entity.key).toBe("pantry_items_with");
    expect(entity.fields.map((field) => field.key)).toEqual(["title", "notes"]);
    expect(entity.fields[0].required).toBe(true);
  });

  it("deduplicates normalized field keys", () => {
    const spec = normalizeAppSpec({
      appName: "Label Maker",
      purpose: "Store labels.",
      targetUsers: "One person",
      screens: [{ name: "Home", description: "Manage labels." }],
      features: ["Add labels"],
      dataToStore: ["labels"],
      needsLogin: false,
      sharingModel: "private",
      aiFeatures: [],
      testPlan: ["Add a label"],
      deploymentNotes: "",
    });
    const base = spec.dataEntities[0];
    const entity = platformEntityFromSpec({
      ...base,
      fields: [
        { ...base.fields[0], name: "Due date", label: "Due date" },
        { ...base.fields[0], name: "Due Date", label: "Due Date" },
      ],
    });

    expect(entity.fields.map((field) => field.key)).toEqual([
      "due_date",
      "due_date_2",
    ]);
  });

  it("infers select options from plain-English validation text", () => {
    const spec = normalizeAppSpec({
      appName: "Activity Planner",
      purpose: "Plan activities together.",
      targetUsers: "A family",
      screens: [{ name: "Home", description: "Manage activities." }],
      features: ["Add activities"],
      dataToStore: ["activities with category"],
      needsLogin: false,
      sharingModel: "shared",
      aiFeatures: [],
      testPlan: ["Add an activity"],
      deploymentNotes: "",
    });
    const entity = platformEntityFromSpec({
      ...spec.dataEntities[0],
      fields: [
        {
          name: "category",
          label: "Category",
          type: "select",
          required: true,
          validation: "Choose one of: Outdoors, Food, or Games.",
        },
      ],
    });

    expect(entity.fields[0].options).toEqual(["Outdoors", "Food", "Games"]);
  });

  it("adds a relation field for belongs-to relationships", () => {
    const spec = normalizeAppSpec({
      appName: "Activity Planner",
      purpose: "Plan activities together.",
      targetUsers: "A family",
      screens: [{ name: "Home", description: "Manage comments." }],
      features: ["Comment on activities"],
      dataToStore: ["comments attached to activities"],
      needsLogin: false,
      sharingModel: "shared",
      aiFeatures: [],
      testPlan: ["Add a comment"],
      deploymentNotes: "",
    });
    const entity = platformEntityFromSpec({
      ...spec.dataEntities[0],
      name: "Comment",
      relationships: [
        {
          type: "belongs_to",
          targetEntity: "Activity",
          description: "Each comment belongs to an activity.",
        },
      ],
    });

    expect(entity.fields).toContainEqual(
      expect.objectContaining({
        key: "activity_id",
        type: "relation",
        required: true,
        relation: { entityKey: "activity" },
      }),
    );
  });

  it("adds a completion boolean when workflows require marking records done", () => {
    const spec = normalizeAppSpec({
      appName: "Family Grocery List",
      purpose: "Share groceries.",
      targetUsers: "A family",
      screens: [{ name: "Home", description: "Manage groceries." }],
      features: ["Add items", "Mark items bought"],
      dataToStore: ["grocery items with name and quantity"],
      needsLogin: false,
      sharingModel: "shared",
      aiFeatures: [],
      testPlan: ["Mark an item bought"],
      deploymentNotes: "",
    });

    const entity = platformEntityFromSpec(spec.dataEntities[0], spec);

    expect(entity.fields.some((field) => field.key === "bought")).toBe(true);
    expect(entity.fields.find((field) => field.key === "bought")?.type).toBe(
      "boolean",
    );
  });

  it("selects indexed fields and default sort for platform search/report configs", () => {
    const spec = normalizeAppSpec({
      appName: "Activity Planner",
      purpose: "Plan activities together.",
      targetUsers: "A family",
      screens: [{ name: "Home", description: "Manage activities." }],
      features: ["Add activities", "Search activities", "Export CSV"],
      dataToStore: ["activities with name, category, planned date, and cost"],
      needsLogin: false,
      sharingModel: "shared",
      aiFeatures: [],
      testPlan: ["Search and export activities"],
      deploymentNotes: "",
    });
    const entity = {
      ...spec.dataEntities[0],
      name: "Activity",
      fields: [
        {
          name: "name",
          label: "Name",
          type: "text" as const,
          required: true,
          validation: "",
        },
        {
          name: "category",
          label: "Category",
          type: "select" as const,
          required: false,
          validation: "Choose one of: Outdoors, Learning.",
        },
        {
          name: "planned date",
          label: "Planned date",
          type: "date" as const,
          required: false,
          validation: "",
        },
        {
          name: "cost",
          label: "Cost",
          type: "number" as const,
          required: false,
          validation: "",
        },
      ],
    };
    const config = platformSearchConfigFromSpec(
      entity,
      {
        ...spec,
        searchRequirements: [
          {
            target: "Activity",
            fields: ["name", "category"],
            filters: ["planned date", "cost"],
          },
        ],
        reports: [
          {
            name: "Activity cost report",
            description: "Cost by category.",
            dataNeeded: ["category", "cost"],
            exportFormats: ["screen", "csv"],
          },
        ],
      },
    );

    expect(config.entityKey).toBe("activity");
    expect(config.indexedFields).toEqual(
      expect.arrayContaining(["name", "category", "planned_date", "cost"]),
    );
    expect(config.defaultSort).toEqual([
      { fieldKey: "planned_date", direction: "asc" },
    ]);
  });
});
