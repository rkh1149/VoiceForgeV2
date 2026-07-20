import type { ArchitecturePlan, ArchitectureValidation } from "../architecture";
import { type AppSpec, isExternalIntegrationRequirement } from "../spec";
import { isApprovedIntegrationRequirement } from "../platform/integration-catalog";
import { platformEntityFromSpec } from "../platform/spec-seeding";
import { normalizeEntityKey } from "../platform/data";
import type { BuildAgentArtifactStatus } from "./agent-artifact-utils";

export type PlanningSpecialistReview = {
  agentKey: "data_modeler" | "backend_platform_planner" | "permission_reviewer";
  phaseKey: string;
  artifactType: "review_gate";
  status: BuildAgentArtifactStatus;
  summary: string;
  warnings: string[];
  blockingIssues: string[];
  payload: Record<string, unknown>;
};

export type PlanningSpecialistReviewInput = {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  architectureValidation: ArchitectureValidation;
};

export function runPlanningSpecialistReviews(
  input: PlanningSpecialistReviewInput,
): PlanningSpecialistReview[] {
  return [
    reviewDataModel(input.spec, input.architecture),
    reviewBackendPlatformPlan(input.spec, input.architecture),
    reviewPermissions(input.spec, input.architecture),
  ];
}

function reviewDataModel(
  spec: AppSpec,
  architecture: ArchitecturePlan,
): PlanningSpecialistReview {
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const specEntities = spec.dataEntities.map((entity) => ({
    spec: entity,
    key: platformEntityFromSpec(entity, spec).key,
  }));
  const architectureEntities = architecture.dataModel.map((entity) => ({
    architecture: entity,
    key: normalizeKey(entity.name),
  }));
  const architectureEntityKeys = new Set(
    architectureEntities.map((entity) => entity.key),
  );
  const missingEntities = specEntities.filter(
    (entity) => !architectureEntityKeys.has(entity.key),
  );

  if (spec.dataEntities.length > 0 && architecture.dataModel.length === 0) {
    blockingIssues.push(
      "data_model: The architecture omitted the approved data model.",
    );
  } else if (missingEntities.length > 0) {
    blockingIssues.push(
      `data_model: The architecture omitted data entities: ${missingEntities
        .map((entity) => entity.spec.name)
        .join(", ")}.`,
    );
  }

  const sharedEntityStorageIssues = specEntities.filter(({ spec: entity, key }) => {
    if (entity.ownership === "per_user" && !needsServerData(spec)) return false;
    const planned = architectureEntities.find((item) => item.key === key);
    return planned?.architecture.storage !== "platformData";
  });
  if (sharedEntityStorageIssues.length > 0) {
    blockingIssues.push(
      `data_model: Shared or signed-in entities must use platformData storage: ${sharedEntityStorageIssues
        .map((entity) => entity.spec.name)
        .join(", ")}.`,
    );
  }

  for (const { spec: entity } of specEntities) {
    if (entity.fields.length === 0) {
      warnings.push(
        `data_model: ${entity.name} has no explicit fields; VoiceForge will add a title field fallback.`,
      );
    }

    const duplicateFieldLabels = duplicates(
      entity.fields.map((field) => normalizeKey(field.name || field.label)),
    );
    if (duplicateFieldLabels.length > 0) {
      warnings.push(
        `data_model: ${entity.name} has duplicate field keys after normalization: ${duplicateFieldLabels.join(", ")}.`,
      );
    }
  }

  const specEntityKeys = new Set(specEntities.map((entity) => entity.key));
  const unknownRelationshipTargets = spec.dataEntities.flatMap((entity) =>
    entity.relationships
      .filter(
        (relationship) =>
          !specEntityKeys.has(normalizeKey(relationship.targetEntity)),
      )
      .map(
        (relationship) =>
          `${entity.name} -> ${relationship.targetEntity}`,
      ),
  );
  if (unknownRelationshipTargets.length > 0) {
    warnings.push(
      `data_model: Some relationships point to entities not in the spec: ${unknownRelationshipTargets.join(", ")}.`,
    );
  }

  if (
    (spec.searchRequirements.length > 0 || spec.reports.length > 0) &&
    spec.dataEntities.length === 0
  ) {
    blockingIssues.push(
      "data_model: Search and reports require at least one saved data entity.",
    );
  }

  return reviewResult({
    agentKey: "data_modeler",
    phaseKey: "data-model-validation",
    summary:
      blockingIssues.length > 0
        ? "Data model review found blocking mismatches before code generation."
        : warnings.length > 0
          ? "Data model review passed with notes for generation."
          : "Data model review passed.",
    warnings,
    blockingIssues,
    payload: {
      specEntities: specEntities.map((entity) => ({
        name: entity.spec.name,
        key: entity.key,
        fields: entity.spec.fields.length,
        relationships: entity.spec.relationships.length,
        ownership: entity.spec.ownership,
      })),
      architectureEntities: architecture.dataModel,
      missingEntities: missingEntities.map((entity) => entity.spec.name),
      unknownRelationshipTargets,
    },
  });
}

