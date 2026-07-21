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
  consumePlatformIntegrationRateLimit,
  getGoogleMapsBrowserConfig,
  invokePlatformIntegrationAction,
  listPlatformIntegrationCredentials,
  listPlatformIntegrationProviders,
  revokePlatformIntegrationCredential,
  upsertPlatformIntegrationCredential,
} from "@/lib/platform/integrations";
import {
  getIntegrationAction,
  normalizeIntegrationKey,
} from "@/lib/platform/integration-catalog";
import {
  getAnonymousPlatformSession,
  verifyPlatformSessionToken,
  type PlatformSharingModel,
} from "@/lib/platform/session";

/**
 * Public server-to-server endpoint for approved generated-app integrations.
 * Generated app browsers call their own locked /api/integrations route; that
 * server route adds the app token and forwards here. Raw provider credentials
 * never leave VoiceForge's server-side integration layer.
 */

export const runtime = "nodejs";

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
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

const baseActionSchema = {
  token: tokenSchema,
  sessionToken: sessionTokenSchema,
  requireSession: z.boolean().default(false),
  sharingModel: z.enum(["private", "shared", "public"]).default("shared"),
};

const credentialSchema = z
  .object({
    providerKey: z.string().min(1).max(120),
    credentialLabel: z.string().min(1).max(120).optional(),
    authType: z.enum(["api_key", "oauth2"]).optional(),
    scopes: z.array(z.string().min(1).max(200)).max(50).optional(),
    secrets: jsonObjectSchema.optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    ...baseActionSchema,
    action: z.literal("listProviders"),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("getGoogleMapsBrowserConfig"),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("listCredentials"),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("upsertCredential"),
    credential: credentialSchema,
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("revokeCredential"),
    credentialId: z.string().uuid(),
  }),
  z.object({
    ...baseActionSchema,
    action: z.literal("invoke"),
    providerKey: z.string().min(1).max(120),
    actionKey: z.string().min(1).max(120),
    input: jsonObjectSchema.optional(),
    credentialId: z.string().uuid().optional(),
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
    consumePlatformIntegrationRateLimit(`${app.id}:server:${parsed.data.action}`);

    const auth = await resolvePlatformAuth(db, {
      app,
      sessionToken: parsed.data.sessionToken,
      requireSession: parsed.data.requireSession,
      sharingModel: parsed.data.sharingModel,
    });

    switch (parsed.data.action) {
      case "listProviders": {
        return NextResponse.json({
          providers: listPlatformIntegrationProviders(),
        });
      }
      case "getGoogleMapsBrowserConfig": {
        return NextResponse.json({
          config: getGoogleMapsBrowserConfig(),
        });
      }
      case "listCredentials": {
        assertPlatformSessionCanManage(auth.session);
        const credentials = await listPlatformIntegrationCredentials(db, {
          appId: app.id,
          user: auth.user,
        });
        return NextResponse.json({ credentials });
      }
      case "upsertCredential": {
        assertPlatformSessionCanManage(auth.session);
        const credential = await upsertPlatformIntegrationCredential(db, {
          appId: app.id,
          user: auth.user,
          credential: {
            ...parsed.data.credential,
            expiresAt: parsed.data.credential.expiresAt
              ? new Date(parsed.data.credential.expiresAt)
              : null,
          },
        });
        return NextResponse.json({ credential });
      }
      case "revokeCredential": {
        assertPlatformSessionCanManage(auth.session);
        const credential = await revokePlatformIntegrationCredential(db, {
          appId: app.id,
          user: auth.user,
          credentialId: parsed.data.credentialId,
        });
        return NextResponse.json({ credential });
      }
      case "invoke": {
        const match = getIntegrationAction(
          normalizeIntegrationKey(parsed.data.providerKey),
          normalizeIntegrationKey(parsed.data.actionKey),
        );
        if (!match) {
          throw new PlatformDataError(
            404,
            "integration_action_not_found",
            "That integration provider or action is not approved in VoiceForge V2.",
          );
        }
        assertPlatformSessionCanUseAction(auth.session, match.action.requiredRole);
        const output = await invokePlatformIntegrationAction(db, {
          appId: app.id,
          user: auth.user,
          providerKey: parsed.data.providerKey,
          actionKey: parsed.data.actionKey,
          actionInput: parsed.data.input,
          credentialId: parsed.data.credentialId,
          sessionRole: auth.session.role,
        });
        return NextResponse.json(output);
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
        "Please sign in with VoiceForge to use integrations.",
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

function assertPlatformSessionCanManage(input: { canManage: boolean }): void {
  if (!input.canManage) {
    throw new PlatformDataError(
      403,
      "not_owner",
      "Only app owners can manage integration credentials.",
    );
  }
}

function assertPlatformSessionCanUseAction(
  input: { role: "owner" | "editor" | "viewer"; canWrite: boolean },
  requiredRole: "viewer" | "editor" | "owner",
): void {
  if (requiredRole === "owner" && input.role !== "owner") {
    throw new PlatformDataError(
      403,
      "not_owner",
      "Only app owners can use this integration action.",
    );
  }
  if (requiredRole === "editor" && !input.canWrite) {
    throw new PlatformDataError(
      403,
      "read_only",
      "You can view this app, but you cannot use this integration action.",
    );
  }
}
