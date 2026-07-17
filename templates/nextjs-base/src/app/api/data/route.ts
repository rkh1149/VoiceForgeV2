import { NextResponse } from "next/server";

/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * Browser code in generated apps calls this same-origin route. This route
 * adds the server-only VoiceForge app token and forwards data operations to
 * VoiceForge V2's platform data service. The token is never sent to the
 * browser.
 */

type DataAction =
  | "session"
  | "listSchemas"
  | "listRecords"
  | "getRecord"
  | "createRecord"
  | "updateRecord"
  | "deleteRecord";

type DataBody = {
  action?: unknown;
  entityKey?: unknown;
  recordId?: unknown;
  data?: unknown;
  includeDeleted?: unknown;
  limit?: unknown;
  sessionToken?: unknown;
  returnTo?: unknown;
};

type LocalRecord = {
  id: string;
  appId: string;
  entityKey: string;
  ownerId: string | null;
  data: unknown;
  version: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type LocalFieldSchema = {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  required?: unknown;
  options?: unknown;
};

type LocalEntitySchema = {
  key?: unknown;
  name?: unknown;
  displayName?: unknown;
  fields?: unknown;
};

type NormalizedLocalFieldSchema = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
};

type NormalizedLocalEntitySchema = {
  key: string;
  name: string;
  fields: NormalizedLocalFieldSchema[];
};

const ACTIONS = new Set<DataAction>([
  "session",
  "listSchemas",
  "listRecords",
  "getRecord",
  "createRecord",
  "updateRecord",
  "deleteRecord",
]);

