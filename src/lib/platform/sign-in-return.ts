import { z } from "zod";

export const platformSignInQuerySchema = z.object({
  appId: z.string().uuid(),
  returnTo: z.string().url().max(2000),
});

export type PlatformSignInQuery = z.infer<typeof platformSignInQuerySchema>;

export function buildPlatformSignInPath(input: PlatformSignInQuery): string {
  return buildPath("/platform-sign-in", input);
}

export function buildPlatformSessionStartPath(
  input: PlatformSignInQuery,
): string {
  return buildPath("/api/platform/session/start", input);
}

function buildPath(pathname: string, input: PlatformSignInQuery): string {
  const params = new URLSearchParams({
    appId: input.appId,
    returnTo: input.returnTo,
  });
  return `${pathname}?${params.toString()}`;
}
