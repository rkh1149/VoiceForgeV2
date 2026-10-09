import type { ArchitecturePlan } from "../architecture";
import { platformEntityFromSpec } from "../platform/spec-seeding";
import type { AppSpec } from "../spec";

export const ENTITY_BEHAVIOR_VALUES = [
  "primary",
  "child",
  "append_only",
  "system_managed",
  "read_only",
] as const;

export type EntityBehavior = (typeof ENTITY_BEHAVIOR_VALUES)[number];

export type EntityBehaviorClassification = {
  entityName: string;
  entityKey: string;
  behavior: EntityBehavior;
  parentEntityName: string | null;
  requiredUserOperations: Array<"create" | "read" | "update" | "delete">;
  reason: string;
};

const APPEND_ONLY_PATTERN =
  /\b(history|audit|activity log|event log|status change|status history|timeline entry|notification log)\b/i;
const CHILD_PATTERN =
  /\b(ingredient|instruction|line item|detail row|step|waypoint|attachment metadata|track point)\b/i;

export function classifyEntityBehaviors(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
}): EntityBehaviorClassification[] {
  return input.spec.dataEntities.map((entity) => {
    const schema = platformEntityFromSpec(entity, input.spec);
    const planned = input.architecture.dataModel.find(
      (candidate) => normalize(candidate.name) === normalize(entity.name),
    );
    const permissions = input.spec.permissionRules.filter((rule) =>
      targetsEntity(rule.entity, entity.name),
    );
    const allowed = new Set<string>(permissions.flatMap((rule) => rule.actions));
    const parentRelationship = entity.relationships.find(
      (relationship) => relationship.type === "belongs_to",
    );
    const text = `${entity.name} ${entity.description}`;

    if (entity.ownership === "system" || planned?.storage === "none") {
      return classification(entity.name, schema.key, "system_managed", null, [],
        "The entity is platform/system managed and does not need generated CRUD controls.");
    }
    if (
      entity.ownership === "public_read" ||
      (permissions.length > 0 && !["create", "update", "delete", "admin"].some((action) => allowed.has(action)))
    ) {
      return classification(entity.name, schema.key, "read_only", null, ["read"],
        "The approved permissions expose this entity for reading only.");
    }
    if (APPEND_ONLY_PATTERN.test(text)) {
      return classification(entity.name, schema.key, "append_only", parentRelationship?.targetEntity ?? null, ["create", "read"],
        "This is historical/event data: users may add and read entries, but should not need edit/delete screens.");
    }
    if (parentRelationship || CHILD_PATTERN.test(text)) {
      return classification(entity.name, schema.key, "child", parentRelationship?.targetEntity ?? null, ["create", "read", "update", "delete"],
        "This entity is managed inside its parent workflow instead of through independent top-level CRUD.");
    }
    return classification(entity.name, schema.key, "primary", null, ["create", "read", "update", "delete"],
      "This is an independently managed user-facing record.");
  });
}

function classification(
  entityName: string,
  entityKey: string,
  behavior: EntityBehavior,
  parentEntityName: string | null,
  requiredUserOperations: EntityBehaviorClassification["requiredUserOperations"],
  reason: string,
): EntityBehaviorClassification {
  return { entityName, entityKey, behavior, parentEntityName, requiredUserOperations, reason };
}

function targetsEntity(ruleEntity: string, entityName: string): boolean {
  const rule = normalize(ruleEntity);
  const entity = normalize(entityName);
  return /\ball\b.*\b(records?|data|information)\b/.test(rule) || rule.includes(entity) || entity.includes(rule);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
