import { describe, expect, it } from "vitest";
import {
  createFallbackArchitecturePlan,
  type ArchitecturePlan,
} from "../architecture";
import { computeSpecComplexity, normalizeAppSpec } from "../spec";
import type { WorkflowContract } from "../workflow-contract";
import { analyzePersistenceHandoffs } from "./persistence-handoff-review";
import type { FileMap } from "./template";

const spec = normalizeAppSpec({
  appName: "Family Meal Planner",
  purpose: "Save family recipes and plan them for the week.",
  targetUsers: "A family",
  screens: [
    { name: "Recipes", description: "Create and view recipes." },
    { name: "Weekly Plan", description: "Choose saved recipes." },
  ],
  features: ["Save recipes", "Plan saved recipes"],
  dataToStore: ["recipes"],
  needsLogin: true,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Save a recipe", "Use it in the weekly plan"],
  deploymentNotes: "",
  capabilityTier: "advanced" as const,
  dataEntities: [
    {
      name: "Recipe",
      description: "A saved family recipe.",
      ownership: "shared" as const,
      fields: [
        {
          name: "recipe_title",
          label: "Recipe title",
          type: "text" as const,
          required: true,
          validation: "Recipe title is required.",
        },
        {
          name: "ingredients",
          label: "Ingredients",
          type: "long_text" as const,
          required: true,
          validation: "Ingredients are required.",
        },
      ],
      relationships: [],
    },
  ],
  workflows: [
    {
      name: "Create and save a recipe",
      actor: "Editor",
      trigger: "Editor opens Recipes.",
      steps: ["Enter recipe details", "Save recipe"],
      successOutcome: "Saved recipe appears in Recipes.",
      failureStates: ["Required values missing"],
    },
    {
      name: "Plan saved recipe",
      actor: "Editor",
      trigger: "Editor opens Weekly Plan.",
      steps: ["Choose saved recipe"],
      successOutcome: "Saved recipe is selected.",
      failureStates: ["No recipes saved"],
    },
  ],
});

spec.capabilityTier = "advanced";
spec.dataEntities = [
  {
    name: "Recipe",
    description: "A saved family recipe.",
    ownership: "shared",
    fields: [
      {
        name: "recipe_title",
        label: "Recipe title",
        type: "text",
        required: true,
        validation: "Recipe title is required.",
      },
      {
        name: "ingredients",
        label: "Ingredients",
        type: "long_text",
        required: true,
        validation: "Ingredients are required.",
      },
    ],
    relationships: [],
  },
];
spec.workflows = [
  {
    name: "Create and save a recipe",
    actor: "Editor",
    trigger: "Editor opens Recipes.",
    steps: ["Enter recipe details", "Save recipe"],
    successOutcome: "Saved recipe appears in Recipes.",
    failureStates: ["Required values missing"],
  },
  {
    name: "Plan saved recipe",
    actor: "Editor",
    trigger: "Editor opens Weekly Plan.",
    steps: ["Choose saved recipe"],
    successOutcome: "Saved recipe is selected.",
    failureStates: ["No recipes saved"],
  },
];

