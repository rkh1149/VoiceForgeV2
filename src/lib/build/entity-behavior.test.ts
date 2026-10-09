import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import { computeSpecComplexity, normalizeAppSpec } from "../spec";
import { classifyEntityBehaviors } from "./entity-behavior";

describe("entity behavior classification", () => {
  it("keeps recipe children and history out of independent CRUD requirements", () => {
    const spec = normalizeAppSpec({
      appName: "Family Recipe Library",
      purpose: "Share recipes and suggestions with history.",
      targetUsers: "Family",
      screens: [{ name: "Recipes", description: "Browse recipes" }],
      features: ["Recipes", "Suggestions", "History"],
      dataToStore: ["recipes"],
      needsLogin: true,
      sharingModel: "shared",
      aiFeatures: ["Read recipe photos"],
      testPlan: [],
      deploymentNotes: "",
      capabilityTier: "advanced",
      dataEntities: [
        { name: "Recipe", description: "A family recipe", ownership: "shared", fields: [], relationships: [] },
        { name: "Recipe Ingredient", description: "Ingredient line item", ownership: "shared", fields: [], relationships: [{ type: "belongs_to", targetEntity: "Recipe", description: "Part of recipe" }] },
        { name: "Recipe History", description: "Audit history for changes", ownership: "shared", fields: [], relationships: [{ type: "belongs_to", targetEntity: "Recipe", description: "History for recipe" }] },
      ],
      workflows: [],
      permissionRules: [],
    });
    spec.dataEntities = [
      { name: "Recipe", description: "A family recipe", ownership: "shared", fields: [], relationships: [] },
      { name: "Recipe Ingredient", description: "Ingredient line item", ownership: "shared", fields: [], relationships: [{ type: "belongs_to", targetEntity: "Recipe", description: "Part of recipe" }] },
      { name: "Recipe History", description: "Audit history for changes", ownership: "shared", fields: [], relationships: [{ type: "belongs_to", targetEntity: "Recipe", description: "History for recipe" }] },
    ];
    const architecture = createFallbackArchitecturePlan(spec, computeSpecComplexity(spec));
    const byName = Object.fromEntries(
      classifyEntityBehaviors({ spec, architecture }).map((item) => [item.entityName, item]),
    );

    expect(byName.Recipe.behavior).toBe("primary");
    expect(byName["Recipe Ingredient"].behavior).toBe("child");
    expect(byName["Recipe History"].behavior).toBe("append_only");
    expect(byName["Recipe History"].requiredUserOperations).toEqual(["create", "read"]);
  });
});
