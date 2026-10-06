import { NextResponse } from "next/server";

/**
 * Server-side defense in depth for generated app mutations.
 *
 * VoiceForge's platform service is authoritative and enforces the same seeded
 * policy. This guard also evaluates that policy in the generated app's server
 * route so direct API callers are rejected before a mutation is forwarded.
 */

type MutationAction = "create" | "update" | "delete";
type MutationCondition =
  | "none"
  | "record_owner"
  | "related_record_owner"
  | "not_related_record_owner";
type MemberRole = "owner" | "editor" | "viewer";

type MutationBody = {
  action: string;
  entityKey?: unknown;
  recordId?: unknown;
  data?: unknown;
};

type RemotePolicyInput = {
  base: string;
  token: string;
  body: MutationBody;
  sessionToken?: string;
  requireSession: boolean;
  sharingModel: "private" | "shared" | "public";
};

type RemoteRecord = {
  id: string;
  entityKey: string;
  ownerId: string | null;
  data: Record<string, unknown>;
  deletedAt?: string | null;
};

type MutationRule = {
  roles: MemberRole[];
  condition: MutationCondition;
  relationField?: string;
  relationEntityKey?: string;
};

type EntityMutationPolicy = {
  key: string;
  name: string;
  mutationPolicy: Record<MutationAction, MutationRule>;
};

const remoteSchemaCache = new Map<
  string,
  { expiresAt: number; schemas: EntityMutationPolicy[] }
>();

export async function enforceRemoteMutationPolicy(
  input: RemotePolicyInput,
): Promise<NextResponse | null> {
  if (
    input.body.action !== "createRecord" &&
    input.body.action !== "updateRecord" &&
    input.body.action !== "deleteRecord"
  ) {
    return null;
  }

  const [sessionResult, schemasResult] = await Promise.all([
    callPlatformForAuthorization(input, { action: "session" }),
    getRemoteSchemas(input),
  ]);
  const session = sessionResult.payload.session as
    | { status?: unknown; role?: unknown; user?: { id?: unknown } | null }
    | undefined;
  const userId = typeof session?.user?.id === "string" ? session.user.id : "";
  const role = normalizeRole(session?.role);
  if (!sessionResult.ok || session?.status !== "signed_in" || !userId || !role) {
    return policyError(401, "signed_in_member_required", "Sign in before changing app data.");
  }
  if (!schemasResult.ok) {
    return policyError(
      503,
      "mutation_policy_unavailable",
      "The server could not verify this data change safely. Please try again.",
    );
  }

  let record: RemoteRecord | undefined;
  let entityKey = "";
  let mutationData: unknown = input.body.data;
  if (input.body.action === "createRecord") {
    entityKey =
      typeof input.body.entityKey === "string"
        ? normalizeEntityKey(input.body.entityKey)
        : "";
  } else {
    if (typeof input.body.recordId !== "string") {
      return policyError(400, "record_id_required", "A record ID is required.");
    }
    const recordResult = await callPlatformForAuthorization(input, {
      action: "getRecord",
      recordId: input.body.recordId,
    });
    record = recordResult.payload.record as RemoteRecord | undefined;
    if (!recordResult.ok || !record || record.deletedAt) {
      return policyError(404, "record_not_found", "Record not found.");
    }
    entityKey = normalizeEntityKey(record.entityKey);
    mutationData = record.data;
  }

  const entity = schemasResult.schemas.find((schema) => schema.key === entityKey);
  if (!entity) {
    return policyError(
      403,
      "entity_mutation_not_configured",
      "This data change is not allowed because no server mutation policy is configured.",
    );
  }
  const action: MutationAction =
    input.body.action === "createRecord"
      ? "create"
      : input.body.action === "updateRecord"
        ? "update"
        : "delete";
  const rule = entity.mutationPolicy[action];
  if (!rule.roles.includes(role)) {
    return policyError(
      403,
      "entity_action_forbidden",
      `Your role cannot ${action} ${entity.name} records.`,
    );
  }
  if (rule.condition === "none") return null;
  if (rule.condition === "record_owner") {
    return record?.ownerId === userId
      ? null
      : policyError(
          403,
          "record_owner_required",
          `Only the person who created this ${entity.name} can ${action} it.`,
        );
  }

  const relationValue =
    rule.relationField && isPlainObject(mutationData)
      ? mutationData[rule.relationField]
      : undefined;
  const relationId = typeof relationValue === "string" ? relationValue : "";
  if (!relationId) {
    return policyError(400, "related_record_required", "A related record is required.");
  }
  const relatedResult = await callPlatformForAuthorization(input, {
    action: "getRecord",
    recordId: relationId,
  });
  const related = relatedResult.payload.record as RemoteRecord | undefined;
  if (
    !relatedResult.ok ||
    !related ||
    related.deletedAt ||
    (rule.relationEntityKey &&
      normalizeEntityKey(related.entityKey) !== rule.relationEntityKey)
  ) {
    return policyError(404, "related_record_not_found", "The related record was not found.");
  }
  const ownsRelated = related.ownerId === userId;
  const allowed =
    rule.condition === "related_record_owner" ? ownsRelated : !ownsRelated;
  if (allowed) return null;
  return policyError(
    403,
    rule.condition === "related_record_owner"
      ? "related_record_owner_required"
      : "different_related_record_owner_required",
    rule.condition === "related_record_owner"
      ? `Only the creator of the related record can ${action} this ${entity.name}.`
      : `You cannot ${action} this ${entity.name} for your own related record.`,
  );
}

