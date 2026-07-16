import { z } from "zod";

/**
 * The structured app specification produced by the planning conversation.
 * Stored as `requirements.spec` (jsonb) and versioned per app.
 *
 * Note: every schema field is required because the OpenAI structured-outputs
 * format requires strict JSON schemas. Use empty arrays / empty strings for
 * "none". `normalizeAppSpec` keeps older Stage 1-7 specs readable.
 */

const screenSchema = z.object({
  name: z.string().describe("Short screen/page name"),
  description: z.string().describe("What this screen lets the user do"),
});

const userRoleSchema = z.object({
  name: z.string().describe("Plain role name, e.g. Owner, Editor, Viewer"),
  description: z.string().describe("Who has this role"),
  permissions: z
    .array(z.string())
    .describe("Plain-language abilities for this role"),
});

const entityFieldSchema = z.object({
  name: z.string().describe("Field name, e.g. dueDate"),
  label: z.string().describe("Friendly label, e.g. Due date"),
  type: z
    .enum([
      "text",
      "long_text",
      "number",
      "boolean",
      "date",
      "datetime",
      "select",
      "multi_select",
      "image",
      "file",
      "relation",
      "json",
    ])
    .describe("Best simple data type"),
  required: z.boolean().describe("Whether this field must be filled in"),
  validation: z.string().describe("Validation rule in plain English, or empty"),
});

const entityRelationshipSchema = z.object({
  type: z
    .enum(["one_to_one", "one_to_many", "many_to_many", "belongs_to"])
    .describe("Relationship shape"),
  targetEntity: z.string().describe("Related entity name"),
  description: z.string().describe("Plain-English relationship description"),
});

const dataEntitySchema = z.object({
  name: z.string().describe("Entity name, e.g. Recipe"),
  description: z.string().describe("What this entity represents"),
  ownership: z
    .enum(["per_user", "shared", "public_read", "system"])
    .describe("Who can see records of this entity"),
  fields: z.array(entityFieldSchema).describe("Fields stored for this entity"),
  relationships: z
    .array(entityRelationshipSchema)
    .describe("Relationships to other entities"),
});

const workflowSchema = z.object({
  name: z.string().describe("Workflow name"),
  actor: z.string().describe("Role or person doing the workflow"),
  trigger: z.string().describe("What starts the workflow"),
  steps: z.array(z.string()).describe("Plain-language workflow steps"),
  successOutcome: z.string().describe("What success looks like"),
  failureStates: z
    .array(z.string())
    .describe("Expected empty, error, or blocked states"),
});

const permissionRuleSchema = z.object({
  role: z.string().describe("Role this rule applies to"),
  entity: z.string().describe("Entity or feature this rule protects"),
  actions: z
    .array(z.enum(["create", "read", "update", "delete", "invite", "admin"]))
    .describe("Allowed actions"),
  condition: z.string().describe("Plain-language condition, or empty"),
});

const searchRequirementSchema = z.object({
  target: z.string().describe("Entity, screen, or feature to search/filter"),
  fields: z.array(z.string()).describe("Fields searched"),
  filters: z.array(z.string()).describe("Filters/sorts the user expects"),
});

const fileRequirementSchema = z.object({
  name: z.string().describe("File feature name"),
  attachedTo: z.string().describe("Entity/screen the file belongs to"),
  acceptedTypes: z.array(z.string()).describe("Allowed file types"),
  maxSizeMb: z.number().describe("Expected max size in MB, or 0 if unknown"),
  required: z.boolean().describe("Whether every record needs a file"),
});

const integrationRequirementSchema = z.object({
  name: z.string().describe("External service or data source"),
  purpose: z.string().describe("Why the app needs it"),
  direction: z
    .enum(["import", "export", "two_way", "none"])
    .describe("How data moves"),
  requiredForLaunch: z.boolean().describe("Whether launch depends on it"),
});

const notificationRequirementSchema = z.object({
  name: z.string().describe("Notification/reminder name"),
  trigger: z.string().describe("What causes it"),
  recipients: z.array(z.string()).describe("Who receives it"),
  channel: z.enum(["in_app", "email", "both", "none"]).describe("Channel"),
});

const reportRequirementSchema = z.object({
  name: z.string().describe("Report/export name"),
  description: z.string().describe("What it summarizes"),
  dataNeeded: z.array(z.string()).describe("Data included in the report"),
  exportFormats: z
    .array(z.enum(["screen", "csv", "pdf", "print"]))
    .describe("Expected output formats"),
});

const acceptanceCriterionSchema = z.object({
  name: z.string().describe("Short acceptance criterion name"),
  scenario: z.string().describe("Plain-language scenario"),
  given: z.string().describe("Starting condition"),
  when: z.string().describe("User action or event"),
  then: z.string().describe("Expected result"),
});

