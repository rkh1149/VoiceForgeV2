import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  getGoogleMapsBrowserConfig,
  resetPlatformIntegrationRateLimitsForTests,
  sanitizeIntegrationPayload,
} from "./integrations";

describe("integration catalogue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("publishes only approved provider/action metadata", () => {
    const providers = listPublicIntegrationProviders();

    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerKey: "demo_directory",
        authType: "none",
        actions: expect.arrayContaining([
          expect.objectContaining({ actionKey: "list_contacts" }),
          expect.objectContaining({ actionKey: "lookup_contact" }),
          expect.objectContaining({ actionKey: "record_contact_note" }),
        ]),
      }),
      expect.objectContaining({
        providerKey: "google_maps",
        authType: "api_key",
        actions: expect.arrayContaining([
          expect.objectContaining({ actionKey: "search_places" }),
          expect.objectContaining({ actionKey: "get_place_details" }),
          expect.objectContaining({ actionKey: "geocode_address" }),
          expect.objectContaining({ actionKey: "compute_route" }),
        ]),
      }),
    ]));
    expect(JSON.stringify(providers)).not.toContain("inputSchema");
    expect(JSON.stringify(providers)).not.toContain("credentialSchema");
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
        name: "Google Maps",
        purpose: "Plan a trip with places and route estimates.",
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

  it("invokes Google Maps place search through the approved server adapter", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Goog-Api-Key")).toBe("test-google-maps-key-12345");
      expect(headers.get("X-Goog-FieldMask")).toContain("places.displayName");
      return new Response(
        JSON.stringify({
          places: [
            {
              id: "ChIJmzrzi9Y0K4gRgXUc3sTY7RU",
              name: "places/ChIJmzrzi9Y0K4gRgXUc3sTY7RU",
              displayName: { text: "CN Tower" },
              formattedAddress: "290 Bremner Blvd, Toronto, ON, Canada",
              location: { latitude: 43.6426, longitude: -79.3871 },
              rating: 4.6,
              userRatingCount: 76000,
              types: ["tourist_attraction"],
              googleMapsUri: "https://maps.google.com/?cid=123",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeCatalogIntegrationAction({
      providerKey: "google_maps",
      actionKey: "search_places",
      input: { textQuery: "CN Tower Toronto", maxResultCount: 3 },
      context: {
        appId: "app_1",
        userId: "user_1",
        credential: {
          id: "credential_1",
          scopes: ["places"],
          secrets: { apiKey: "test-google-maps-key-12345" },
        },
      },
    });

    expect(result).toMatchObject({
      provider: "google_maps",
      places: [
        expect.objectContaining({
          placeId: "ChIJmzrzi9Y0K4gRgXUc3sTY7RU",
          name: "CN Tower",
          location: { latitude: 43.6426, longitude: -79.3871 },
        }),
      ],
    });
  });

  it("uses browser-specific Google Maps config when present", () => {
    vi.stubEnv("VOICEFORGE_GOOGLE_MAPS_API_KEY", "server-maps-key");
    vi.stubEnv("VOICEFORGE_GOOGLE_MAPS_BROWSER_KEY", "browser-maps-key");
    vi.stubEnv("VOICEFORGE_GOOGLE_MAPS_MAP_ID", "voiceforge-map-id");
    vi.stubEnv("VOICEFORGE_GOOGLE_MAPS_LANGUAGE", "en");
    vi.stubEnv("VOICEFORGE_GOOGLE_MAPS_REGION", "CA");

    expect(getGoogleMapsBrowserConfig()).toEqual({
      enabled: true,
      apiKey: "browser-maps-key",
      mapId: "voiceforge-map-id",
      language: "en",
      region: "CA",
      authReferrerPolicy: "origin",
    });
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
