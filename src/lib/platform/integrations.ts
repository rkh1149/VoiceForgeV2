import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { and, count, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import type { getDb } from "../../db";
import {
  appIntegrationCredentials,
  appIntegrationEvents,
  type AppIntegrationCredential,
  type User,
} from "../../db/schema";
import {
  assertCanManageAppData,
  assertCanReadAppData,
  assertCanWriteAppData,
  PlatformDataError,
  type AppDataRole,
  type JsonObject,
  type JsonValue,
} from "./data";
import {
  getIntegrationAction,
  getIntegrationProvider,
  invokeCatalogIntegrationAction,
  listPublicIntegrationProviders,
  normalizeIntegrationKey,
  type IntegrationAuthType,
  type PublicIntegrationProvider,
} from "./integration-catalog";

type Database = ReturnType<typeof getDb>;
type PlatformIntegrationUser = Pick<User, "id" | "role">;

export type IntegrationCredentialMetadata = Omit<
  AppIntegrationCredential,
  "encryptedPayload"
> & {
  hasSecret: boolean;
};

export type IntegrationCredentialDraft = {
  providerKey: string;
  credentialLabel?: string;
  authType?: IntegrationAuthType;
  scopes?: string[];
  secrets?: JsonObject;
  expiresAt?: Date | null;
};

type EncryptedSecretPayload = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

export const PLATFORM_INTEGRATIONS_RATE_LIMIT_WINDOW_MS = 60_000;
export const PLATFORM_INTEGRATIONS_RATE_LIMIT_MAX_REQUESTS = 40;
export const PLATFORM_INTEGRATIONS_MAX_INVOCATIONS_PER_APP_PER_DAY = 500;

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export function listPlatformIntegrationProviders(): PublicIntegrationProvider[] {
  return listPublicIntegrationProviders();
}

export function consumePlatformIntegrationRateLimit(
  key: string,
  now = Date.now(),
): { remaining: number; resetAt: number } {
  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + PLATFORM_INTEGRATIONS_RATE_LIMIT_WINDOW_MS;
    rateLimitBuckets.set(key, { count: 1, resetAt });
    return {
      remaining: PLATFORM_INTEGRATIONS_RATE_LIMIT_MAX_REQUESTS - 1,
      resetAt,
    };
  }
  if (existing.count >= PLATFORM_INTEGRATIONS_RATE_LIMIT_MAX_REQUESTS) {
    throw new PlatformDataError(
      429,
      "rate_limited",
      "Too many platform integration requests. Please wait a moment and try again.",
      { resetAt: new Date(existing.resetAt).toISOString() },
    );
  }
  existing.count += 1;
  return {
    remaining: PLATFORM_INTEGRATIONS_RATE_LIMIT_MAX_REQUESTS - existing.count,
    resetAt: existing.resetAt,
  };
}

export function resetPlatformIntegrationRateLimitsForTests(): void {
  rateLimitBuckets.clear();
}

export async function listPlatformIntegrationCredentials(
  db: Database,
  input: { appId: string; user: PlatformIntegrationUser },
): Promise<IntegrationCredentialMetadata[]> {
  await assertCanManageAppData(db, input.appId, input.user);
  const rows = await db
    .select()
    .from(appIntegrationCredentials)
    .where(eq(appIntegrationCredentials.appId, input.appId))
    .orderBy(desc(appIntegrationCredentials.updatedAt));
  return rows.map(credentialMetadata);
}