const testScenarioSchema = z.object({
  name: z.string().describe("Test name"),
  type: z
    .enum(["unit", "workflow", "browser", "accessibility", "security"])
    .describe("Kind of test"),
  steps: z.array(z.string()).describe("Test steps"),
  expectedResult: z.string().describe("Expected outcome"),
});

export const appSpecSchema = z.object({
  appName: z
    .string()
    .describe("Short friendly app name, e.g. 'Family Recipe Keeper'"),
  purpose: z.string().describe("One or two sentences: what the app is for"),
  targetUsers: z
    .string()
    .describe("Who will use it, e.g. 'Richard's family, about 6 people'"),
  screens: z.array(screenSchema).describe("Main screens/pages of the app"),
  features: z
    .array(z.string())
    .describe("Main things users can do, in plain language"),
  dataToStore: z
    .array(z.string())
    .describe("What information the app saves, e.g. 'recipes with photos'"),
  needsLogin: z
    .boolean()
    .describe("Whether users must sign in to use the app"),
  sharingModel: z
    .enum(["private", "shared", "public"])
    .describe(
      "private: each user sees only their own data; shared: all invited users share data; public: anyone can view",
    ),
  aiFeatures: z
    .array(z.string())
    .describe("AI-powered features, if any (empty array if none)"),
  testPlan: z
    .array(z.string())
    .describe("Plain-language list of things to test before release"),
  deploymentNotes: z
    .string()
    .describe("Anything special about hosting/devices, or empty string"),

  capabilityTier: z
    .enum(["personal", "shared", "advanced"])
    .describe("Overall platform capability tier this app appears to need"),
  userRoles: z.array(userRoleSchema).describe("User roles and abilities"),
  dataEntities: z
    .array(dataEntitySchema)
    .describe("Structured data model: entities, fields, and relationships"),
  workflows: z
    .array(workflowSchema)
    .describe("Main user workflows, including success and failure states"),
  permissionRules: z
    .array(permissionRuleSchema)
    .describe("Role/entity permission rules"),
  validationRules: z
    .array(z.string())
    .describe("Business and form validation rules"),
  searchRequirements: z
    .array(searchRequirementSchema)
    .describe("Search, filter, and sorting requirements"),
  fileRequirements: z
    .array(fileRequirementSchema)
    .describe("Uploads, attachments, photos, or generated file requirements"),
  integrations: z
    .array(integrationRequirementSchema)
    .describe("External services or data sources"),
  notifications: z
    .array(notificationRequirementSchema)
    .describe("Reminders and notifications"),
  reports: z
    .array(reportRequirementSchema)
    .describe("Reports, summaries, print views, and exports"),
  privacyRequirements: z
    .array(z.string())
    .describe("Privacy and data visibility requirements"),
  expectedDataVolume: z
    .enum(["small", "medium", "large"])
    .describe("Expected data volume for a family-scale app"),
  offlineSupport: z
    .enum(["none", "basic", "full"])
    .describe("Whether the app should work without network access"),
  acceptanceCriteria: z
    .array(acceptanceCriterionSchema)
    .describe("Structured acceptance criteria for workflow tests"),
  testScenarios: z
    .array(testScenarioSchema)
    .describe("Concrete test scenarios to generate later"),
  riskFlags: z
    .array(z.string())
    .describe("Unsupported, expensive, risky, or unclear requests"),
});

const legacyAppSpecSchema = z.object({
  appName: z.string(),
  purpose: z.string(),
  targetUsers: z.string(),
  screens: z.array(screenSchema),
  features: z.array(z.string()),
  dataToStore: z.array(z.string()),
  needsLogin: z.boolean(),
  sharingModel: z.enum(["private", "shared", "public"]),
  aiFeatures: z.array(z.string()),
  testPlan: z.array(z.string()),
  deploymentNotes: z.string(),
});

export type AppSpec = z.infer<typeof appSpecSchema>;
export type AppCapabilityTier = AppSpec["capabilityTier"];

export type ComplexityLevel = "simple" | "intermediate" | "advanced";

export type ComplexityResult = {
  score: number;
  level: ComplexityLevel;
  signals: string[];
};

/** Change proposals carry the full UPDATED spec plus a summary of the change. */
export const changeProposalSchema = appSpecSchema.extend({
  changeSummary: z
    .string()
    .describe(
      "Plain-language summary of what is changing versus the current app, e.g. 'Add a print button to each recipe'",
    ),
});

export type ChangeProposal = z.infer<typeof changeProposalSchema>;

