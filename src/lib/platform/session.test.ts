import { describe, expect, it } from "vitest";
import {
  createPlatformSessionToken,
  getAnonymousPlatformSession,
  verifyPlatformSessionToken,
} from "./session";

describe("platform generated-app sessions", () => {
  it("signs and verifies app member claims", () => {
    process.env.VOICEFORGE_PLATFORM_SESSION_SECRET = "test-secret";
    const token = createPlatformSessionToken({
      appId: "app-1",
      userId: "user-1",
      email: "member@example.com",
      displayName: "Member",
      role: "editor",
      now: 100,
      ttlSeconds: 60,
    });

    expect(verifyPlatformSessionToken(token, 120)).toMatchObject({
      appId: "app-1",
      userId: "user-1",
      email: "member@example.com",
      role: "editor",
    });
  });

  it("rejects expired and tampered tokens", () => {
    process.env.VOICEFORGE_PLATFORM_SESSION_SECRET = "test-secret";
    const token = createPlatformSessionToken({
      appId: "app-1",
      userId: "user-1",
      email: "member@example.com",
      displayName: null,
      role: "viewer",
      now: 100,
      ttlSeconds: 10,
    });

    expect(() => verifyPlatformSessionToken(token, 111)).toThrow(/expired/i);
    expect(() => verifyPlatformSessionToken(`${token}x`, 105)).toThrow(
      /invalid/i,
    );
  });

  it("maps sharing models to anonymous access safely", () => {
    expect(
      getAnonymousPlatformSession({
        requireSession: false,
        sharingModel: "shared",
      }),
    ).toMatchObject({ role: "editor", canWrite: true });
    expect(
      getAnonymousPlatformSession({
        requireSession: false,
        sharingModel: "public",
      }),
    ).toMatchObject({ role: "viewer", canWrite: false });
    expect(
      getAnonymousPlatformSession({
        requireSession: false,
        sharingModel: "private",
      }),
    ).toBeNull();
    expect(
      getAnonymousPlatformSession({
        requireSession: true,
        sharingModel: "shared",
      }),
    ).toBeNull();
  });
});
