import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { getDb } from "../../db";
import {
  appEntitySchemas,
  appMemberships,
  appRecordEvents,
  appRecordVersions,
  appRecords,
  apps,
  users,
  type User,
} from "../../db/schema";

type Database = ReturnType<typeof getDb>;
type PlatformUser = Pick<User, "id" | "role">;

export type AppDataRole = "owner" | "editor" | "viewer";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export const PLATFORM_DATA_MAX_ENTITY_SCHEMAS_PER_APP = 50;
export const PLATFORM_DATA_MAX_RECORDS_PER_APP = 5_000;
export const PLATFORM_DATA_MAX_RECORD_PAYLOAD_BYTES = 64 * 1024;
export const PLATFORM_DATA_MAX_RECORDS_PER_RESPONSE = 200;
export const PLATFORM_DATA_RATE_LIMIT_WINDOW_MS = 60_000;
export const PLATFORM_DATA_RATE_LIMIT_MAX_REQUESTS = 120;

const fieldTypeSchema = z.enum([
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
]);

const fieldInputSchema = z
  .object({
    key: z.string().min(1).max(80).optional(),
    label: z.string().min(1).max(120),
    type: fieldTypeSchema,
    required: z.boolean().default(false),
    options: z.array(z.string().min(1).max(120)).max(100).default([]),
    validation: z.string().max(500).default(""),
    relation: z
      .object({
        entityKey: z.string().min(1).max(80),
      })
      .optional(),
  })
  .strict();

const relationshipInputSchema = z
  .object({
    type: z
      .enum(["one_to_one", "one_to_many", "many_to_many", "belongs_to"])
      .default("belongs_to"),
    targetEntityKey: z.string().min(1).max(80),
    description: z.string().max(500).default(""),
  })
  .strict();

export const platformEntityInputSchema = z
  .object({
    key: z.string().min(1).max(80).optional(),
    name: z.string().min(1).max(120),
    description: z.string().max(800).default(""),
    fields: z.array(fieldInputSchema).min(1).max(100),
    relationships: z.array(relationshipInputSchema).max(50).default([]),
  })
  .strict();

export const membershipRoleSchema = z.enum(["owner", "editor", "viewer"]);

export type PlatformFieldDefinition = {
  key: string;
  label: string;
  type: z.infer<typeof fieldTypeSchema>;
  required: boolean;
  options: string[];
  validation: string;
  relation?: { entityKey: string };
};

export type PlatformRelationshipDefinition = {
  type: "one_to_one" | "one_to_many" | "many_to_many" | "belongs_to";
  targetEntityKey: string;
  description: string;
};

export type PlatformEntityDefinition = {
  key: string;
  name: string;
  description: string;
  fields: PlatformFieldDefinition[];
  relationships: PlatformRelationshipDefinition[];
};

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export class PlatformDataError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PlatformDataError";
  }
}

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export function normalizeEntityKey(value: string): string {
  const key = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return key || "item";
}

export function normalizeEntityDefinition(
  input: unknown,
): PlatformEntityDefinition {
  const parsed = platformEntityInputSchema.parse(input);
  const fields = parsed.fields.map((field) => ({
    key: normalizeEntityKey(field.key ?? field.label),
    label: field.label.trim(),
    type: field.type,
    required: field.required,
    options: [...new Set(field.options.map((option) => option.trim()))].filter(
      Boolean,
    ),
    validation: field.validation.trim(),
    relation: field.relation
      ? { entityKey: normalizeEntityKey(field.relation.entityKey) }
      : undefined,
  }));
  const duplicateField = findDuplicate(fields.map((field) => field.key));
  if (duplicateField) {
    throw new PlatformDataError(
      400,
      "duplicate_field",
      `Field key "${duplicateField}" is used more than once.`,
    );
  }

  return {
    key: normalizeEntityKey(parsed.key ?? parsed.name),
    name: parsed.name.trim(),
    description: parsed.description.trim(),
    fields,
    relationships: parsed.relationships.map((relationship) => ({
      type: relationship.type,
      targetEntityKey: normalizeEntityKey(relationship.targetEntityKey),
      description: relationship.description.trim(),
    })),
  };
}