function reviewBackendPlatformPlan(
  spec: AppSpec,
  architecture: ArchitecturePlan,
): PlanningSpecialistReview {
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const expectedServices = expectedPlatformServices(spec);
  const planned = new Map(
    architecture.platformServices.map((service) => [service.service, service]),
  );
  const missingRequired = expectedServices.filter(
    (service) => !planned.has(service.service),
  );
  if (missingRequired.length > 0) {
    blockingIssues.push(
      `platform_plan: The architecture omitted required platform services: ${missingRequired
        .map((service) => service.service)
        .join(", ")}.`,
    );
  }

  for (const expected of expectedServices) {
    const service = planned.get(expected.service);
    if (!service) continue;
    if (service.availability !== "available") {
      blockingIssues.push(
        `platform_plan: Required service ${expected.service} is planned as ${service.availability}: ${service.reason}`,
      );
    }
  }

  const unnecessaryServices = architecture.platformServices.filter(
    (service) =>
      service.required &&
      !expectedServices.some((expected) => expected.service === service.service),
  );
  if (unnecessaryServices.length > 0) {
    warnings.push(
      `platform_plan: Architecture includes services not clearly required by the spec: ${unnecessaryServices
        .map((service) => service.service)
        .join(", ")}.`,
    );
  }

  const unsupportedRequiredIntegrations = spec.integrations
    .filter(isExternalIntegrationRequirement)
    .filter((integration) => integration.requiredForLaunch)
    .filter((integration) => !isApprovedIntegrationRequirement(integration));
  if (unsupportedRequiredIntegrations.length > 0) {
    blockingIssues.push(
      `platform_plan: Required external integrations are not in the approved catalogue: ${unsupportedRequiredIntegrations
        .map((integration) => integration.name)
        .join(", ")}.`,
    );
  }

  const directExternalIntegrationWants = spec.integrations
    .filter(isExternalIntegrationRequirement)
    .filter((integration) => !isApprovedIntegrationRequirement(integration));
  if (
    directExternalIntegrationWants.length > 0 &&
    unsupportedRequiredIntegrations.length === 0
  ) {
    warnings.push(
      `platform_plan: Optional external integrations were recorded but are not approved yet: ${directExternalIntegrationWants
        .map((integration) => integration.name)
        .join(", ")}.`,
    );
  }

  return reviewResult({
    agentKey: "backend_platform_planner",
    phaseKey: "platform-service-validation",
    summary:
      blockingIssues.length > 0
        ? "Platform service review found blockers before code generation."
        : warnings.length > 0
          ? "Platform service review passed with notes."
          : "Platform service review passed.",
    warnings,
    blockingIssues,
    payload: {
      expectedServices,
      plannedServices: architecture.platformServices,
      missingRequired: missingRequired.map((service) => service.service),
      unsupportedRequiredIntegrations: unsupportedRequiredIntegrations.map(
        (integration) => integration.name,
      ),
    },
  });
}

