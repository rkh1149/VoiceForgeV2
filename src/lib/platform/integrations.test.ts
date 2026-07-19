import { beforeEach, describe, expect, it } from "vitest";
import { PlatformDataError } from "./data";
import {
  getIntegrationAction,
  isApprovedIntegrationRequirement,
  invokeCatalogIntegrationAction,
  listPublicIntegrationProviders,
} from "./integration-catalog";
import {
  PLATFORM_INTEGRATIONS_RATE_LIMIT_MAX_REQUESTS,
  PLATFORM_INTEGRATIONS_RATE_LIMIT_WINDOW_MS,
  consumePlatformIntegrationRateLimit,
  decryptIntegrationSecrets,
  encryptIntegrationSecrets,
  resetPlatformIntegrationRateLimitsForTests,
  sanitizeIntegrationPayload,
} from "./integrations";

describe("integration catalogue", () => {
  it("publishes only approved provider/action metadata", () => {
    const providers = listPublicIntegrationProviders();

    expect(providers).toEqual([
      expect.objectContaining({
        providerKey: "demo_directory",
        authType: "none",
        actions: expect.arrayContaining([
          expect.objectContaining({ actionKey: "list_contacts" }),
          expect.objectContaining({ actionKey: "lookup_contact" }),
          expect.objectContaining({ actionKey: "record_contact_note" }),
        ]),
      }),
    ]);
    expect(JSON.stringify(providers)).not.toContain("inputSchema");
  });

  it("matches approved requirements and rejects unsupported providers", () => {
    expect(
      isApprovedIntegrationRequirement({
        name: "Demo Directory",
        purpose: "Import sample external contacts.",
      }),
    ).toBe(true);
    expect(
      isApprovedIntegrationRequirement({
        name: "Google Calendar",
        purpose: "Two-way calendar sync.",
      }),
    ).toBe(false);
  });

  it("validates and invokes demo provider actions", async () => {
    const result = await invokeCatalogIntegrationAction({
      providerKey: "demo_directory",
      actionKey: "list_contacts",
      input: { query: "avery", limit: 5 },
      context: { appId: "app_1", userId: "user_1" },
    });

    expect(result).toMatchObject({
      provider: "demo_directory",
      contacts: [
        expect.objectContaining({
          id: "demo-avery",
          email: "avery.chen@example.test",
        }),
      ],
    });

    await expect(
      invokeCatalogIntegrationAction({
        providerKey: "demo_directory",
        actionKey: "lookup_contact",
        input: { contactId: "missing" },
        context: { appId: "app_1", userId: "user_1" },
      }),
    ).rejects.toThrow(PlatformDataError);
  });

  it("describes required roles for write-like actions", () => {
    const match = getIntegrationAction("demo_directory", "record_contact_note");

    expect(match?.action.requiredRole).toBe("editor");
  });
});

describe("integration credential safety", () => {
  it("encrypts secrets and redacts sensitive payload keys", () => {
    const key = "x".repeat(32);
    const encrypted = encryptIntegrationSecrets(
      { apiKey: "secret-value", region: "ca" },
      key,
    );

    expect(JSON.stringify(encrypted)).not.toContain("secret-value");
    expect(decryptIntegrationSecrets(encrypted, key)).toEqual({
      apiKey: "secret-value",
      region: "ca",
    });
    expect(
      sanitizeIntegrationPayload({
        apiKey: "secret-value",
        nested: { accessToken: "token-value", name: "Avery" },
      }),
    ).toEqual({
      apiKey: "[redacted]",
      nested: { accessToken: "[redacted]", name: "Avery" },
    });
  });
});

describe("integration rate limits", () => {
  beforeEach(() => {
    resetPlatformIntegrationRateLimitsForTests();
  });

  it("limits bursts and resets after the window", () => {
    const now = Date.now();
    for (let i = 0; i < PLATFORM_INTEGRATIONS_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      consumePlatformIntegrationRateLimit("app:integrations", now);
    }

    expect(() =>
      consumePlatformIntegrationRateLimit("app:integrations", now),
    ).toThrow(PlatformDataError);

    const afterWindow = now + PLATFORM_INTEGRATIONS_RATE_LIMIT_WINDOW_MS + 1;
    expect(
      consumePlatformIntegrationRateLimit("app:integrations", afterWindow)
        .remaining,
    ).toBe(PLATFORM_INTEGRATIONS_RATE_LIMIT_MAX_REQUESTS - 1);
  });
});
