import { createHmac, timingSafeEqual } from "crypto";
import { canWriteAppData } from "./data";

export type PlatformSessionRole = "owner" | "editor" | "viewer";
export type PlatformSharingModel = "private" | "shared" | "public";

export type PlatformSessionClaims = {
  appId: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: PlatformSessionRole;
  iat: number;
  exp: number;
};

export type AnonymousPlatformSession = {
  status: "anonymous";
  user: null;
  role: "editor" | "viewer";
  canWrite: boolean;
  canManage: false;
};

const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export function createPlatformSessionToken(input: {
  appId: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: PlatformSessionRole;
  now?: number;
  ttlSeconds?: number;
}): string {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const claims: PlatformSessionClaims = {
    appId: input.appId,
    userId: input.userId,
    email: input.email,
    displayName: input.displayName,
    role: input.role,
    iat: now,
    exp: now + (input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS),
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export function verifyPlatformSessionToken(
  token: string,
  now = Math.floor(Date.now() / 1000),
): PlatformSessionClaims {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    throw new Error("Invalid platform session token.");
  }
  const expected = sign(payload);
  if (!safeEqual(signature, expected)) {
    throw new Error("Invalid platform session token.");
  }

  const parsed = JSON.parse(base64UrlDecode(payload)) as PlatformSessionClaims;
  if (
    typeof parsed.appId !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.email !== "string" ||
    !["owner", "editor", "viewer"].includes(parsed.role) ||
    typeof parsed.iat !== "number" ||
    typeof parsed.exp !== "number"
  ) {
    throw new Error("Invalid platform session token.");
  }
  if (parsed.exp <= now) {
    throw new Error("Platform session expired.");
  }
  return parsed;
}

export function getAnonymousPlatformSession(input: {
  requireSession: boolean;
  sharingModel: PlatformSharingModel;
}): AnonymousPlatformSession | null {
  if (input.requireSession || input.sharingModel === "private") {
    return null;
  }
  const role = input.sharingModel === "public" ? "viewer" : "editor";
  return {
    status: "anonymous",
    user: null,
    role,
    canWrite: canWriteAppData(role),
    canManage: false,
  };
}

function sign(payload: string): string {
  return createHmac("sha256", getPlatformSessionSecret())
    .update(payload)
    .digest("base64url");
}

function getPlatformSessionSecret(): string {
  const secret =
    process.env.VOICEFORGE_PLATFORM_SESSION_SECRET ??
    process.env.CLERK_SECRET_KEY ??
    process.env.DATABASE_URL;
  if (!secret) {
    throw new Error(
      "VOICEFORGE_PLATFORM_SESSION_SECRET, CLERK_SECRET_KEY, or DATABASE_URL is required.",
    );
  }
  return secret;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
