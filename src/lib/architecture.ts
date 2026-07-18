import { z } from "zod";
import type { AppSpec, ComplexityResult } from "@/lib/spec";
import {
  DEPENDENCY_PROFILE_VALUES,
  inferDependencyProfiles,
} from "./build/dependencies";

const capabilityTierSchema = z.enum(["personal", "shared", "advanced"]);

const pagePlanSchema = z.object({
  route: z.string(),
  name: z.string(),
  purpose: z.string(),
  primaryComponents: z.array(z.string()),
  workflows: z.array(z.string()),
});

const componentPlanSchema = z.object({
  name: z.string(),
  kind: z.enum(["page", "component", "hook", "lib"]),
  responsibility: z.string(),
  state: z.string(),
});

const architectureEntitySchema = z.object({
  name: z.string(),
  storage: z.enum(["localStorage", "platformData", "none", "future"]),
  fields: z.array(z.string()),
  relationships: z.array(z.string()),
});

const permissionPlanSchema = z.object({
  role: z.string(),
  enforcement: z.enum(["notNeeded", "clientHint", "serverRequired"]),
  rules: z.array(z.string()),
});

const platformServicePlanSchema = z.object({
  service: z.enum([
    "ai",
    "data",
    "users",
    "files",
    "email",
    "jobs",
    "integrations",
    "search",
    "reports",
  ]),
  required: z.boolean(),
  availability: z.enum(["available", "not_available", "later"]),
  reason: z.string(),
});

const filePlanItemSchema = z.object({
  path: z.string(),
  kind: z.enum(["page", "component", "lib", "test", "locked"]),
  purpose: z.string(),
  dependsOn: z.array(z.string()),
});

const uxPlanSchema = z.object({
  navigation: z.array(z.string()),
  emptyStates: z.array(z.string()),
  loadingStates: z.array(z.string()),
  errorStates: z.array(z.string()),
  mobileBehavior: z.array(z.string()),
  accessibilityNotes: z.array(z.string()),
});

const testPlanSchema = z.object({
  unit: z.array(z.string()),
  workflow: z.array(z.string()),
  browser: z.array(z.string()),
  accessibility: z.array(z.string()),
  security: z.array(z.string()),
});

