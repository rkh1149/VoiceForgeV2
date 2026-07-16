import { describe, expect, it } from "vitest";
import { normalizeAppSpec } from "../spec";
import { platformEntityFromSpec } from "./spec-seeding";

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
});