export function validateRecordData(
  entity: PlatformEntityDefinition,
  input: unknown,
): { ok: true; data: JsonObject } | { ok: false; issues: string[] } {
  const parsed = jsonObjectSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: ["Record data must be a JSON object."] };
  }

  const data = parsed.data;
  const issues: string[] = [];
  const knownKeys = new Set(entity.fields.map((field) => field.key));
  for (const key of Object.keys(data)) {
    if (!knownKeys.has(key)) {
      issues.push(`Unknown field "${key}".`);
    }
  }

  for (const field of entity.fields) {
    const value = data[field.key];
    if (isMissing(value)) {
      if (field.required) {
        issues.push(`${field.label} is required.`);
      }
      continue;
    }
    const issue = validateFieldValue(field, value);
    if (issue) issues.push(issue);
  }

  if (jsonSizeBytes(data) > PLATFORM_DATA_MAX_RECORD_PAYLOAD_BYTES) {
    issues.push(
      `Record payload is too large. Limit is ${PLATFORM_DATA_MAX_RECORD_PAYLOAD_BYTES} bytes.`,
    );
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, data };
}

export function canReadAppData(role: AppDataRole | null): boolean {
  return role !== null;
}

export function canWriteAppData(role: AppDataRole | null): boolean {
  return role === "owner" || role === "editor";
}

export function canManageAppData(role: AppDataRole | null): boolean {
  return role === "owner";
}

export function consumePlatformDataRateLimit(
  key: string,
  now = Date.now(),
): { remaining: number; resetAt: number } {
  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + PLATFORM_DATA_RATE_LIMIT_WINDOW_MS;
    rateLimitBuckets.set(key, { count: 1, resetAt });
    return {
      remaining: PLATFORM_DATA_RATE_LIMIT_MAX_REQUESTS - 1,
      resetAt,
    };
  }
  if (existing.count >= PLATFORM_DATA_RATE_LIMIT_MAX_REQUESTS) {
    throw new PlatformDataError(
      429,
      "rate_limited",
      "Too many platform data requests. Please wait a moment and try again.",
      { resetAt: new Date(existing.resetAt).toISOString() },
    );
  }
  existing.count += 1;
  return {
    remaining: PLATFORM_DATA_RATE_LIMIT_MAX_REQUESTS - existing.count,
    resetAt: existing.resetAt,
  };
}

export function resetPlatformDataRateLimitsForTests(): void {
  rateLimitBuckets.clear();
}

export async function getAppDataRole(
  db: Database,
  appId: string,
  user: PlatformUser,
): Promise<AppDataRole | null> {
  const [app] = await db
    .select({ id: apps.id, ownerId: apps.ownerId })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  if (!app) return null;
  if (user.role === "admin" || app.ownerId === user.id) return "owner";

  const [membership] = await db
    .select({ role: appMemberships.role })
    .from(appMemberships)
    .where(
      and(eq(appMemberships.appId, appId), eq(appMemberships.userId, user.id)),
    )
    .limit(1);
  return membership?.role ?? null;
}

export async function assertCanReadAppData(
  db: Database,
  appId: string,
  user: PlatformUser,
): Promise<AppDataRole> {
  const role = await getAppDataRole(db, appId, user);
  if (role === null) {
    throw new PlatformDataError(
      404,
      "app_not_found",
      "App not found or you do not have access.",
    );
  }
  return role;
}

export async function assertCanWriteAppData(
  db: Database,
  appId: string,
  user: PlatformUser,
): Promise<AppDataRole> {
  const role = await getAppDataRole(db, appId, user);
  if (role === null) {
    throw new PlatformDataError(
      404,
      "app_not_found",
      "App not found or you do not have access.",
    );
  }
  if (!canWriteAppData(role)) {
    throw new PlatformDataError(
      403,
      "read_only",
      "You can view this app, but you cannot change its data.",
    );
  }
  return role;
}

export async function assertCanManageAppData(
  db: Database,
  appId: string,
  user: PlatformUser,
): Promise<AppDataRole> {
  const role = await getAppDataRole(db, appId, user);
  if (role === null) {
    throw new PlatformDataError(
      404,
      "app_not_found",
      "App not found or you do not have access.",
    );
  }
  if (!canManageAppData(role)) {
    throw new PlatformDataError(
      403,
      "not_owner",
      "Only app owners can manage schemas and memberships.",
    );
  }
  return role;
}

export async function listEntitySchemas(
  db: Database,
  input: { appId: string; user: PlatformUser },
) {
  await assertCanReadAppData(db, input.appId, input.user);
  return db
    .select()
    .from(appEntitySchemas)
    .where(eq(appEntitySchemas.appId, input.appId))
    .orderBy(asc(appEntitySchemas.entityKey));
}