const producerContract: WorkflowContract = {
  id: "create-save-recipe",
  name: "Create and save a recipe",
  actor: { persona: "Cook", roles: ["owner", "editor"] },
  trigger: "user_action",
  start: { route: "/recipes", screen: "Recipes", preconditions: ["Signed in"] },
  controls: [
    {
      id: "save-recipe",
      kind: "button",
      accessibleName: "Save recipe",
      route: "/recipes",
      roles: ["owner", "editor"],
      action: "Save the recipe",
    },
  ],
  steps: [
    {
      id: "save-recipe-record",
      description: "Save recipe",
      kind: "save",
      route: "/recipes",
      controlId: "save-recipe",
      reads: ["recipe"],
      writes: ["recipe"],
      visibleResult: "Recipe appears in Recipes.",
    },
  ],
  requiredData: [
    {
      entityName: "Recipe",
      entityKey: "recipe",
      operations: ["read", "create"],
      requiredFieldKeys: ["recipe_title", "ingredients"],
    },
  ],
  expectedSaves: [
    {
      stepId: "save-recipe-record",
      operation: "create",
      entityName: "Recipe",
      entityKey: "recipe",
      fieldKeys: ["recipe_title", "ingredients"],
      storage: "platformData",
      producedReference: "recipe.id",
    },
  ],
  success: {
    message: "Recipe saved.",
    visibleResult: "Recipe appears in Recipes.",
    route: "/recipes",
  },
  failureStates: ["Required values missing"],
  handoffs: [
    {
      id: "recipe-to-weekly-plan",
      fromStepId: "save-recipe-record",
      produces: "recipe.id",
      storage: "platformData",
      consumerWorkflowId: "plan-saved-recipe",
      consumerRoute: "/weekly-plan",
      consumerControlId: "choose-saved-recipe",
      loadRule: "Load saved Recipe records into the Weekly Plan selector.",
    },
  ],
  dependencies: { workflowIds: [], platformServices: ["data"] },
  source: {
    workflowName: "Create and save a recipe",
    acceptanceCriteria: [],
    testScenarios: [],
  },
};

const consumerContract: WorkflowContract = {
  id: "plan-saved-recipe",
  name: "Plan saved recipe",
  actor: { persona: "Cook", roles: ["owner", "editor"] },
  trigger: "user_action",
  start: {
    route: "/weekly-plan",
    screen: "Weekly Plan",
    preconditions: ["A saved recipe exists"],
  },
  controls: [
    {
      id: "choose-saved-recipe",
      kind: "combobox",
      accessibleName: "Choose saved recipe",
      route: "/weekly-plan",
      roles: ["owner", "editor"],
      action: "Choose a saved recipe",
    },
  ],
  steps: [
    {
      id: "choose-recipe",
      description: "Choose saved recipe",
      kind: "input",
      route: "/weekly-plan",
      controlId: "choose-saved-recipe",
      reads: ["recipe"],
      writes: [],
      visibleResult: "Recipe is selected.",
    },
  ],
  requiredData: [
    {
      entityName: "Recipe",
      entityKey: "recipe",
      operations: ["read"],
      requiredFieldKeys: ["recipe_title"],
    },
  ],
  expectedSaves: [],
  success: {
    message: "Recipe selected.",
    visibleResult: "Recipe is selected.",
    route: "/weekly-plan",
  },
  failureStates: ["No recipes saved"],
  handoffs: [],
  dependencies: {
    workflowIds: ["create-save-recipe"],
    platformServices: ["data"],
  },
  source: {
    workflowName: "Plan saved recipe",
    acceptanceCriteria: [],
    testScenarios: [],
  },
};

function architecture(): ArchitecturePlan {
  const base = createFallbackArchitecturePlan(spec, computeSpecComplexity(spec));
  return {
    ...base,
    pageMap: [
      {
        route: "/recipes",
        name: "Recipes",
        purpose: "Create and view recipes.",
        primaryComponents: ["RecipesPage"],
        workflows: [producerContract.name],
      },
      {
        route: "/weekly-plan",
        name: "Weekly Plan",
        purpose: "Choose saved recipes.",
        primaryComponents: ["WeeklyPlanPage"],
        workflows: [consumerContract.name],
      },
    ],
    workflowContracts: [producerContract, consumerContract],
  };
}

const recipeData = `import { createPlatformRecord, listPlatformRecords } from "@/lib/platform-data";
export type RecipeData = { recipe_title: string; ingredients: string };
export function listRecipes() { return listPlatformRecords<RecipeData>("recipe"); }
export function createRecipe(data: RecipeData) { return createPlatformRecord("recipe", { recipe_title: data.recipe_title, ingredients: data.ingredients }); }`;

const recipesPage = `"use client";
import { useEffect, useState } from "react";
import { createRecipe, listRecipes } from "@/lib/recipe-data";
export default function RecipesPage() {
  const [recipes, setRecipes] = useState([]);
  useEffect(() => { void listRecipes().then(setRecipes); }, []);
  async function handleSaveRecipe() { const savedRecipe = await createRecipe({ recipe_title: "Soup", ingredients: "Stock" }); setRecipes((current) => [...current, savedRecipe]); }
  return <main><button onClick={() => void handleSaveRecipe()}>Save recipe</button></main>;
}`;

