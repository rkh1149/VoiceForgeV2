import type { getDb } from "../../db";
import type { AppSpec } from "../spec";
import {
  normalizeEntityKey,
  upsertEntitySchema,
  type PlatformEntityDefinition,
  type PlatformFieldDefinition,
} from "./data";

type Database = ReturnType<typeof getDb>;

type PlatformSeedUser = {
  id: string;
  role: "admin" | "user";
};

export function platformEntityFromSpec(
  entity: AppSpec["dataEntities"][number],
  spec?: AppSpec,
): PlatformEntityDefinition {
  const usedKeys = new Map<string, number>();
  const fields: PlatformFieldDefinition[] =
    entity.fields.length > 0
      ? entity.fields.map((field) => {
          const baseKey = normalizeEntityKey(field.name || field.label);
          const key = uniqueKey(baseKey, usedKeys);
          return {
            key,
            label: field.label || field.name || key,
            type: field.type,
            required: field.required,
            options: inferFieldOptions(field),
            validation: field.validation,
            relation:
              field.type === "relation"
                ? {
                    entityKey: normalizeEntityKey(
                      entity.relationships[0]?.targetEntity ?? "item",
                    ),
                  }
                : undefined,
          } satisfies PlatformFieldDefinition;
        })
      : [
          {
            key: "title",
            label: "Title",
            type: "text" as const,
            required: true,
            options: [],
            validation: "A short name for this record.",
          },
        ];
  for (const relationship of entity.relationships) {
    if (relationship.type !== "belongs_to") continue;
    const relationKey = normalizeEntityKey(`${relationship.targetEntity} id`);
    if (fields.some((field) => field.key === relationKey)) continue;
    fields.push({
      key: uniqueKey(relationKey, usedKeys),
      label: `${relationship.targetEntity} ID`,
      type: "relation",
      required: true,
      options: [],
      validation: `Related ${relationship.targetEntity} record id.`,
      relation: {
        entityKey: normalizeEntityKey(relationship.targetEntity),
      },
    });
  }
  if (spec && shouldAddCompletionField(entity, spec, fields)) {
    fields.push({
      key: "bought",
      label: completionFieldLabel(spec),
      type: "boolean",
      required: false,
      options: [],
      validation: "Whether this item has been completed.",
    });
  }

  return {
    key: normalizeEntityKey(entity.name),
    name: entity.name,
    description: entity.description,
    fields,
    relationships: entity.relationships.map((relationship) => ({
      type: relationship.type,
      targetEntityKey: normalizeEntityKey(relationship.targetEntity),
      description: relationship.description,
    })),
  };
}

export async function seedPlatformEntitySchemasFromSpec(
  db: Database,
  input: {
    appId: string;
    user: PlatformSeedUser;
    spec: AppSpec;
  },
): Promise<PlatformEntityDefinition[]> {
  const entities = input.spec.dataEntities.map((entity) =>
    platformEntityFromSpec(entity, input.spec),
  );
  for (const entity of entities) {
    await upsertEntitySchema(db, {
      appId: input.appId,
      user: input.user,
      entity,
    });
  }
  return entities;
}

function inferFieldOptions(
  field: AppSpec["dataEntities"][number]["fields"][number],
): string[] {
  if (field.type !== "select" && field.type !== "multi_select") return [];
  const match = field.validation.match(
    /(?:choose\s+one\s+of|choose\s+from|one\s+of|options?\s+are)\s*:?\s*([^.;]+)/i,
  );
  if (!match?.[1]) return [];
  return [
    ...new Set(
      match[1]
        .replace(/\bor\b/gi, ",")
        .replace(/\band\b/gi, ",")
        .split(",")
        .map((option) => option.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean),
    ),
  ];
}

function shouldAddCompletionField(
  entity: AppSpec["dataEntities"][number],
  spec: AppSpec,
  fields: PlatformFieldDefinition[],
): boolean {
  if (fields.some((field) => field.type === "boolean")) return false;
  const text = [
    spec.appName,
    ...spec.features,
    ...spec.testPlan,
    ...spec.acceptanceCriteria.map((criterion) => criterion.scenario),
    ...spec.workflows.flatMap((workflow) => [
      workflow.name,
      workflow.successOutcome,
      ...workflow.steps,
    ]),
    entity.name,
    entity.description,
  ]
    .join(" ")
    .toLowerCase();
  return /\b(bought|buy|purchased|done|complete|completed|finished|checked off|mark)\b/.test(
    text,
  );
}

function completionFieldLabel(spec: AppSpec): string {
  const text = `${spec.appName} ${spec.features.join(" ")}`.toLowerCase();
  if (/\b(bought|buy|purchased)\b/.test(text)) return "Bought";
  return "Done";
}

function uniqueKey(baseKey: string, usedKeys: Map<string, number>): string {
  const count = usedKeys.get(baseKey) ?? 0;
  usedKeys.set(baseKey, count + 1);
  return count === 0 ? baseKey : `${baseKey}_${count + 1}`;
}