const globalStore = globalThis as typeof globalThis & {
  __voiceforgeLocalData?: Map<string, LocalRecord>;
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as DataBody | null;
  if (!body || typeof body.action !== "string" || !ACTIONS.has(body.action as DataAction)) {
    return NextResponse.json({ error: "Invalid data action." }, { status: 400 });
  }

  if (process.env.VOICEFORGE_DATA_LOCAL_FALLBACK === "1") {
    return handleLocalData(body as DataBody & { action: DataAction });
  }

  const base = process.env.VOICEFORGE_PUBLIC_URL?.replace(/\/$/, "");
  const token = process.env.VOICEFORGE_APP_TOKEN;
  const appId = process.env.VOICEFORGE_APP_ID;
  if (!base || !token) {
    return NextResponse.json(
      { error: "Platform data is not enabled for this app." },
      { status: 503 },
    );
  }
  const requireSession = process.env.VOICEFORGE_REQUIRE_SIGN_IN === "1";
  const sharingModel = normalizeSharingModel(process.env.VOICEFORGE_SHARING_MODEL);
  const sessionToken =
    typeof body.sessionToken === "string" ? body.sessionToken : undefined;

  if (body.action === "session" && (!appId || typeof body.returnTo !== "string")) {
    return NextResponse.json(
      { error: "Platform sign-in is not configured for this app." },
      { status: 503 },
    );
  }

  const platformRes = await fetch(`${base}/api/platform-data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      token,
      sessionToken,
      requireSession,
      sharingModel,
    }),
  }).catch(() => null);

  if (!platformRes) {
    return NextResponse.json(
      { error: "Platform data is unavailable right now." },
      { status: 502 },
    );
  }

  if (body.action === "session") {
    const payload = (await platformRes.json().catch(() => ({}))) as {
      session?: unknown;
      error?: string;
      code?: string;
    };
    const loginUrl = buildLoginUrl(base, appId as string, body.returnTo as string);
    if (!platformRes.ok) {
      return NextResponse.json(
        {
          session: {
            status:
              payload.code === "no_access" || payload.code === "wrong_app_session"
                ? "no_access"
                : "signed_out",
            user: null,
            role: null,
            canWrite: false,
            canManage: false,
            requireSignIn: requireSession,
            loginUrl,
            error: payload.error ?? "Please sign in with VoiceForge.",
          },
        },
        { status: 200 },
      );
    }
    return NextResponse.json({
      session: {
        ...(payload.session as object),
        requireSignIn: requireSession,
        loginUrl,
      },
    });
  }

  const text = await platformRes.text();
  return new Response(text, {
    status: platformRes.status,
    headers: {
      "Content-Type":
        platformRes.headers.get("content-type") ?? "application/json",
    },
  });
}

function handleLocalData(body: DataBody & { action: DataAction }) {
  const records = getLocalRecords();
  const now = new Date().toISOString();

  switch (body.action) {
    case "session":
      return NextResponse.json({
        session: {
          status: "signed_in",
          user: {
            id: "local-user",
            email: "local@voiceforge.dev",
            displayName: "Local tester",
          },
          role: "owner",
          canWrite: true,
          canManage: true,
          requireSignIn: false,
          loginUrl: "#",
        },
      });
    case "listSchemas":
      return NextResponse.json({
        entities: getLocalSchemas().map((schema) => ({
          id: schema.key,
          appId: "local",
          entityKey: schema.key,
          displayName: schema.name,
          definition: schema,
          createdAt: now,
          updatedAt: now,
        })),
      });
    case "listRecords": {
      if (typeof body.entityKey !== "string") {
        return NextResponse.json({ error: "entityKey required." }, { status: 400 });
      }
      const entity = getLocalEntity(body.entityKey);
      if (!entity) {
        return localPlatformError(
          404,
          "entity_not_found",
          `Data entity "${normalizeEntityKey(body.entityKey)}" is not defined for this app.`,
        );
      }
      const includeDeleted = body.includeDeleted === true;
      const result = [...records.values()]
        .filter(
          (record) =>
            record.entityKey === entity.key &&
            (includeDeleted || !record.deletedAt),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return NextResponse.json({ records: result });
    }
    case "getRecord": {
      if (typeof body.recordId !== "string") {
        return NextResponse.json({ error: "recordId required." }, { status: 400 });
      }
      const record = records.get(body.recordId);
      if (!record || record.deletedAt) {
        return NextResponse.json({ error: "Record not found." }, { status: 404 });
      }
      return NextResponse.json({ record });
    }
    case "createRecord": {
      if (typeof body.entityKey !== "string") {
        return NextResponse.json({ error: "entityKey required." }, { status: 400 });
      }
      const entity = getLocalEntity(body.entityKey);
      if (!entity) {
        return localPlatformError(
          404,
          "entity_not_found",
          `Data entity "${normalizeEntityKey(body.entityKey)}" is not defined for this app.`,
        );
      }
      const validation = validateLocalRecordData(entity, body.data);
      if (!validation.ok) {
        return localPlatformError(
          400,
          "invalid_record",
          "Record data failed validation.",
          validation.issues,
        );
      }
      const record: LocalRecord = {
        id: crypto.randomUUID(),
        appId: "local",
        entityKey: entity.key,
        ownerId: null,
        data: validation.data,
        version: 1,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      records.set(record.id, record);
      return NextResponse.json({ record }, { status: 201 });
    }
    case "updateRecord": {
      if (typeof body.recordId !== "string") {
        return NextResponse.json({ error: "recordId required." }, { status: 400 });
      }
      const record = records.get(body.recordId);
      if (!record || record.deletedAt) {
        return NextResponse.json({ error: "Record not found." }, { status: 404 });
      }
      const entity = getLocalEntity(record.entityKey);
      if (!entity) {
        return localPlatformError(
          404,
          "entity_not_found",
          `Data entity "${normalizeEntityKey(record.entityKey)}" is not defined for this app.`,
        );
      }
      const validation = validateLocalRecordData(entity, body.data);
      if (!validation.ok) {
        return localPlatformError(
          400,
          "invalid_record",
          "Record data failed validation.",
          validation.issues,
        );
      }
      const updated = {
        ...record,
        data: validation.data,
        version: record.version + 1,
        updatedAt: now,
      };
      records.set(updated.id, updated);
      return NextResponse.json({ record: updated });
    }
    case "deleteRecord": {
      if (typeof body.recordId !== "string") {
        return NextResponse.json({ error: "recordId required." }, { status: 400 });
      }
      const record = records.get(body.recordId);
      if (!record || record.deletedAt) {
        return NextResponse.json({ error: "Record not found." }, { status: 404 });
      }
      const deleted = { ...record, deletedAt: now, updatedAt: now };
      records.set(deleted.id, deleted);
      return NextResponse.json({ record: deleted });
    }
  }
}

function getLocalRecords(): Map<string, LocalRecord> {
  globalStore.__voiceforgeLocalData ??= new Map<string, LocalRecord>();
  return globalStore.__voiceforgeLocalData;
}

function getLocalSchemas(): NormalizedLocalEntitySchema[] {
  const raw = process.env.VOICEFORGE_PLATFORM_SCHEMA_JSON;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(normalizeLocalEntitySchema)
    .filter((schema): schema is NormalizedLocalEntitySchema => Boolean(schema));
}

function getLocalEntity(entityKey: string): NormalizedLocalEntitySchema | null {
  const schemas = getLocalSchemas();
  if (schemas.length === 0) {
    return {
      key: normalizeEntityKey(entityKey),
      name: entityKey,
      fields: [],
    };
  }
  const normalizedKey = normalizeEntityKey(entityKey);
  return schemas.find((schema) => schema.key === normalizedKey) ?? null;
}

function normalizeLocalEntitySchema(
  input: unknown,
): NormalizedLocalEntitySchema | null {
  const entity = input as LocalEntitySchema;
  const key = normalizeEntityKey(
    stringValue(entity.key) || stringValue(entity.name) || "item",
  );
  const fields = Array.isArray(entity.fields)
    ? entity.fields
        .map(normalizeLocalFieldSchema)
        .filter((field): field is NormalizedLocalFieldSchema => Boolean(field))
    : [];
  return {
    key,
    name: stringValue(entity.name) || stringValue(entity.displayName) || key,
    fields,
  };
}

function normalizeLocalFieldSchema(
  input: unknown,
): NormalizedLocalFieldSchema | null {
  const field = input as LocalFieldSchema;
  const label = stringValue(field.label) || stringValue(field.key);
  if (!label) return null;
  const options = Array.isArray(field.options)
    ? field.options.map(stringValue).filter(Boolean)
    : [];
  return {
    key: normalizeEntityKey(stringValue(field.key) || label),
    label,
    type: stringValue(field.type) || "text",
    required: field.required === true,
    options,
  };
}

function validateLocalRecordData(
  entity: NormalizedLocalEntitySchema,
  input: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: ["Record data must be a JSON object."] };
  }

  const data = input as Record<string, unknown>;
  if (entity.fields.length === 0) return { ok: true, data };

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
      if (field.required) issues.push(`${field.label} is required.`);
      continue;
    }
    const issue = validateLocalFieldValue(field, value);
    if (issue) issues.push(issue);
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, data };
}

function validateLocalFieldValue(
  field: NormalizedLocalFieldSchema,
  value: unknown,
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
    default:
      return null;
  }
}

function isMissing(value: unknown): boolean {
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

function normalizeEntityKey(value: string): string {
  const key = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return key || "item";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function localPlatformError(
  status: number,
  code: string,
  error: string,
  details?: unknown,
) {
  return NextResponse.json({ error, code, details }, { status });
}

function buildLoginUrl(base: string, appId: string, returnTo: string): string {
  const url = new URL("/api/platform/session/start", base);
  url.searchParams.set("appId", appId);
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

function normalizeSharingModel(value: string | undefined): "private" | "shared" | "public" {
  if (value === "private" || value === "public") return value;
  return "shared";
}
