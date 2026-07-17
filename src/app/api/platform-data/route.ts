import { NextResponse } from "next/server";
import { or, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { apps } from "@/db/schema";
import {
  canManageAppData,
  canWriteAppData,
  createRecord,
  consumePlatformDataRateLimit,
  deleteRecord,
  getRecord,
  getAppDataRole,
  listEntitySchemas,
  listRecords,
  platformDataErrorResponse,
  PlatformDataError,
  updateRecord,
} from "@/lib/platform/data";
import {
  getAnonymousPlatformSession,
  verifyPlatformSessionToken,
  type PlatformSharingModel,
} from "@/lib/platform/session";

/**
 * Public server-to-server endpoint for generated apps. Generated app browsers
 * call their own locked /api/data route; that server route adds the secret
 * token and forwards here. Never call this directly from browser code.
 */

const tokenSchema = z.string().min(20).max(200);
const sessionTokenSchema = z.string().min(20).max(4000).optional();

const baseActionSchema = {
  token: tokenSchema,
  sessionToken: sessionTokenSchema,
  requireSession: z.boolean().default(false),
  sharingModel: z.enum(["private", "shared", "public"]).default("shared"),
};

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    ...baseActionSchema,
    action: z.literal("session"),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("listSchemas"),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("listRecords"),
    entityKey: z.string().min(1).max(80),
    includeDeleted: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("getRecord"),
    recordId: z.string().uuid(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("createRecord"),
    entityKey: z.string().min(1).max(80),
    data: z.unknown(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("updateRecord"),
    recordId: z.string().uuid(),
    data: z.unknown(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("deleteRecord"),
    recordId: z.string().uuid(),
  }),
]);

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const response = platformDataErrorResponse(parsed.error);
    return NextResponse.json(response.body, { status: response.status });
  }

  try {
    const db = getDb();
    const [app] = await db
      .select({
        id: apps.id,
        ownerId: apps.ownerId,
      })
      .from(apps)
      .where(
        or(
          eq(apps.platformToken, parsed.data.token),
          eq(apps.aiToken, parsed.data.token),
        ),
      )
      .limit(1);
    if (!app) {
      return NextResponse.json({ error: "Unknown app" }, { status: 401 });
    }
    consumePlatformDataRateLimit(`${app.id}:server:${parsed.data.action}`);

    const auth = await resolvePlatformAuth(db, {
      app,
      sessionToken: parsed.data.sessionToken,
      requireSession: parsed.data.requireSession,
      sharingModel: parsed.data.sharingModel,
    });

    if (parsed.data.action === "session") {
      return NextResponse.json({ session: auth.session });
    }

    const platformUser = auth.user;
    switch (parsed.data.action) {
      case "listSchemas": {
        const entities = await listEntitySchemas(db, {
          appId: app.id,
          user: platformUser,
        });
        return NextResponse.json({ entities });
      }
      case "listRecords": {
        if (parsed.data.includeDeleted && !auth.session.canManage) {
          throw new PlatformDataError(
            403,
            "not_owner",
            "Only app owners can include deleted records.",
          );
        }
        const records = await listRecords(db, {
          appId: app.id,
          entityKey: parsed.data.entityKey,
          includeDeleted: parsed.data.includeDeleted,
          limit: parsed.data.limit,
          user: platformUser,
        });
        return NextResponse.json({ records });
      }
      case "getRecord": {
        const record = await getRecord(db, {
          recordId: parsed.data.recordId,
          user: platformUser,
        });
        if (record.deletedAt && !auth.session.canManage) {
          throw new PlatformDataError(404, "record_not_found", "Record not found.");
        }
        return NextResponse.json({ record });
      }
      case "createRecord": {
        assertPlatformSessionCanWrite(auth.session);
        const record = await createRecord(db, {
          appId: app.id,
          entityKey: parsed.data.entityKey,
          data: parsed.data.data,
          user: platformUser,
        });
        return NextResponse.json({ record }, { status: 201 });
      }
      case "updateRecord": {
        assertPlatformSessionCanWrite(auth.session);
        const record = await updateRecord(db, {
          recordId: parsed.data.recordId,
          data: parsed.data.data,
          user: platformUser,
        });
        return NextResponse.json({ record });
      }
      case "deleteRecord": {
        assertPlatformSessionCanWrite(auth.session);
        const record = await deleteRecord(db, {
          recordId: parsed.data.recordId,
          user: platformUser,
        });
        return NextResponse.json({ record });
      }
    }
  } catch (error) {
    const response = platformDataErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}

type PlatformApp = {
  id: string;
  ownerId: string;
};

async function resolvePlatformAuth(
  db: ReturnType<typeof getDb>,
  input: {
    app: PlatformApp;
    sessionToken?: string;
    requireSession: boolean;
    sharingModel: PlatformSharingModel;
  },
): Promise<{
  user: { id: string; role: "user" };
  session: {
    status: "anonymous" | "signed_in";
    user: { id: string; email: string; displayName: string | null } | null;
    role: "owner" | "editor" | "viewer";
    canWrite: boolean;
    canManage: boolean;
  };
}> {
  if (!input.sessionToken) {
    const anonymousSession = getAnonymousPlatformSession({
      requireSession: input.requireSession,
      sharingModel: input.sharingModel,
    });
    if (!anonymousSession) {
      throw new PlatformDataError(
        401,
        "sign_in_required",
        "Please sign in with VoiceForge to use this app.",
      );
    }
    return {
      user: { id: input.app.ownerId, role: "user" },
      session: anonymousSession,
    };
  }

  let claims: ReturnType<typeof verifyPlatformSessionToken>;
  try {
    claims = verifyPlatformSessionToken(input.sessionToken);
  } catch {
    throw new PlatformDataError(
      401,
      "invalid_session",
      "Your VoiceForge sign-in has expired. Please sign in again.",
    );
  }
  if (claims.appId !== input.app.id) {
    throw new PlatformDataError(
      403,
      "wrong_app_session",
      "This sign-in is for a different app.",
    );
  }

  const platformUser = { id: claims.userId, role: "user" as const };
  const currentRole = await getAppDataRole(db, input.app.id, platformUser);
  if (!currentRole) {
    throw new PlatformDataError(
      403,
      "no_access",
      "You do not have access to this app.",
    );
  }

  return {
    user: platformUser,
    session: {
      status: "signed_in",
      user: {
        id: claims.userId,
        email: claims.email,
        displayName: claims.displayName,
      },
      role: currentRole,
      canWrite: canWriteAppData(currentRole),
      canManage: canManageAppData(currentRole),
    },
  };
}

function assertPlatformSessionCanWrite(input: { canWrite: boolean }): void {
  if (!input.canWrite) {
    throw new PlatformDataError(
      403,
      "read_only",
      "You can view this app, but you cannot change its data.",
    );
  }
}
