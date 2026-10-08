import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apps } from "@/db/schema";
import { audit } from "@/lib/audit";
import { getGeneratedAppName } from "@/lib/generated-apps";
import { getAppDataRole } from "@/lib/platform/data";
import { createPlatformSessionToken } from "@/lib/platform/session";
import {
  buildPlatformSignInPath,
  platformSignInQuerySchema,
} from "@/lib/platform/sign-in-return";
import { getOrCreateCurrentUser } from "@/lib/users";

export async function GET(req: Request) {
  const parsed = platformSignInQuerySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sign-in request." }, { status: 400 });
  }

  const user = await getOrCreateCurrentUser();
  if (!user) {
    return NextResponse.redirect(
      new URL(buildPlatformSignInPath(parsed.data), req.url),
    );
  }

  const returnTo = new URL(parsed.data.returnTo);
  const db = getDb();
  const [app] = await db
    .select({
      id: apps.id,
      slug: apps.slug,
      ownerId: apps.ownerId,
      previewUrl: apps.previewUrl,
      productionUrl: apps.productionUrl,
    })
    .from(apps)
    .where(eq(apps.id, parsed.data.appId))
    .limit(1);
  if (!app) {
    return NextResponse.json({ error: "App not found." }, { status: 404 });
  }
  if (!isAllowedReturnUrl(returnTo, app)) {
    return NextResponse.json({ error: "Invalid return URL." }, { status: 400 });
  }

  const role = await getAppDataRole(db, app.id, user);
  if (!role) {
    return redirectWithError(returnTo, "no_access");
  }

  const token = createPlatformSessionToken({
    appId: app.id,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role,
  });
  await audit({
    userId: user.id,
    appId: app.id,
    action: "platformSession.created",
    payload: { role, returnOrigin: returnTo.origin },
  });

  returnTo.searchParams.set("vf_session", token);
  returnTo.searchParams.delete("vf_error");
  return NextResponse.redirect(returnTo);
}

function isAllowedReturnUrl(
  url: URL,
  app: {
    slug: string;
    previewUrl: string | null;
    productionUrl: string | null;
  },
): boolean {
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return process.env.NODE_ENV !== "production" || !process.env.VERCEL;
  }

  const allowedOrigins = [app.previewUrl, app.productionUrl]
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value as string).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (allowedOrigins.includes(url.origin)) return true;

  const generatedName = getGeneratedAppName(app.slug);
  return (
    url.hostname === `${generatedName}.vercel.app` ||
    (url.hostname.endsWith(".vercel.app") &&
      url.hostname.startsWith(`${generatedName}-`))
  );
}

function redirectWithError(returnTo: URL, code: string): NextResponse {
  returnTo.searchParams.delete("vf_session");
  returnTo.searchParams.set("vf_error", code);
  return NextResponse.redirect(returnTo);
}
