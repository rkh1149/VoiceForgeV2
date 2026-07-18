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
  type JsonObject,
  type JsonValue,
} from "@/lib/platform/data";
import {
  archivePlatformScheduledJob,
  consumePlatformNotificationRateLimit,
  getPlatformNotificationPreferences,
  listPlatformNotifications,
  listPlatformScheduledJobs,
  markPlatformNotificationRead,
  sendPlatformNotification,
  updatePlatformNotificationPreferences,
  upsertPlatformScheduledJob,
} from "@/lib/platform/notifications";
import {
  getAnonymousPlatformSession,
  verifyPlatformSessionToken,
  type PlatformSharingModel,
} from "@/lib/platform/session";

/**
 * Public server-to-server endpoint for generated app notifications. Generated
 * app browsers call their own locked /api/notifications route; that server
 * route adds the secret token and forwards here. Never call this directly
 * from browser code.
 */

const tokenSchema = z.string().min(20).max(200);
const sessionTokenSchema = z.string().min(20).max(4000).optional();
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
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

const baseActionSchema = {
  token: tokenSchema,
  sessionToken: sessionTokenSchema,
  requireSession: z.boolean().default(false),
  sharingModel: z.enum(["private", "shared", "public"]).default("shared"),
};

const generatedTemplateSchema = z.enum(["app_reminder", "app_update"]);
const channelSchema = z.enum(["in_app", "email", "both"]);
const recipientGroupSchema = z.enum(["owner", "editors", "members", "current_user"]);

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    ...baseActionSchema,
    action: z.literal("listNotifications"),
    unreadOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("markNotificationRead"),
    notificationId: z.string().uuid(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("getPreferences"),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("updatePreferences"),
    emailEnabled: z.boolean(),
    inAppEnabled: z.boolean(),
    digestEnabled: z.boolean(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("sendNotification"),
    templateKey: generatedTemplateSchema,
    channel: channelSchema,
    recipientGroup: recipientGroupSchema,
    title: z.string().min(1).max(160),
    message: z.string().min(1).max(2000),
    recordId: z.string().uuid().optional(),
    payload: jsonObjectSchema.optional(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("listScheduledJobs"),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("upsertScheduledJob"),
    jobKey: z.string().min(1).max(80),
    displayName: z.string().min(1).max(120),
    templateKey: generatedTemplateSchema,
    channel: channelSchema,
    recipientGroup: recipientGroupSchema,
    intervalMinutes: z.number().int().min(1),
    title: z.string().min(1).max(160),
    message: z.string().min(1).max(2000),
    active: z.boolean().default(true),
    payload: jsonObjectSchema.optional(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("archiveScheduledJob"),
    jobId: z.string().uuid(),
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
    consumePlatformNotificationRateLimit(`${app.id}:server:${parsed.data.action}`);

    const auth = await resolvePlatformAuth(db, {
      app,
      sessionToken: parsed.data.sessionToken,
      requireSession: parsed.data.requireSession,
      sharingModel: parsed.data.sharingModel,
    });
    const platformUser = auth.user;

    switch (parsed.data.action) {
      case "listNotifications": {
        const notifications = await listPlatformNotifications(db, {
          appId: app.id,
          user: platformUser,
          unreadOnly: parsed.data.unreadOnly,
          limit: parsed.data.limit,
        });
        return NextResponse.json({ notifications });
      }
      case "markNotificationRead": {
        const notification = await markPlatformNotificationRead(db, {
          notificationId: parsed.data.notificationId,
          user: platformUser,
        });
        return NextResponse.json({ notification });
      }
      case "getPreferences": {
        const preferences = await getPlatformNotificationPreferences(db, {
          appId: app.id,
          user: platformUser,
        });
        return NextResponse.json({ preferences });
      }
      case "updatePreferences": {
        const updated = await updatePlatformNotificationPreferences(db, {
          appId: app.id,
          user: platformUser,
          emailEnabled: parsed.data.emailEnabled,
          inAppEnabled: parsed.data.inAppEnabled,
          digestEnabled: parsed.data.digestEnabled,
        });
        return NextResponse.json({ preferences: updated });
      }
      case "sendNotification": {
        assertPlatformSessionCanWrite(auth.session);
        const notifications = await sendPlatformNotification(db, {
          appId: app.id,
          user: platformUser,
          notification: {
            templateKey: parsed.data.templateKey,
            channel: parsed.data.channel,
            recipientGroup: parsed.data.recipientGroup,
            title: parsed.data.title,
            message: parsed.data.message,
            recordId: parsed.data.recordId,
            payload: parsed.data.payload,
          },
        });
        return NextResponse.json({ notifications }, { status: 201 });
      }
      case "listScheduledJobs": {
        assertPlatformSessionCanManage(auth.session);
        const jobs = await listPlatformScheduledJobs(db, {
          appId: app.id,
          user: platformUser,
        });
        return NextResponse.json({ jobs });
      }
      case "upsertScheduledJob": {
        assertPlatformSessionCanManage(auth.session);
        const job = await upsertPlatformScheduledJob(db, {
          appId: app.id,
          user: platformUser,
          job: {
            jobKey: parsed.data.jobKey,
            displayName: parsed.data.displayName,
            templateKey: parsed.data.templateKey,
            channel: parsed.data.channel,
            recipientGroup: parsed.data.recipientGroup,
            intervalMinutes: parsed.data.intervalMinutes,
            title: parsed.data.title,
            message: parsed.data.message,
            active: parsed.data.active,
            payload: parsed.data.payload,
          },
        });
        return NextResponse.json({ job });
      }
      case "archiveScheduledJob": {
        assertPlatformSessionCanManage(auth.session);
        const job = await archivePlatformScheduledJob(db, {
          appId: app.id,
          user: platformUser,
          jobId: parsed.data.jobId,
        });
        return NextResponse.json({ job });
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
        "Please sign in with VoiceForge to use notifications.",
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
      "You can view this app, but you cannot send notifications.",
    );
  }
}

function assertPlatformSessionCanManage(input: { canManage: boolean }): void {
  if (!input.canManage) {
    throw new PlatformDataError(
      403,
      "not_owner",
      "Only app owners can manage scheduled notifications.",
    );
  }
}
