import { describe, expect, it } from "vitest";
import {
  buildPlatformSessionStartPath,
  buildPlatformSignInPath,
  platformSignInQuerySchema,
} from "./sign-in-return";

const request = {
  appId: "27803ce8-52ff-4bc5-86fa-1c4439afe3d3",
  returnTo: "https://family-recipes.vercel.app/recipe-details?id=recipe-1",
};

describe("generated-app sign-in return", () => {
  it("preserves the generated-app destination through VoiceForge sign-in", () => {
    const signInPath = buildPlatformSignInPath(request);
    const sessionPath = buildPlatformSessionStartPath(request);

    expect(signInPath).toContain("/platform-sign-in?");
    expect(sessionPath).toContain("/api/platform/session/start?");
    for (const path of [signInPath, sessionPath]) {
      const params = new URL(path, "https://voiceforge-v2.vercel.app").searchParams;
      expect(params.get("appId")).toBe(request.appId);
      expect(params.get("returnTo")).toBe(request.returnTo);
    }
  });

  it("rejects malformed app and return destinations", () => {
    expect(platformSignInQuerySchema.safeParse({
      appId: "not-an-app",
      returnTo: "/relative",
    }).success).toBe(false);
  });
});