function reviewPermissions(
  spec: AppSpec,
  architecture: ArchitecturePlan,
): PlanningSpecialistReview {
  const warnings: string[] = [];
  const blockingIssues: string[] = [];

  if (spec.needsLogin && spec.userRoles.length === 0) {
    warnings.push(
      "permissions: Sign-in is required but the spec has no explicit user roles.",
    );
  }
  if (spec.needsLogin && spec.permissionRules.length === 0) {
    warnings.push(
      "permissions: Sign-in is required but the spec has no explicit permission rules.",
    );
  }

  const mutatingPublicRules = spec.permissionRules.filter(
    (rule) =>
      spec.sharingModel === "public" &&
      rule.actions.some((action) =>
        ["create", "update", "delete", "invite", "admin"].includes(action),
      ),
  );
  if (mutatingPublicRules.length > 0) {
    blockingIssues.push(
      "permissions: Public apps are read-only in VoiceForge V2; use shared access for collaborative editing.",
    );
  }

  const needsServerPermissions =
    spec.needsLogin ||
    spec.permissionRules.some((rule) =>
      rule.actions.some((action) => action === "invite" || action === "admin"),
    );
  const hasServerEnforcement = architecture.permissionModel.some(
    (rule) => rule.enforcement === "serverRequired",
  );
  if (needsServerPermissions && !hasServerEnforcement) {
    blockingIssues.push(
      "permissions: The architecture must require server-enforced VoiceForge roles for signed-in or admin workflows.",
    );
  }

  const memberAccessWants = [
    ...spec.features,
    ...spec.workflows.flatMap((workflow) => [
      workflow.name,
      workflow.trigger,
      workflow.successOutcome,
      ...workflow.steps,
    ]),
    ...spec.permissionRules.flatMap((rule) => [
      rule.role,
      rule.entity,
      ...rule.actions,
      rule.condition,
    ]),
  ].filter((value) => /\b(invite|remove member|revoke|access)\b/i.test(value));
  if (memberAccessWants.length > 0) {
    warnings.push(
      "permissions: Generated apps can enforce owner/editor/viewer roles, but real invite/remove access is managed from the VoiceForge dashboard.",
    );
  }

  return reviewResult({
    agentKey: "permission_reviewer",
    phaseKey: "permission-validation",
    summary:
      blockingIssues.length > 0
        ? "Permission review found blockers before code generation."
        : warnings.length > 0
          ? "Permission review passed with notes for role-aware UI."
          : "Permission review passed.",
    warnings,
    blockingIssues,
    payload: {
      needsLogin: spec.needsLogin,
      sharingModel: spec.sharingModel,
      userRoles: spec.userRoles.map((role) => role.name),
      permissionRules: spec.permissionRules.map((rule) => ({
        role: rule.role,
        entity: rule.entity,
        actions: rule.actions,
      })),
      architecturePermissionModel: architecture.permissionModel,
      memberAccessMentions: memberAccessWants.slice(0, 10),
    },
  });
}

function reviewResult(input: {
  agentKey: PlanningSpecialistReview["agentKey"];
  phaseKey: string;
  summary: string;
  warnings: string[];
  blockingIssues: string[];
  payload: Record<string, unknown>;
}): PlanningSpecialistReview {
  return {
    agentKey: input.agentKey,
    phaseKey: input.phaseKey,
    artifactType: "review_gate",
    status:
      input.blockingIssues.length > 0
        ? "failed"
        : input.warnings.length > 0
          ? "warning"
          : "passed",
    summary: input.summary,
    warnings: [...new Set(input.warnings)],
    blockingIssues: [...new Set(input.blockingIssues)],
    payload: {
      ...input.payload,
      warnings: [...new Set(input.warnings)],
      blockingIssues: [...new Set(input.blockingIssues)],
    },
  };
}

function expectedPlatformServices(
  spec: AppSpec,
): Array<{ service: ArchitecturePlan["platformServices"][number]["service"] }> {
  const services: Array<{
    service: ArchitecturePlan["platformServices"][number]["service"];
  }> = [];
  const add = (
    service: ArchitecturePlan["platformServices"][number]["service"],
  ) => {
    if (!services.some((item) => item.service === service)) {
      services.push({ service });
    }
  };

  if (spec.aiFeatures.length > 0) add("ai");
  if (needsServerData(spec)) add("data");
  if (spec.needsLogin || spec.permissionRules.some(hasAdminAction)) add("users");
  if (spec.fileRequirements.length > 0) add("files");
  if (needsServerData(spec) && spec.searchRequirements.length > 0) add("search");
  if (needsServerData(spec) && spec.reports.length > 0) add("reports");
  if (spec.notifications.some((notification) => notification.channel !== "none")) {
    add("jobs");
  }
  if (
    spec.notifications.some(
      (notification) =>
        notification.channel === "email" || notification.channel === "both",
    )
  ) {
    add("email");
  }
  if (
    spec.integrations
      .filter(isExternalIntegrationRequirement)
      .some(isApprovedIntegrationRequirement)
  ) {
    add("integrations");
  }

  return services;
}

function hasAdminAction(rule: AppSpec["permissionRules"][number]): boolean {
  return rule.actions.some((action) => action === "invite" || action === "admin");
}

function needsServerData(spec: AppSpec): boolean {
  return (
    spec.needsLogin ||
    spec.sharingModel !== "private" ||
    spec.dataEntities.some((entity) => entity.ownership !== "per_user")
  );
}

function normalizeKey(value: string): string {
  return normalizeEntityKey(value);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}
