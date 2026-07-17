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
      return NextResponse.json({ entities: [] });
    case "listRecords": {
      if (typeof body.entityKey !== "string") {
        return NextResponse.json({ error: "entityKey required." }, { status: 400 });
      }
      const includeDeleted = body.includeDeleted === true;
      const result = [...records.values()]
        .filter(
          (record) =>
            record.entityKey === body.entityKey &&
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
      const record: LocalRecord = {
        id: crypto.randomUUID(),
        appId: "local",
        entityKey: body.entityKey,
        ownerId: null,
        data: body.data ?? {},
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
      const updated = {
        ...record,
        data: body.data ?? {},
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