async function getRemoteSchemas(
  input: RemotePolicyInput,
): Promise<{ ok: boolean; schemas: EntityMutationPolicy[] }> {
  const cacheKey = `${input.base}:${input.token}`;
  const cached = remoteSchemaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, schemas: cached.schemas };
  }
  const result = await callPlatformForAuthorization(input, { action: "listSchemas" });
  const entities = Array.isArray(result.payload.entities)
    ? result.payload.entities
    : [];
  const schemas = entities
    .map((entry) => {
      if (!isPlainObject(entry)) return null;
      return normalizeEntityPolicy(entry.definition ?? entry);
    })
    .filter((schema): schema is EntityMutationPolicy => Boolean(schema));
  if (result.ok && schemas.length > 0) {
    remoteSchemaCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60_000,
      schemas,
    });
  }
  return { ok: result.ok && schemas.length > 0, schemas };
}

async function callPlatformForAuthorization(
  input: RemotePolicyInput,
  action: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> }> {
  const response = await fetch(`${input.base}/api/platform-data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...action,
      token: input.token,
      sessionToken: input.sessionToken,
      requireSession: input.requireSession,
      sharingModel: input.sharingModel,
    }),
  }).catch(() => null);
  if (!response) return { ok: false, status: 502, payload: {} };
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, payload };
}

function normalizeEntityPolicy(input: unknown): EntityMutationPolicy | null {
  if (!isPlainObject(input)) return null;
  const keySource = stringValue(input.key) || stringValue(input.name);
  if (!keySource || !isPlainObject(input.mutationPolicy)) return null;
  return {
    key: normalizeEntityKey(keySource),
    name: stringValue(input.name) || keySource,
    mutationPolicy: {
      create: normalizeRule(input.mutationPolicy.create),
      update: normalizeRule(input.mutationPolicy.update),
      delete: normalizeRule(input.mutationPolicy.delete),
    },
  };
}

function normalizeRule(input: unknown): MutationRule {
  if (!isPlainObject(input)) {
    return { roles: [], condition: "none" };
  }
  const roles = Array.isArray(input.roles)
    ? input.roles.map(normalizeRole).filter((role): role is MemberRole => Boolean(role))
    : [];
  const condition: MutationCondition =
    input.condition === "record_owner" ||
    input.condition === "related_record_owner" ||
    input.condition === "not_related_record_owner"
      ? input.condition
      : "none";
  return {
    roles,
    condition,
    relationField:
      typeof input.relationField === "string"
        ? normalizeEntityKey(input.relationField)
        : undefined,
    relationEntityKey:
      typeof input.relationEntityKey === "string"
        ? normalizeEntityKey(input.relationEntityKey)
        : undefined,
  };
}

function normalizeRole(input: unknown): MemberRole | null {
  return input === "owner" || input === "editor" || input === "viewer"
    ? input
    : null;
}

function normalizeEntityKey(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function policyError(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status });
}