export async function upsertEntitySchema(
  db: Database,
  input: { appId: string; user: PlatformUser; entity: unknown },
) {
  await assertCanManageAppData(db, input.appId, input.user);
  const entity = normalizeEntityDefinition(input.entity);

  const [existing] = await db
    .select({ id: appEntitySchemas.id })
    .from(appEntitySchemas)
    .where(
      and(
        eq(appEntitySchemas.appId, input.appId),
        eq(appEntitySchemas.entityKey, entity.key),
      ),
    )
    .limit(1);
  if (!existing) {
    const [{ used }] = await db
      .select({ used: count() })
      .from(appEntitySchemas)
      .where(eq(appEntitySchemas.appId, input.appId));
    if (used >= PLATFORM_DATA_MAX_ENTITY_SCHEMAS_PER_APP) {
      throw new PlatformDataError(
        409,
        "schema_quota_exceeded",
        `This app has reached the limit of ${PLATFORM_DATA_MAX_ENTITY_SCHEMAS_PER_APP} data entities.`,
      );
    }
  }

  const [row] = await db
    .insert(appEntitySchemas)
    .values({
      appId: input.appId,
      entityKey: entity.key,
      displayName: entity.name,
      definition: entity,
      createdBy: input.user.id,
    })
    .onConflictDoUpdate({
      target: [appEntitySchemas.appId, appEntitySchemas.entityKey],
      set: {
        displayName: entity.name,
        definition: entity,
        updatedAt: new Date(),
      },
    })
    .returning();

  await db.insert(appRecordEvents).values({
    appId: input.appId,
    userId: input.user.id,
    eventType: "entity_upsert",
    payload: { entityKey: entity.key },
  });

  return row;
}

export async function listRecords(
  db: Database,
  input: {
    appId: string;
    entityKey: string;
    user: PlatformUser;
    includeDeleted?: boolean;
    limit?: number;
  },
) {
  const role = await assertCanReadAppData(db, input.appId, input.user);
  if (input.includeDeleted && !canManageAppData(role)) {
    throw new PlatformDataError(
      403,
      "not_owner",
      "Only app owners can include deleted records.",
    );
  }

  const entityKey = normalizeEntityKey(input.entityKey);
  const filters = [
    eq(appRecords.appId, input.appId),
    eq(appRecords.entityKey, entityKey),
  ];
  if (!input.includeDeleted) filters.push(isNull(appRecords.deletedAt));

  const limit = Math.min(
    Math.max(input.limit ?? PLATFORM_DATA_MAX_RECORDS_PER_RESPONSE, 1),
    PLATFORM_DATA_MAX_RECORDS_PER_RESPONSE,
  );

  return db
    .select()
    .from(appRecords)
    .where(and(...filters))
    .orderBy(desc(appRecords.updatedAt))
    .limit(limit);
}

export async function getRecord(
  db: Database,
  input: { recordId: string; user: PlatformUser },
) {
  const [record] = await db
    .select()
    .from(appRecords)
    .where(eq(appRecords.id, input.recordId))
    .limit(1);
  if (!record) {
    throw new PlatformDataError(404, "record_not_found", "Record not found.");
  }
  const role = await assertCanReadAppData(db, record.appId, input.user);
  if (record.deletedAt && !canManageAppData(role)) {
    throw new PlatformDataError(404, "record_not_found", "Record not found.");
  }
  return record;
}

export async function createRecord(
  db: Database,
  input: {
    appId: string;
    entityKey: string;
    user: PlatformUser;
    data: unknown;
  },
) {
  await assertCanWriteAppData(db, input.appId, input.user);
  const entity = await getEntityDefinition(db, input.appId, input.entityKey);
  const validation = validateRecordData(entity, input.data);
  if (!validation.ok) {
    throw new PlatformDataError(
      400,
      "invalid_record",
      "Record data failed validation.",
      validation.issues,
    );
  }

  const [{ used }] = await db
    .select({ used: count() })
    .from(appRecords)
    .where(and(eq(appRecords.appId, input.appId), isNull(appRecords.deletedAt)));
  if (used >= PLATFORM_DATA_MAX_RECORDS_PER_APP) {
    throw new PlatformDataError(
      409,
      "record_quota_exceeded",
      `This app has reached the limit of ${PLATFORM_DATA_MAX_RECORDS_PER_APP} records.`,
    );
  }

  const [record] = await db
    .insert(appRecords)
    .values({
      appId: input.appId,
      entityKey: entity.key,
      ownerId: input.user.id,
      data: validation.data,
      version: 1,
    })
    .returning();

  await db.insert(appRecordVersions).values({
    recordId: record.id,
    appId: record.appId,
    version: 1,
    data: validation.data,
    changedBy: input.user.id,
  });
  await db.insert(appRecordEvents).values({
    appId: record.appId,
    recordId: record.id,
    userId: input.user.id,
    eventType: "record_create",
    payload: { entityKey: entity.key, version: 1 },
  });

  return record;
}

