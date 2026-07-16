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
): PlatformEntityDefinition {
  const usedKeys = new Map<string, number>();
  const fields =
    entity.fields.length > 0
      ? entity.fields.map((field) => {
          const baseKey = normalizeEntityKey(field.name || field.label);
          const key = uniqueKey(baseKey, usedKeys);
          return {
            key,
            label: field.label || field.name || key,
            type: field.type,
            required: field.required,
            options: [],
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
  const entities = input.spec.dataEntities.map(platformEntityFromSpec);
  for (const entity of entities) {
    await upsertEntitySchema(db, {
      appId: input.appId,
      user: input.user,
      entity,
    });
  }
  return entities;
}

function uniqueKey(baseKey: string, usedKeys: Map<string, number>): string {
  const count = usedKeys.get(baseKey) ?? 0;
  usedKeys.set(baseKey, count + 1);
  return count === 0 ? baseKey : `${baseKey}_${count + 1}`;
}