export function normalizeAppSpec(input: unknown): AppSpec {
  const rich = appSpecSchema.safeParse(input);
  if (rich.success) return rich.data;

  const legacy = legacyAppSpecSchema.safeParse(input);
  if (!legacy.success) {
    throw new Error("Stored app specification is invalid.");
  }

  const spec = legacy.data;
  const hasSharedData = spec.needsLogin || spec.sharingModel !== "private";
  const inferredEntities = inferEntities(spec);
  const inferredFiles = inferFileRequirements(spec);
  const workflows = inferWorkflows(spec);
  const roles = inferRoles(spec);
  const permissionRules = inferPermissionRules(spec, roles, inferredEntities);
  const acceptanceCriteria = inferAcceptanceCriteria(spec);
  const capabilityTier = inferCapabilityTier({
    sharingModel: spec.sharingModel,
    needsLogin: spec.needsLogin,
    entityCount: inferredEntities.length,
    workflowCount: workflows.length,
    fileCount: inferredFiles.length,
    integrationCount: 0,
    notificationCount: 0,
    reportCount: countMatching(spec.features, ["chart", "report", "export"]),
  });

  return {
    ...spec,
    capabilityTier,
    userRoles: roles,
    dataEntities: inferredEntities,
    workflows,
    permissionRules,
    validationRules:
      spec.dataToStore.length > 0
        ? ["Required saved information should be checked before records are saved."]
        : [],
    searchRequirements: inferSearchRequirements(spec),
    fileRequirements: inferredFiles,
    integrations: [],
    notifications: [],
    reports: inferReports(spec),
    privacyRequirements: [
      hasSharedData
        ? "Only the intended invited people should see shared information."
        : "Information should stay on the user's device unless the plan is changed.",
    ],
    expectedDataVolume: "small",
    offlineSupport: hasSharedData ? "none" : "basic",
    acceptanceCriteria,
    testScenarios: acceptanceCriteria.map((criterion) => ({
      name: criterion.name,
      type: "workflow" as const,
      steps: [criterion.given, criterion.when],
      expectedResult: criterion.then,
    })),
    riskFlags: [],
  };
}

export function computeSpecComplexity(spec: AppSpec): ComplexityResult {
  let score = 0;
  const signals: string[] = [];

  const add = (points: number, signal: string) => {
    if (points <= 0) return;
    score += points;
    signals.push(signal);
  };

  add(Math.min(spec.screens.length * 2, 12), `${spec.screens.length} screen(s)`);
  add(Math.min(spec.features.length * 2, 16), `${spec.features.length} feature(s)`);
  add(
    spec.dataEntities.length * 4 +
      spec.dataEntities.reduce(
        (sum, entity) => sum + entity.fields.length + entity.relationships.length * 2,
        0,
      ),
    `${spec.dataEntities.length} data entity/entities`,
  );
  add(spec.workflows.length * 3, `${spec.workflows.length} workflow(s)`);

  if (spec.needsLogin) add(5, "requires login");
  if (spec.sharingModel === "shared") add(8, "shared data");
  if (spec.sharingModel === "public") add(6, "public visibility");
  if (spec.capabilityTier === "shared") add(8, "shared capability tier");
  if (spec.capabilityTier === "advanced") add(15, "advanced capability tier");

  add(Math.max(0, spec.userRoles.length - 1) * 4, "multiple roles");
  add(spec.permissionRules.length * 2, "server-enforced permission rules");
  add(spec.searchRequirements.length * 3, "search/filtering");
  add(spec.fileRequirements.length * 6, "file handling");
  add(spec.integrations.length * 10, "external integrations");
  add(spec.notifications.length * 5, "notifications");
  add(spec.reports.length * 5, "reports/exports");
  add(spec.aiFeatures.length * 4, "AI features");
  if (spec.expectedDataVolume === "medium") add(4, "medium data volume");
  if (spec.expectedDataVolume === "large") add(10, "large data volume");
  if (spec.offlineSupport === "full") add(6, "full offline support");

  const level: ComplexityLevel =
    score <= 15 ? "simple" : score <= 35 ? "intermediate" : "advanced";
  return { score, level, signals };
}

function inferCapabilityTier(input: {
  sharingModel: AppSpec["sharingModel"];
  needsLogin: boolean;
  entityCount: number;
  workflowCount: number;
  fileCount: number;
  integrationCount: number;
  notificationCount: number;
  reportCount: number;
}): AppCapabilityTier {
  if (
    input.integrationCount > 0 ||
    input.notificationCount > 0 ||
    input.reportCount > 1 ||
    input.fileCount > 1 ||
    input.entityCount > 3 ||
    input.workflowCount > 6
  ) {
    return "advanced";
  }
  if (input.needsLogin || input.sharingModel !== "private") return "shared";
  return "personal";
}