export async function updateRecord(
  db: Database,
  input: { recordId: string; user: PlatformUser; data: unknown },
) {
  const [record] = await db
    .select()
    .from(appRecords)
    .where(eq(appRecords.id, input.recordId))
    .limit(1);
  if (!record || record.deletedAt) {
    throw new PlatformDataError(404, "record_not_found", "Record not found.");
  }
  await assertCanWriteAppData(db, record.appId, input.user);
  const entity = await getEntityDefinition(db, record.appId, record.entityKey);
  const validation = validateRecordData(entity, input.data);
  if (!validation.ok) {
    throw new PlatformDataError(
      400,
      "invalid_record",
      "Record data failed validation.",
      validation.issues,
    );
  }

  const nextVersion = record.version + 1;
  const [updated] = await db
    .update(appRecords)
    .set({
      data: validation.data,
      version: nextVersion,
      updatedAt: new Date(),
    })
    .where(eq(appRecords.id, record.id))
    .returning();

  await db.insert(appRecordVersions).values({
    recordId: record.id,
    appId: record.appId,
    version: nextVersion,
    data: validation.data,
    changedBy: input.user.id,
  });
  await db.insert(appRecordEvents).values({
    appId: record.appId,
    recordId: record.id,
    userId: input.user.id,
    eventType: "record_update",
    payload: { entityKey: record.entityKey, version: nextVersion },
  });

  return updated;
}

export async function deleteRecord(
  db: Database,
  input: { recordId: string; user: PlatformUser },
) {
  const [record] = await db
    .select()
    .from(appRecords)
    .where(eq(appRecords.id, input.recordId))
    .limit(1);
  if (!record || record.deletedAt) {
    throw new PlatformDataError(404, "record_not_found", "Record not found.");
  }
  await assertCanWriteAppData(db, record.appId, input.user);

  const [deleted] = await db
    .update(appRecords)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(appRecords.id, record.id))
    .returning();
  await db.insert(appRecordEvents).values({
    appId: record.appId,
    recordId: record.id,
    userId: input.user.id,
    eventType: "record_delete",
    payload: { entityKey: record.entityKey, version: record.version },
  });
  return deleted;
}

export async function listMemberships(
  db: Database,
  input: { appId: string; user: PlatformUser },
) {
  await assertCanManageAppData(db, input.appId, input.user);
  return db
    .select({
      id: appMemberships.id,
      appId: appMemberships.appId,
      userId: appMemberships.userId,
      email: users.email,
      displayName: users.displayName,
      role: appMemberships.role,
      createdAt: appMemberships.createdAt,
      updatedAt: appMemberships.updatedAt,
    })
    .from(appMemberships)
    .innerJoin(users, eq(appMemberships.userId, users.id))
    .where(eq(appMemberships.appId, input.appId))
    .orderBy(asc(users.email));
}

export async function upsertMembershipByEmail(
  db: Database,
  input: {
    appId: string;
    user: PlatformUser;
    email: string;
    role: AppDataRole;
  },
) {
  await assertCanManageAppData(db, input.appId, input.user);
  const email = input.email.trim().toLowerCase();
  const role = membershipRoleSchema.parse(input.role);

  const [app] = await db
    .select({ ownerId: apps.ownerId })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  if (!app) {
    throw new PlatformDataError(
      404,
      "app_not_found",
      "App not found or you do not have access.",
    );
  }

  const [targetUser] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(sql<string>`lower(${users.email})`, email))
    .limit(1);
  if (!targetUser) {
    throw new PlatformDataError(
      404,
      "user_not_found",
      "That person has not signed in to VoiceForge V2 yet.",
    );
  }
  if (targetUser.id === app.ownerId) {
    throw new PlatformDataError(
      409,
      "owner_membership",
      "The app owner already has owner access.",
    );
  }

  const [membership] = await db
    .insert(appMemberships)
    .values({
      appId: input.appId,
      userId: targetUser.id,
      role,
      invitedBy: input.user.id,
    })
    .onConflictDoUpdate({
      target: [appMemberships.appId, appMemberships.userId],
      set: {
        role,
        updatedAt: new Date(),
      },
    })
    .returning();

  await db.insert(appRecordEvents).values({
    appId: input.appId,
    userId: input.user.id,
    eventType: "membership_upsert",
    payload: { targetUserId: targetUser.id, role },
  });

  return {
    ...membership,
    email: targetUser.email,
    displayName: targetUser.displayName,
  };
}