export async function upsertPlatformIntegrationCredential(
  db: Database,
  input: {
    appId: string;
    user: PlatformIntegrationUser;
    credential: IntegrationCredentialDraft;
  },
): Promise<IntegrationCredentialMetadata> {
  await assertCanManageAppData(db, input.appId, input.user);
  const providerKey = normalizeIntegrationKey(input.credential.providerKey);
  const provider = getIntegrationProvider(providerKey);
  if (!provider) {
    throw new PlatformDataError(
      404,
      "integration_provider_not_found",
      "That integration provider is not approved in VoiceForge V2.",
    );
  }
  if (provider.authType === "none") {
    throw new PlatformDataError(
      400,
      "integration_credentials_not_required",
      "This integration does not use stored credentials.",
    );
  }
  const secrets = input.credential.secrets ?? {};
  const parsedSecrets = provider.credentialSchema?.safeParse(secrets);
  if (parsedSecrets && !parsedSecrets.success) throw parsedSecrets.error;

  const encryptedPayload = encryptIntegrationSecrets(
    (parsedSecrets?.data ?? secrets) as JsonObject,
  );
  const credentialLabel =
    normalizeCredentialLabel(input.credential.credentialLabel) ?? "Default";
  const scopes = normalizeScopes(input.credential.scopes);
  const [row] = await db
    .insert(appIntegrationCredentials)
    .values({
      appId: input.appId,
      providerKey,
      credentialLabel,
      authType: input.credential.authType ?? provider.authType,
      scopes,
      encryptedPayload,
      status: "active",
      createdBy: input.user.id,
      expiresAt: input.credential.expiresAt ?? null,
      revokedAt: null,
      lastError: null,
      lastValidatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        appIntegrationCredentials.appId,
        appIntegrationCredentials.providerKey,
        appIntegrationCredentials.credentialLabel,
      ],
      set: {
        authType: input.credential.authType ?? provider.authType,
        scopes,
        encryptedPayload,
        status: "active",
        expiresAt: input.credential.expiresAt ?? null,
        revokedAt: null,
        lastError: null,
        lastValidatedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();

  await db.insert(appIntegrationEvents).values({
    appId: input.appId,
    credentialId: row.id,
    userId: input.user.id,
    providerKey,
    actionKey: "credential_upsert",
    status: "succeeded",
    requestSummary: {
      credentialLabel,
      authType: row.authType,
      scopes,
      secrets: credentialSecretSummary(secrets),
    },
    responseSummary: { credentialId: row.id, status: row.status },
  });

  return credentialMetadata(row);
}

export async function revokePlatformIntegrationCredential(
  db: Database,
  input: {
    appId: string;
    user: PlatformIntegrationUser;
    credentialId: string;
  },
): Promise<IntegrationCredentialMetadata> {
  await assertCanManageAppData(db, input.appId, input.user);
  const [row] = await db
    .update(appIntegrationCredentials)
    .set({
      status: "revoked",
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appIntegrationCredentials.id, input.credentialId),
        eq(appIntegrationCredentials.appId, input.appId),
      ),
    )
    .returning();
  if (!row) {
    throw new PlatformDataError(
      404,
      "integration_credential_not_found",
      "Integration credential not found.",
    );
  }
  await db.insert(appIntegrationEvents).values({
    appId: input.appId,
    credentialId: row.id,
    userId: input.user.id,
    providerKey: row.providerKey,
    actionKey: "credential_revoke",
    status: "succeeded",
    requestSummary: { credentialId: row.id },
    responseSummary: { status: row.status },
  });
  return credentialMetadata(row);
}

export async function invokePlatformIntegrationAction(
  db: Database,
  input: {
    appId: string;
    user: PlatformIntegrationUser;
    providerKey: string;
    actionKey: string;
    actionInput?: unknown;
    credentialId?: string;
    sessionRole?: AppDataRole;
  },
): Promise<JsonObject> {
  const providerKey = normalizeIntegrationKey(input.providerKey);
  const actionKey = normalizeIntegrationKey(input.actionKey);
  const match = getIntegrationAction(providerKey, actionKey);
  if (!match) {
    throw new PlatformDataError(
      404,
      "integration_action_not_found",
      "That integration provider or action is not approved in VoiceForge V2.",
    );
  }
  const role = await assertRoleForAction(db, {
    appId: input.appId,
    user: input.user,
    requiredRole: match.action.requiredRole,
    sessionRole: input.sessionRole,
  });
  consumePlatformIntegrationRateLimit(
    `${input.appId}:${input.user.id}:${providerKey}:${actionKey}`,
  );
  await assertIntegrationDailyQuota(db, input.appId);

  const started = Date.now();
  let credential:
    | { id: string; scopes: string[]; secrets: JsonObject }
    | undefined;
  try {
    credential = await resolveCredentialForProvider(db, {
      appId: input.appId,
      providerKey,
      credentialId: input.credentialId,
    });
    const result = await invokeCatalogIntegrationAction({
      providerKey,
      actionKey,
      input: input.actionInput ?? {},
      context: {
        appId: input.appId,
        userId: input.user.id,
        credential,
      },
    });
    await db.insert(appIntegrationEvents).values({
      appId: input.appId,
      credentialId: credential?.id,
      userId: input.user.id,
      providerKey,
      actionKey,
      status: "succeeded",
      durationMs: Date.now() - started,
      requestSummary: sanitizeIntegrationPayload(input.actionInput ?? {}),
      responseSummary: sanitizeIntegrationPayload(result),
    });
    return {
      providerKey,
      actionKey,
      role,
      result,
    };
  } catch (error) {
    await db.insert(appIntegrationEvents).values({
      appId: input.appId,
      credentialId: credential?.id,
      userId: input.user.id,
      providerKey,
      actionKey,
      status: "failed",
      durationMs: Date.now() - started,
      requestSummary: sanitizeIntegrationPayload(input.actionInput ?? {}),
      errorCode: error instanceof PlatformDataError ? error.code : "integration_error",
      errorMessage:
        error instanceof Error ? error.message.slice(0, 500) : "Integration failed.",
    });
    throw error;
  }
}

export function encryptIntegrationSecrets(
  secrets: JsonObject,
  rawKey = process.env.VOICEFORGE_INTEGRATION_ENCRYPTION_KEY,
): EncryptedSecretPayload {
  const key = integrationEncryptionKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptIntegrationSecrets(
  payload: unknown,
  rawKey = process.env.VOICEFORGE_INTEGRATION_ENCRYPTION_KEY,
): JsonObject {
  const parsed = encryptedSecretPayloadSchema.parse(payload);
  const key = integrationEncryptionKey(rawKey);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(parsed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as JsonObject;
}

export function sanitizeIntegrationPayload(input: unknown): JsonValue {
  return sanitizeValue(input, 0);
}

function credentialMetadata(
  row: AppIntegrationCredential,
): IntegrationCredentialMetadata {
  const { encryptedPayload, ...metadata } = row;
  return {
    ...metadata,
    hasSecret: encryptedPayload !== null && encryptedPayload !== undefined,
  };
}

async function assertRoleForAction(
  db: Database,
  input: {
    appId: string;
    user: PlatformIntegrationUser;
    requiredRole: "viewer" | "editor" | "owner";
    sessionRole?: AppDataRole;
  },
): Promise<AppDataRole> {
  if (input.sessionRole) {
    if (input.requiredRole === "owner" && input.sessionRole !== "owner") {
      throw new PlatformDataError(
        403,
        "not_owner",
        "Only app owners can use this integration action.",
      );
    }
    if (
      input.requiredRole === "editor" &&
      input.sessionRole !== "owner" &&
      input.sessionRole !== "editor"
    ) {
      throw new PlatformDataError(
        403,
        "read_only",
        "You can view this app, but you cannot use this integration action.",
      );
    }
    return input.sessionRole;
  }
  if (input.requiredRole === "owner") {
    return assertCanManageAppData(db, input.appId, input.user);
  }
  if (input.requiredRole === "editor") {
    return assertCanWriteAppData(db, input.appId, input.user);
  }
  return assertCanReadAppData(db, input.appId, input.user);
}

async function resolveCredentialForProvider(
  db: Database,
  input: { appId: string; providerKey: string; credentialId?: string },
): Promise<{ id: string; scopes: string[]; secrets: JsonObject } | undefined> {
  const provider = getIntegrationProvider(input.providerKey);
  if (!provider || provider.authType === "none") return undefined;
  const filters = [
    eq(appIntegrationCredentials.appId, input.appId),
    eq(appIntegrationCredentials.providerKey, input.providerKey),
    eq(appIntegrationCredentials.status, "active"),
    isNull(appIntegrationCredentials.revokedAt),
  ];
  if (input.credentialId) {
    filters.push(eq(appIntegrationCredentials.id, input.credentialId));
  }
  const [row] = await db
    .select()
    .from(appIntegrationCredentials)
    .where(and(...filters))
    .orderBy(desc(appIntegrationCredentials.updatedAt))
    .limit(1);
  if (!row) {
    throw new PlatformDataError(
      409,
      "integration_not_configured",
      "This app does not have an active credential for that integration.",
    );
  }
  return {
    id: row.id,
    scopes: normalizeScopes(row.scopes),
    secrets: decryptIntegrationSecrets(row.encryptedPayload),
  };
}

async function assertIntegrationDailyQuota(
  db: Database,
  appId: string,
): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ used }] = await db
    .select({ used: count() })
    .from(appIntegrationEvents)
    .where(and(eq(appIntegrationEvents.appId, appId), gte(appIntegrationEvents.createdAt, since)));
  if (used >= PLATFORM_INTEGRATIONS_MAX_INVOCATIONS_PER_APP_PER_DAY) {
    throw new PlatformDataError(
      409,
      "integration_quota_exceeded",
      `This app has reached the daily limit of ${PLATFORM_INTEGRATIONS_MAX_INVOCATIONS_PER_APP_PER_DAY} integration requests.`,
    );
  }
}