export const architecturePlanSchema = z.object({
  summary: z.string(),
  requestedTier: capabilityTierSchema,
  implementationTier: capabilityTierSchema,
  complexityScore: z.number().int().min(0),
  complexityLevel: z.enum(["simple", "intermediate", "advanced"]),
  pageMap: z.array(pagePlanSchema),
  componentMap: z.array(componentPlanSchema),
  dataModel: z.array(architectureEntitySchema),
  permissionModel: z.array(permissionPlanSchema),
  platformServices: z.array(platformServicePlanSchema),
  filePlan: z.array(filePlanItemSchema),
  dependencyProfile: z
    .array(z.enum(DEPENDENCY_PROFILE_VALUES))
    .describe("Approved dependency/runtime profile names"),
  buildPhases: z.array(z.string()),
  uxPlan: uxPlanSchema,
  testPlan: testPlanSchema,
  acceptanceTests: z.array(z.string()),
  riskNotes: z.array(z.string()),
  unsupportedCapabilities: z.array(z.string()),
  capabilityValidation: z.object({
    canBuildNow: z.boolean(),
    approach: z.string(),
    blockingIssues: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
});

export type ArchitecturePlan = z.infer<typeof architecturePlanSchema>;

const AVAILABLE_SERVICES = new Set(["ai", "data", "users", "files"]);

export function createFallbackArchitecturePlan(
  spec: AppSpec,
  complexity: ComplexityResult,
): ArchitecturePlan {
  const platformServices = inferPlatformServices(spec);
  const blockingIssues = blockingIssuesForServices(platformServices);
  const needsFuturePlatform = blockingIssues.length > 0;

  return {
    summary: `${spec.appName} is planned as a ${spec.capabilityTier} app with ${spec.screens.length} screen(s), ${spec.dataEntities.length} data entity/entities, and ${spec.workflows.length} workflow(s).`,
    requestedTier: spec.capabilityTier,
    implementationTier: needsFuturePlatform ? "personal" : spec.capabilityTier,
    complexityScore: complexity.score,
    complexityLevel: complexity.level,
    pageMap: spec.screens.map((screen, index) => ({
      route: index === 0 ? "/" : `/${slugify(screen.name)}`,
      name: screen.name,
      purpose: screen.description,
      primaryComponents: [`${pascalCase(screen.name)}View`],
      workflows: spec.workflows.map((workflow) => workflow.name),
    })),
    componentMap: spec.screens.map((screen) => ({
      name: `${pascalCase(screen.name)}View`,
      kind: "component",
      responsibility: screen.description,
      state: "Local React state with persisted storage where needed.",
    })),
    dataModel: spec.dataEntities.map((entity) => ({
      name: entity.name,
      storage:
        entity.ownership === "per_user" && !needsServerData(spec)
          ? "localStorage"
          : "platformData",
      fields: entity.fields.map((field) => `${field.name}:${field.type}`),
      relationships: entity.relationships.map(
        (relationship) =>
          `${relationship.type} ${relationship.targetEntity}: ${relationship.description}`,
      ),
    })),
    permissionModel: spec.permissionRules.map((rule) => ({
      role: rule.role,
      enforcement: needsGeneratedAppUsers(spec)
        ? "serverRequired"
        : needsServerData(spec)
          ? "clientHint"
          : "notNeeded",
      rules: [`${rule.entity}: ${rule.actions.join(", ")} ${rule.condition}`.trim()],
    })),
    platformServices,
    filePlan: [
      {
        path: "src/app/page.tsx",
        kind: "page",
        purpose: "Primary app shell and route.",
        dependsOn: ["src/components/*", "src/lib/*"],
      },
      {
        path: "src/lib/storage.ts",
        kind: "lib",
        purpose: "Typed local persistence for personal/browser-only apps.",
        dependsOn: [],
      },
      {
        path: "src/**/*.test.tsx",
        kind: "test",
        purpose: "Unit and workflow tests for generated features.",
        dependsOn: ["src/app/page.tsx", "src/components/*"],
      },
      ...(spec.fileRequirements.length > 0
        ? [
            {
              path: "src/lib/platform-files.ts",
              kind: "locked" as const,
              purpose:
                "Typed client for listing, uploading, downloading, and deleting platform files.",
              dependsOn: ["src/app/api/files/route.ts"],
            },
            {
              path: "src/app/api/files/route.ts",
              kind: "locked" as const,
              purpose:
                "Same-origin server proxy that forwards file operations to VoiceForge.",
              dependsOn: ["VOICEFORGE_APP_TOKEN", "VOICEFORGE_PUBLIC_URL"],
            },
          ]
        : []),
    ],
    dependencyProfile: inferDependencyProfiles(spec),
    buildPhases: [
      "Validate requested capabilities",
      "Seed platform entity schemas",
      ...(spec.fileRequirements.length > 0
        ? ["Wire locked platform file uploads and attachments"]
        : []),
      "Generate typed data shapes",
      "Generate UI components",
      "Generate pages and workflows",
      "Generate tests",
      "Run test gauntlet",
    ],
    uxPlan: {
      navigation: spec.screens.map((screen) => screen.name),
      emptyStates: ["Show a friendly empty state before data is added."],
      loadingStates: spec.aiFeatures.length > 0 ? ["Show loading states for AI calls."] : [],
      errorStates: ["Show validation and save errors in plain language."],
      mobileBehavior: ["Use a single-column mobile layout with large touch targets."],
      accessibilityNotes: ["Use labels, semantic headings, keyboard-accessible controls, and strong contrast."],
    },
    testPlan: {
      unit: spec.testScenarios
        .filter((test) => test.type === "unit")
        .map((test) => test.name),
      workflow: spec.acceptanceCriteria.map((criterion) => criterion.name),
      browser: ["Home page loads cleanly and main controls do not crash."],
      accessibility: ["No serious or critical axe violations."],
      security: [
        "No external network calls except locked platform endpoints.",
        ...(spec.fileRequirements.length > 0
          ? ["Uploaded files respect type, size, quota, and role checks."]
          : []),
      ],
    },
    acceptanceTests: spec.acceptanceCriteria.map(
      (criterion) =>
        `${criterion.name}: given ${criterion.given}, when ${criterion.when}, then ${criterion.then}`,
    ),
    riskNotes: needsFuturePlatform
      ? [
          "Current generated apps can use shared platform records, file attachments, and VoiceForge member sign-in, but email, jobs, and integrations arrive in later stages.",
        ]
      : [],
    unsupportedCapabilities: blockingIssues,
    capabilityValidation: {
      canBuildNow: !needsFuturePlatform,
      approach: needsFuturePlatform
        ? "Stop before code generation so the user can revise or wait for platform services."
        : needsServerData(spec) || spec.fileRequirements.length > 0
          ? "Build with locked platform data/file APIs and the generated app template."
          : "Build as a personal browser app using the locked template.",
      blockingIssues,
      warnings: [],
    },
  };
}

export type ArchitectureValidation = {
  canBuildNow: boolean;
  blockingIssues: string[];
  warnings: string[];
};

export function validateArchitecturePlan(
  plan: ArchitecturePlan,
): ArchitectureValidation {
  const blockingIssues = plan.capabilityValidation.blockingIssues.filter(
    (issue) => !isAvailableServiceIssue(issue),
  );
  const warnings = [...plan.capabilityValidation.warnings];

  for (const service of plan.platformServices) {
    if (
      service.required &&
      service.availability !== "available" &&
      !AVAILABLE_SERVICES.has(service.service)
    ) {
      blockingIssues.push(`${service.service}: ${service.reason}`);
    } else if (service.availability !== "available") {
      warnings.push(`${service.service}: ${service.reason}`);
    }
  }

  const onlyAvailableServiceBlocks =
    plan.capabilityValidation.blockingIssues.length > 0 &&
    plan.capabilityValidation.blockingIssues.every(isAvailableServiceIssue);

  return {
    canBuildNow:
      (plan.capabilityValidation.canBuildNow || onlyAvailableServiceBlocks) &&
      blockingIssues.length === 0,
    blockingIssues: [...new Set(blockingIssues)],
    warnings: [...new Set(warnings)],
  };
}

function isAvailableServiceIssue(issue: string): boolean {
  const service = issue.split(":", 1)[0]?.trim();
  return service ? AVAILABLE_SERVICES.has(service) : false;
}

function inferPlatformServices(spec: AppSpec): ArchitecturePlan["platformServices"] {
  const services: ArchitecturePlan["platformServices"] = [];
  if (spec.aiFeatures.length > 0) {
    services.push({
      service: "ai",
      required: true,
      availability: "available",
      reason: "Locked /api/ai route is available for generated apps.",
    });
  }
  if (needsServerData(spec)) {
    services.push({
      service: "data",
      required: true,
      availability: "available",
      reason: "Locked platform JSONB records are available for generated apps.",
    });
  }
  if (needsGeneratedAppUsers(spec)) {
    services.push({
      service: "users",
      required: true,
      availability: "available",
      reason:
        "VoiceForge member sign-in and owner/editor/viewer roles are available for generated apps.",
    });
  }
  if (spec.fileRequirements.length > 0) {
    services.push({
      service: "files",
      required: true,
      availability: "available",
      reason:
        "Locked platform file upload, metadata, download, and archive APIs are available for generated apps.",
    });
  }
  const emailNotifications = spec.notifications.filter(
    (notification) =>
      notification.channel === "email" || notification.channel === "both",
  );
  const inAppNotifications = spec.notifications.filter(
    (notification) => notification.channel === "in_app",
  );
  if (emailNotifications.length > 0) {
    services.push({
      service: "email",
      required: true,
      availability: "later",
      reason: "Email and notifications are planned for Stage 11B.",
    });
  }
  if (inAppNotifications.length > 0) {
    services.push({
      service: "jobs",
      required: false,
      availability: "not_available",
      reason:
        "In-app reminders can be calculated while the browser app is open; background scheduled jobs arrive in a later stage.",
    });
  }
  if (spec.integrations.length > 0) {
    services.push({
      service: "integrations",
      required: true,
      availability: "later",
      reason: "External integrations are planned for Stage 12.",
    });
  }
  return services;
}

function needsServerData(spec: AppSpec): boolean {
  return (
    spec.needsLogin ||
    spec.sharingModel !== "private" ||
    spec.dataEntities.some((entity) => entity.ownership !== "per_user")
  );
}

export function needsGeneratedAppUsers(spec: AppSpec): boolean {
  return (
    spec.needsLogin ||
    spec.permissionRules.some((rule) =>
      rule.actions.some((action) => action === "invite" || action === "admin"),
    )
  );
}

function blockingIssuesForServices(
  services: ArchitecturePlan["platformServices"],
): string[] {
  return services
    .filter(
      (service) =>
        service.required &&
        service.availability !== "available" &&
        !AVAILABLE_SERVICES.has(service.service),
    )
    .map((service) => `${service.service}: ${service.reason}`);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function pascalCase(value: string): string {
  const result = value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  return result || "App";
}