export async function updateMembershipRole(
  db: Database,
  input: { membershipId: string; user: PlatformUser; role: AppDataRole },
) {
  const [membership] = await db
    .select()
    .from(appMemberships)
    .where(eq(appMemberships.id, input.membershipId))
    .limit(1);
  if (!membership) {
    throw new PlatformDataError(
      404,
      "membership_not_found",
      "Membership not found.",
    );
  }
  await assertCanManageAppData(db, membership.appId, input.user);
  const role = membershipRoleSchema.parse(input.role);

  const [updated] = await db
    .update(appMemberships)
    .set({ role, updatedAt: new Date() })
    .where(eq(appMemberships.id, input.membershipId))
    .returning();
  await db.insert(appRecordEvents).values({
    appId: membership.appId,
    userId: input.user.id,
    eventType: "membership_update",
    payload: { targetUserId: membership.userId, role },
  });
  return updated;
}

export async function deleteMembership(
  db: Database,
  input: { membershipId: string; user: PlatformUser },
) {
  const [membership] = await db
    .select()
    .from(appMemberships)
    .where(eq(appMemberships.id, input.membershipId))
    .limit(1);
  if (!membership) {
    throw new PlatformDataError(
      404,
      "membership_not_found",
      "Membership not found.",
    );
  }
  await assertCanManageAppData(db, membership.appId, input.user);

  await db
    .delete(appMemberships)
    .where(eq(appMemberships.id, input.membershipId));
  await db.insert(appRecordEvents).values({
    appId: membership.appId,
    userId: input.user.id,
    eventType: "membership_delete",
    payload: { targetUserId: membership.userId, role: membership.role },
  });
  return membership;
}

export function platformDataErrorResponse(error: unknown): {
  status: number;
  body: { error: string; code?: string; details?: unknown };
} {
  if (error instanceof PlatformDataError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        details: error.details,
      },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      body: {
        error: "Invalid request.",
        code: "invalid_request",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    };
  }
  console.error("Platform data API failed:", error);
  return {
    status: 500,
    body: {
      error: "The platform data service hit a problem. Please try again.",
      code: "platform_data_error",
    },
  };
}

async function getEntityDefinition(
  db: Database,
  appId: string,
  entityKey: string,
): Promise<PlatformEntityDefinition> {
  const normalizedKey = normalizeEntityKey(entityKey);
  const [row] = await db
    .select({ definition: appEntitySchemas.definition })
    .from(appEntitySchemas)
    .where(
      and(
        eq(appEntitySchemas.appId, appId),
        eq(appEntitySchemas.entityKey, normalizedKey),
      ),
    )
    .limit(1);
  if (!row) {
    throw new PlatformDataError(
      404,
      "entity_not_found",
      `Data entity "${normalizedKey}" is not defined for this app.`,
    );
  }
  return normalizeEntityDefinition(row.definition);
}

function validateFieldValue(
  field: PlatformFieldDefinition,
  value: JsonValue,
): string | null {
  switch (field.type) {
    case "text":
    case "long_text":
    case "image":
    case "file":
    case "relation":
      return typeof value === "string" ? null : `${field.label} must be text.`;
    case "date":
      return typeof value === "string" && isValidDateValue(value)
        ? null
        : `${field.label} must be a valid date.`;
    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? null
        : `${field.label} must be a valid date and time.`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `${field.label} must be a number.`;
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `${field.label} must be true or false.`;
    case "select":
      if (typeof value !== "string") return `${field.label} must be text.`;
      return field.options.length === 0 || field.options.includes(value)
        ? null
        : `${field.label} must be one of: ${field.options.join(", ")}.`;
    case "multi_select":
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        return `${field.label} must be a list of text values.`;
      }
      if (
        field.options.length > 0 &&
        value.some((item) => !field.options.includes(item))
      ) {
        return `${field.label} contains an unsupported option.`;
      }
      return null;
    case "json":
      return null;
  }
}

function isMissing(value: JsonValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isValidDateValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function jsonSizeBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function findDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}