const weeklyPlanPage = `"use client";
import { useEffect, useState } from "react";
import { listRecipes } from "@/lib/recipe-data";
export default function WeeklyPlanPage() {
  const [recipes, setRecipes] = useState([]);
  useEffect(() => { void listRecipes().then(setRecipes); }, []);
  return <label>Choose saved recipe<select aria-label="Choose saved recipe">{recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.data.recipe_title}</option>)}</select></label>;
}`;

const persistenceTest = `describe("Create and save a recipe then Plan saved recipe", () => {
  it("persists exact recipe fields and reloads them after refresh", async () => {
    expect(createPlatformRecord).toHaveBeenCalledWith("recipe", { recipe_title: "Soup", ingredients: "Stock" });
    unmount();
    remountRecipes();
    expect(listPlatformRecords).toHaveBeenCalledWith("recipe");
    openWeeklyPlan();
    selectRecipe("saved-recipe-id");
    expect(screen.getByRole("option", { name: "Soup" })).toHaveValue("saved-recipe-id");
  });
  it("keeps entered recipe values after a failed save", async () => { expect(recipe_title).toEqual("Soup"); });
});`;

function files(overrides: FileMap = {}): FileMap {
  return {
    "src/app/recipes/page.tsx": recipesPage,
    "src/app/weekly-plan/page.tsx": weeklyPlanPage,
    "src/lib/recipe-data.ts": recipeData,
    "src/components/recipe-workflow.test.tsx": persistenceTest,
    ...overrides,
  };
}

function review(appFiles: FileMap) {
  return analyzePersistenceHandoffs({
    spec,
    architecture: architecture(),
    files: appFiles,
  });
}

