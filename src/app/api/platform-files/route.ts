import { eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { apps } from "@/db/schema";
import {
  canManageAppData,
  canWriteAppData,
  getAppDataRole,
  platformDataErrorResponse,
  PlatformDataError,
} from "@/lib/platform/data";
import {
  consumePlatformFileRateLimit,
  deletePlatformFile,
  downloadPlatformFile,
  listPlatformFiles,
  PLATFORM_FILES_MAX_FILE_BYTES,
  uploadPlatformFile,
} from "@/lib/platform/files";
import {
  getAnonymousPlatformSession,
  verifyPlatformSessionToken,
  type PlatformSharingModel,
} from "@/lib/platform/session";

/**
 * Public server-to-server endpoint for generated app files. Generated app
 * browsers call their own locked /api/files route; that server route adds the
 * secret app token and forwards here. Never call this directly from browser
 * code.
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
    action: z.literal("listFiles"),
    recordId: z.string().uuid().optional(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("uploadFile"),
    recordId: z.string().uuid().optional(),
    fileName: z.string().min(1).max(200),
    contentType: z.string().min(1).max(120),
    dataBase64: z.string().min(1).max(PLATFORM_FILES_MAX_FILE_BYTES * 2),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("downloadFile"),
    fileId: z.string().uuid(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("deleteFile"),
    fileId: z.string().uuid(),
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
    consumePlatformFileRateLimit(`${app.id}:server:${parsed.data.action}`);

    const auth = await resolvePlatformAuth(db, {
      app,
      sessionToken: parsed.data.sessionToken,
      requireSession: parsed.data.requireSession,
      sharingModel: parsed.data.sharingModel,
    });
    const platformUser = auth.user;

    switch (parsed.data.action) {
      case "listFiles": {
        const files = await listPlatformFiles(db, {
          appId: app.id,
          recordId: parsed.data.recordId,
          user: platformUser,
        });
        return NextResponse.json({ files });
      }
      case "uploadFile": {
        assertPlatformSessionCanWrite(auth.session);
        const file = await uploadPlatformFile(db, {
          appId: app.id,
          recordId: parsed.data.recordId,
          user: platformUser,
          fileName: parsed.data.fileName,
          contentType: parsed.data.contentType,
          dataBase64: parsed.data.dataBase64,
        });
        return NextResponse.json({ file }, { status: 201 });
      }
      case "downloadFile": {
        const download = await downloadPlatformFile(db, {
          fileId: parsed.data.fileId,
          user: platformUser,
        });
        return NextResponse.json(download);
      }
      case "deleteFile": {
        assertPlatformSessionCanWrite(auth.session);
        const file = await deletePlatformFile(db, {
          fileId: parsed.data.fileId,
          user: platformUser,
        });
        return NextResponse.json({ file });
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
      "You can view this app, but you cannot change its files.",
    );
  }
}