function integrationEncryptionKey(rawKey: string | undefined): Buffer {
  const trimmed = rawKey?.trim();
  if (!trimmed) {
    throw new PlatformDataError(
      503,
      "integration_encryption_not_configured",
      "Integration credential encryption is not configured.",
    );
  }
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) return decoded;
  if (trimmed.length < 32) {
    throw new PlatformDataError(
      503,
      "integration_encryption_key_too_short",
      "Integration credential encryption key must be at least 32 characters.",
    );
  }
  return createHash("sha256").update(trimmed).digest();
}

function credentialSecretSummary(input: JsonObject): JsonObject {
  return {
    present: Object.keys(input).length > 0,
    fields: Object.keys(input).map((key) => `${key}:redacted`),
  };
}

function normalizeCredentialLabel(value: string | undefined): string | null {
  const label = value?.trim().replace(/\s+/g, " ").slice(0, 120);
  return label || null;
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 50),
    ),
  ];
}

const encryptedSecretPayloadSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("aes-256-gcm"),
    iv: z.string().min(1),
    tag: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict();

function sanitizeValue(input: unknown, depth: number): JsonValue {
  if (depth > 4) return "[truncated]";
  if (input === null) return null;
  if (
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean"
  ) {
    return typeof input === "string" ? input.slice(0, 300) : input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 25).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof input !== "object") return String(input).slice(0, 300);
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input).slice(0, 50)) {
    if (isSensitiveKey(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitizeValue(value, depth + 1);
    }
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  return /secret|token|password|api[_-]?key|authorization|credential/i.test(key);
}