describe("persistence and handoff review", () => {
  it("verifies exact platform saves, refresh durability, and producer-to-consumer reuse", () => {
    const result = review(files());

    expect(result.blockingIssues).toEqual([]);
    expect(result.summary).toMatchObject({
      savesVerified: 1,
      exactSchemasVerified: 1,
      reloadPathsVerified: 1,
      handoffsVerified: 1,
      persistenceTestsVerified: 3,
    });
  });

  it("recognizes typed saved records and their stable ids", () => {
    const result = review(
      files({
        "src/app/recipes/page.tsx": recipesPage.replace(
          "const savedRecipe = await createRecipe",
          "const savedRecipe: { id: string; data: { recipe_title: string; ingredients: string } } = await createRecipe",
        ),
      }),
    );

    expect(result.saves[0]).toMatchObject({
      stableReferenceFound: true,
      status: "verified",
    });
    expect(result.blockingIssues).toEqual([]);
  });

  it("accepts a reloaded entity record used by its stable platform id", () => {
    const result = review(
      files({
        "src/app/recipes/page.tsx": `"use client";
import { useEffect, useState } from "react";
import { createRecipe, listRecipes } from "@/lib/recipe-data";
export default function RecipesPage() {
  const [recipes, setRecipes] = useState([]);
  useEffect(() => { void listRecipes().then(setRecipes); }, []);
  async function handleSaveRecipe() { await createRecipe({ recipe_title: "Soup", ingredients: "Stock" }); setRecipes(await listRecipes()); }
  return <main><button onClick={() => void handleSaveRecipe()}>Save recipe</button>{recipes.map((recipe) => <p key={recipe.id}>{recipe.data.recipe_title}</p>)}</main>;
}`,
      }),
    );

    expect(result.saves[0]).toMatchObject({
      stableReferenceFound: true,
      status: "verified",
    });
    expect(result.blockingIssues).toEqual([]);
  });

  it("blocks a calculated or displayed result that only lives in React state", () => {
    const result = review(
      files({
        "src/app/recipes/page.tsx": `"use client"; import { useState } from "react"; export default function RecipesPage() { const [recipes, setRecipes] = useState([]); return <button onClick={() => setRecipes([{ recipe_title: "Soup", ingredients: "Stock" }])}>Save recipe</button>; }`,
        "src/lib/recipe-data.ts": "export const recipeStateOnly = true;",
      }),
    );

    expect(result.blockingIssues).toContainEqual(
      expect.stringContaining("no durable platformData write"),
    );
  });

  it("blocks a friendly camelCase field instead of the exact schema key", () => {
    const result = review(
      files({
        "src/lib/recipe-data.ts": `import { createPlatformRecord, listPlatformRecords } from "@/lib/platform-data";
export function listRecipes() { return listPlatformRecords("recipe"); }
export function createRecipe(data: { recipeTitle: string; ingredients: string }) { return createPlatformRecord("recipe", { recipeTitle: data.recipeTitle, ingredients: data.ingredients }); }`,
        "src/app/recipes/page.tsx": recipesPage.replaceAll("recipe_title", "recipeTitle"),
        "src/components/recipe-workflow.test.tsx": persistenceTest.replaceAll("recipe_title", "recipeTitle"),
      }),
    );

    expect(result.blockingIssues).toContainEqual(
      expect.stringContaining("exact required recipe field keys: recipe_title"),
    );
  });

  it("blocks a save payload that omits a required relationship id", () => {
    const relationSpec = structuredClone(spec);
    relationSpec.dataEntities[0].fields.push({
      name: "family_id",
      label: "Family",
      type: "relation",
      required: true,
      validation: "Choose the family that owns this recipe.",
    });
    const relationArchitecture = structuredClone(architecture());
    relationArchitecture.workflowContracts[0].expectedSaves[0].fieldKeys.push(
      "family_id",
    );
    const result = analyzePersistenceHandoffs({
      spec: relationSpec,
      architecture: relationArchitecture,
      files: files(),
    });

    expect(result.blockingIssues).toContainEqual(
      expect.stringContaining("exact required recipe field keys: family_id"),
    );
  });

  it("blocks records not read on fresh screen entry", () => {
    const result = review(
      files({
        "src/app/recipes/page.tsx": recipesPage.replace(
          "useEffect(() => { void listRecipes().then(setRecipes); }, []);",
          "async function loadAfterClick() { setRecipes(await listRecipes()); }",
        ),
      }),
    );

    expect(result.blockingIssues).toContainEqual(
      expect.stringContaining("does not reload it on a fresh screen entry or mount"),
    );
  });

  it("blocks a route-to-GPS style handoff when the consumer never loads the saved record", () => {
    const result = review(
      files({
        "src/app/weekly-plan/page.tsx": `export default function WeeklyPlanPage() { return <p>Choose saved recipe</p>; }`,
      }),
    );

    expect(result.blockingIssues).toContainEqual(
      expect.stringContaining("does not load saved recipe records"),
    );
  });

  it("blocks a downstream selector that loads saved records only after another click", () => {
    const result = review(
      files({
        "src/app/weekly-plan/page.tsx": `"use client";
import { useState } from "react";
import { listRecipes } from "@/lib/recipe-data";
export default function WeeklyPlanPage() {
  const [recipes, setRecipes] = useState([]);
  async function loadRecipesAfterClick() { setRecipes(await listRecipes()); }
  return <><button onClick={() => void loadRecipesAfterClick()}>Load recipes</button><label>Choose saved recipe<select aria-label="Choose saved recipe">{recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.data.recipe_title}</option>)}</select></label></>;
}`,
      }),
    );

    expect(result.blockingIssues).toContainEqual(
      expect.stringContaining("does not load it on fresh entry"),
    );
  });

  it("blocks raw image bytes in a platform-data record path", () => {
    const result = review(
      files({
        "src/lib/recipe-data.ts": `${recipeData}\nexport async function savePhoto(imageBase64: string) { return createPlatformRecord("recipe", { recipe_title: "Photo", ingredients: imageBase64, dataBase64: imageBase64 }); }`,
      }),
    );

    expect(result.blockingIssues).toContainEqual(
      expect.stringContaining("raw file/image bytes"),
    );
  });

  it("verifies browser-only localStorage persistence after a fresh mount", () => {
    const localArchitecture = architecture();
    localArchitecture.workflowContracts = [
      {
        ...producerContract,
        expectedSaves: producerContract.expectedSaves.map((save) => ({
          ...save,
          storage: "localStorage" as const,
        })),
        handoffs: [],
      },
    ];
    const result = analyzePersistenceHandoffs({
      spec,
      architecture: localArchitecture,
      files: {
        "src/app/recipes/page.tsx": `"use client";
import { useEffect, useState } from "react";
export default function RecipesPage() {
  const [recipes, setRecipes] = useState([]);
  useEffect(() => { setRecipes(JSON.parse(localStorage.getItem("recipe") ?? "[]")); }, []);
  function saveRecipe() { const savedRecipe = { id: crypto.randomUUID(), recipe_title: "Soup", ingredients: "Stock" }; localStorage.setItem("recipe", JSON.stringify([...recipes, savedRecipe])); setRecipes([...recipes, savedRecipe]); }
  return <button onClick={saveRecipe}>Save recipe</button>;
}`,
        "src/components/recipe-local.test.tsx": `describe("Create and save a recipe", () => { it("uses localStorage and survives refresh", () => { expect(localStorage.setItem).toHaveBeenCalledWith("recipe", expect.stringContaining("recipe_title")); expect(ingredients).toEqual("Stock"); unmount(); remountRecipes(); expect(localStorage.getItem).toHaveBeenCalledWith("recipe"); }); it("keeps values after failed save", () => expect(true).toEqual(true)); });`,
      },
    });

    expect(result.blockingIssues).toEqual([]);
    expect(result.summary.reloadPathsVerified).toBe(1);
  });

  it("verifies platform file uploads and fresh file-list loading", () => {
    const fileArchitecture = architecture();
    fileArchitecture.workflowContracts = [
      {
        ...producerContract,
        expectedSaves: producerContract.expectedSaves.map((save) => ({
          ...save,
          fieldKeys: [],
          storage: "platformFiles" as const,
          producedReference: "recipe.id",
        })),
        handoffs: [],
      },
    ];
    const result = analyzePersistenceHandoffs({
      spec,
      architecture: fileArchitecture,
      files: {
        "src/app/recipes/page.tsx": `"use client";
import { useEffect, useState } from "react";
import { listPlatformFiles, uploadPlatformFile } from "@/lib/platform-files";
const entityKey = "recipe";
export default function RecipesPage() {
  const [files, setFiles] = useState([]);
  useEffect(() => { void listPlatformFiles().then(setFiles); }, []);
  async function saveRecipe(file) { const savedFile = await uploadPlatformFile({ file }); setFiles((current) => [...current, savedFile]); }
  return <button onClick={() => void saveRecipe(selectedFile)}>Save recipe</button>;
}`,
        "src/components/recipe-file.test.tsx": `describe("Create and save a recipe file", () => { it("uploads recipe and reloads after refresh", async () => { expect(uploadPlatformFile).toHaveBeenCalled(); expect("recipe").toEqual("recipe"); unmount(); remountFiles(); expect(listPlatformFiles).toHaveBeenCalled(); }); it("keeps selected file after failed save", () => expect(true).toEqual(true)); });`,
      },
    });

    expect(result.blockingIssues).toEqual([]);
    expect(result.summary.savesVerified).toBe(1);
  });

  it("allows an uploaded file id while rejecting only raw bytes in platform data", () => {
    const result = review(
      files({
        "src/lib/recipe-data.ts": `import { createPlatformRecord, listPlatformRecords } from "@/lib/platform-data";
import { uploadPlatformFileData } from "@/lib/platform-files";
export function listRecipes() { return listPlatformRecords("recipe"); }
export async function createRecipe(data: { recipe_title: string; ingredients: string; imageBase64: string }) {
  const file = await uploadPlatformFileData({ fileName: "recipe.png", contentType: "image/png", dataBase64: data.imageBase64 });
  return createPlatformRecord("recipe", { recipe_title: data.recipe_title, ingredients: data.ingredients, image_file_id: file.id });
}`,
      }),
    );

    expect(result.blockingIssues.join(" ")).not.toContain("raw file/image bytes");
  });
});