function inferRoles(spec: z.infer<typeof legacyAppSpecSchema>): AppSpec["userRoles"] {
  if (!spec.needsLogin && spec.sharingModel === "private") {
    return [
      {
        name: "User",
        description: "The person using the app on their own device.",
        permissions: ["Use all app features", "Manage their own saved information"],
      },
    ];
  }

  return [
    {
      name: "Owner",
      description: "The person who creates and manages the app.",
      permissions: ["Manage the app", "Invite people", "Create, edit, and delete records"],
    },
    {
      name: "Editor",
      description: "An invited person who helps keep information up to date.",
      permissions: ["View shared information", "Create and edit shared records"],
    },
    {
      name: "Viewer",
      description: "An invited person who mostly reads information.",
      permissions: ["View shared information"],
    },
  ];
}

function inferEntities(
  spec: z.infer<typeof legacyAppSpecSchema>,
): AppSpec["dataEntities"] {
  return spec.dataToStore.map((item) => ({
    name: titleCase(singularize(firstWords(item, 3))),
    description: item,
    ownership: spec.sharingModel === "private" ? ("per_user" as const) : ("shared" as const),
    fields: [
      {
        name: "title",
        label: "Title",
        type: "text" as const,
        required: true,
        validation: "Use a short name so the item is easy to recognize.",
      },
      {
        name: "notes",
        label: "Notes",
        type: "long_text" as const,
        required: false,
        validation: "",
      },
    ],
    relationships: [],
  }));
}

function inferWorkflows(
  spec: z.infer<typeof legacyAppSpecSchema>,
): AppSpec["workflows"] {
  return spec.features.map((feature) => ({
    name: feature,
    actor: spec.needsLogin ? "Signed-in user" : "User",
    trigger: "The user opens the relevant screen.",
    steps: [`Open the right screen`, feature, "Review the result"],
    successOutcome: "The user can complete the task without confusion.",
    failureStates: ["No saved information yet", "Invalid or missing information"],
  }));
}

function inferPermissionRules(
  spec: z.infer<typeof legacyAppSpecSchema>,
  roles: AppSpec["userRoles"],
  entities: AppSpec["dataEntities"],
): AppSpec["permissionRules"] {
  if (entities.length === 0) return [];
  return roles.map((role) => ({
    role: role.name,
    entity: "All saved information",
    actions:
      role.name === "Viewer"
        ? (["read"] as Array<"read">)
        : (["create", "read", "update", "delete"] as Array<
            "create" | "read" | "update" | "delete"
          >),
    condition:
      spec.sharingModel === "private"
        ? "Only records belonging to that user."
        : "Only records belonging to this shared app.",
  }));
}

function inferSearchRequirements(
  spec: z.infer<typeof legacyAppSpecSchema>,
): AppSpec["searchRequirements"] {
  const searchTerms = ["search", "filter", "sort", "find"];
  if (countMatching([...spec.features, ...spec.testPlan], searchTerms) === 0) {
    return [];
  }
  return [
    {
      target: "Saved information",
      fields: ["title", "notes"],
      filters: ["Search by keyword", "Filter important categories when available"],
    },
  ];
}

function inferFileRequirements(
  spec: z.infer<typeof legacyAppSpecSchema>,
): AppSpec["fileRequirements"] {
  const fileTerms = ["photo", "image", "picture", "file", "upload", "attachment"];
  if (countMatching([...spec.features, ...spec.dataToStore], fileTerms) === 0) {
    return [];
  }
  return [
    {
      name: "Attachments",
      attachedTo: "Saved information",
      acceptedTypes: ["image/*", "application/pdf"],
      maxSizeMb: 0,
      required: false,
    },
  ];
}

function inferReports(
  spec: z.infer<typeof legacyAppSpecSchema>,
): AppSpec["reports"] {
  const reportTerms = ["chart", "report", "export", "print", "summary"];
  if (countMatching([...spec.features, ...spec.testPlan], reportTerms) === 0) {
    return [];
  }
  return [
    {
      name: "Summary",
      description: "A useful summary of the app's saved information.",
      dataNeeded: spec.dataToStore.length > 0 ? spec.dataToStore : ["Current app state"],
      exportFormats: ["screen"],
    },
  ];
}

function inferAcceptanceCriteria(
  spec: z.infer<typeof legacyAppSpecSchema>,
): AppSpec["acceptanceCriteria"] {
  const source = spec.testPlan.length > 0 ? spec.testPlan : spec.features;
  return source.map((item, index) => ({
    name: `Acceptance ${index + 1}`,
    scenario: item,
    given: "The app is open and usable.",
    when: item,
    then: "The expected result is clear and no errors occur.",
  }));
}

function countMatching(values: string[], terms: string[]): number {
  return values.filter((value) => {
    const lower = value.toLowerCase();
    return terms.some((term) => lower.includes(term));
  }).length;
}

function firstWords(value: string, count: number): string {
  const words = value
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, count);
  return words.join(" ") || "Item";
}

function singularize(value: string): string {
  return value.endsWith("s") && value.length > 3 ? value.slice(0, -1) : value;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
