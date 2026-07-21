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
          expect.objectContaining({ actionKey: "get_elevation_profile" }),
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

  it("rejects traffic-aware routing preferences for bicycle routes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      invokeCatalogIntegrationAction({
        providerKey: "google_maps",
        actionKey: "compute_route",
        input: {
          origin: { address: "Toronto" },
          destination: { address: "Montreal" },
          travelMode: "BICYCLE",
          routingPreference: "TRAFFIC_AWARE",
        },
        context: {
          appId: "app_1",
          userId: "user_1",
          credential: {
            id: "credential_1",
            scopes: ["routes"],
            secrets: { apiKey: "test-google-maps-key-12345" },
          },
        },
      }),
    ).rejects.toThrow("routingPreference is supported only for DRIVE or TWO_WHEELER");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds bicycle route safety notices and preserves Google route warnings", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Goog-FieldMask")).toContain("routes.warnings");
      const body = JSON.parse(String(init?.body)) as {
        travelMode?: string;
        routingPreference?: string;
      };
      expect(body.travelMode).toBe("BICYCLE");
      expect(body.routingPreference).toBeUndefined();
      return new Response(
        JSON.stringify({
          routes: [
            {
              distanceMeters: 12000,
              duration: "3600s",
              localizedValues: {
                distance: { text: "12.0 km" },
                duration: { text: "1 hr" },
              },
              polyline: { encodedPolyline: "encoded-bike-polyline" },
              warnings: ["Use caution on unsigned paths."],
              legs: [
                {
                  distanceMeters: 12000,
                  duration: "3600s",
                  localizedValues: {
                    distance: { text: "12.0 km" },
                    duration: { text: "1 hr" },
                  },
                  startLocation: {
                    latLng: { latitude: 43.65, longitude: -79.38 },
                  },
                  endLocation: {
                    latLng: { latitude: 43.7, longitude: -79.42 },
                  },
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeCatalogIntegrationAction({
      providerKey: "google_maps",
      actionKey: "compute_route",
      input: {
        origin: { address: "Union Station Toronto" },
        destination: { address: "High Park Toronto" },
        travelMode: "BICYCLE",
      },
      context: {
        appId: "app_1",
        userId: "user_1",
        credential: {
          id: "credential_1",
          scopes: ["routes"],
          secrets: { apiKey: "test-google-maps-key-12345" },
        },
      },
    });

    expect(result).toMatchObject({
      provider: "google_maps",
      route: {
        travelMode: "BICYCLE",
        safetyNotice: expect.stringContaining("bicycling"),
        warnings: expect.arrayContaining([
          expect.stringContaining("bicycling"),
          "Use caution on unsigned paths.",
        ]),
        legs: [
          expect.objectContaining({
            startLocation: { latitude: 43.65, longitude: -79.38 },
            endLocation: { latitude: 43.7, longitude: -79.42 },
          }),
        ],
      },
    });
  });

  it("supports route alternatives, labels, and step cues from Google Routes", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Goog-FieldMask")).toContain("routes.routeLabels");
      expect(headers.get("X-Goog-FieldMask")).toContain("routes.legs.steps");
      const body = JSON.parse(String(init?.body)) as {
        computeAlternativeRoutes?: boolean;
        polylineQuality?: string;
        travelMode?: string;
      };
      expect(body.computeAlternativeRoutes).toBe(true);
      expect(body.polylineQuality).toBe("HIGH_QUALITY");
      expect(body.travelMode).toBe("BICYCLE");
      return new Response(
        JSON.stringify({
          routes: [
            {
              routeLabels: ["DEFAULT_ROUTE"],
              description: "Waterfront Trail",
              distanceMeters: 18000,
              duration: "5400s",
              localizedValues: {
                distance: { text: "18.0 km" },
                duration: { text: "1 hr 30 min" },
              },
              polyline: { encodedPolyline: "primary-bike-polyline" },
              legs: [
                {
                  distanceMeters: 18000,
                  duration: "5400s",
                  localizedValues: {
                    distance: { text: "18.0 km" },
                    duration: { text: "1 hr 30 min" },
                  },
                  startLocation: {
                    latLng: { latitude: 43.64, longitude: -79.38 },
                  },
                  endLocation: {
                    latLng: { latitude: 43.66, longitude: -79.45 },
                  },
                  steps: [
                    {
                      distanceMeters: 1200,
                      staticDuration: "360s",
                      localizedValues: {
                        distance: { text: "1.2 km" },
                        staticDuration: { text: "6 min" },
                      },
                      startLocation: {
                        latLng: { latitude: 43.64, longitude: -79.38 },
                      },
                      endLocation: {
                        latLng: { latitude: 43.65, longitude: -79.39 },
                      },
                      polyline: { encodedPolyline: "step-polyline" },
                      navigationInstruction: {
                        maneuver: "TURN_RIGHT",
                        instructions: "Turn right onto the trail.",
                      },
                      travelMode: "BICYCLE",
                    },
                  ],
                },
              ],
            },
            {
              routeLabels: ["DEFAULT_ROUTE_ALTERNATE"],
              description: "Park path alternate",
              distanceMeters: 19400,
              duration: "6000s",
              localizedValues: {
                distance: { text: "19.4 km" },
                duration: { text: "1 hr 40 min" },
              },
              polyline: { encodedPolyline: "alternate-bike-polyline" },
              legs: [],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeCatalogIntegrationAction({
      providerKey: "google_maps",
      actionKey: "compute_route",
      input: {
        origin: { placeId: "origin-place" },
        destination: { placeId: "destination-place" },
        travelMode: "BICYCLE",
        computeAlternativeRoutes: true,
        polylineQuality: "HIGH_QUALITY",
      },
      context: {
        appId: "app_1",
        userId: "user_1",
        credential: {
          id: "credential_1",
          scopes: ["routes"],
          secrets: { apiKey: "test-google-maps-key-12345" },
        },
      },
    });

    expect(result).toMatchObject({
      provider: "google_maps",
      route: {
        routeLabels: ["DEFAULT_ROUTE"],
        description: "Waterfront Trail",
        encodedPolyline: "primary-bike-polyline",
        legs: [
          {
            steps: [
              {
                instruction: "Turn right onto the trail.",
                maneuver: "TURN_RIGHT",
                travelMode: "BICYCLE",
              },
            ],
          },
        ],
      },
      routes: [
        expect.objectContaining({ routeLabels: ["DEFAULT_ROUTE"] }),
        expect.objectContaining({ routeLabels: ["DEFAULT_ROUTE_ALTERNATE"] }),
      ],
    });
  });

  it("passes via waypoints and rejects optimizing their order", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        intermediates?: Array<{ via?: boolean; placeId?: string }>;
      };
      expect(body.intermediates).toEqual([
        { placeId: "trailhead-place", via: true },
      ]);
      return new Response(
        JSON.stringify({
          routes: [
            {
              routeLabels: ["DEFAULT_ROUTE"],
              distanceMeters: 7000,
              duration: "1800s",
              localizedValues: {
                distance: { text: "7.0 km" },
                duration: { text: "30 min" },
              },
              legs: [],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeCatalogIntegrationAction({
      providerKey: "google_maps",
      actionKey: "compute_route",
      input: {
        origin: { placeId: "origin-place" },
        destination: { placeId: "destination-place" },
        intermediates: [{ placeId: "trailhead-place", via: true }],
        travelMode: "BICYCLE",
        computeAlternativeRoutes: true,
      },
      context: {
        appId: "app_1",
        userId: "user_1",
        credential: {
          id: "credential_1",
          scopes: ["routes"],
          secrets: { apiKey: "test-google-maps-key-12345" },
        },
      },
    });

    expect(result).toMatchObject({
      routeNotice: expect.stringContaining("intermediate waypoints"),
    });

    await expect(
      invokeCatalogIntegrationAction({
        providerKey: "google_maps",
        actionKey: "compute_route",
        input: {
          origin: { placeId: "origin-place" },
          destination: { placeId: "destination-place" },
          intermediates: [{ placeId: "trailhead-place", via: true }],
          optimizeWaypointOrder: true,
        },
        context: {
          appId: "app_1",
          userId: "user_1",
          credential: {
            id: "credential_1",
            scopes: ["routes"],
            secrets: { apiKey: "test-google-maps-key-12345" },
          },
        },
      }),
    ).rejects.toThrow("optimizeWaypointOrder cannot be combined");
  });

  it("samples Google elevation profiles for bike routes", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.pathname).toBe("/maps/api/elevation/json");
      expect(requestUrl.searchParams.get("path")).toBe("enc:encoded-bike-polyline");
      expect(requestUrl.searchParams.get("samples")).toBe("4");
      expect(requestUrl.searchParams.get("key")).toBe("test-google-maps-key-12345");
      return new Response(
        JSON.stringify({
          status: "OK",
          results: [
            {
              elevation: 100,
              location: { lat: 43.64, lng: -79.38 },
              resolution: 30,
            },
            {
              elevation: 125.4,
              location: { lat: 43.65, lng: -79.39 },
              resolution: 30,
            },
            {
              elevation: 118.1,
              location: { lat: 43.66, lng: -79.4 },
              resolution: 30,
            },
            {
              elevation: 140.1,
              location: { lat: 43.67, lng: -79.41 },
              resolution: 30,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeCatalogIntegrationAction({
      providerKey: "google_maps",
      actionKey: "get_elevation_profile",
      input: { encodedPolyline: "encoded-bike-polyline", samples: 4 },
      context: {
        appId: "app_1",
        userId: "user_1",
        credential: {
          id: "credential_1",
          scopes: ["elevation"],
          secrets: { apiKey: "test-google-maps-key-12345" },
        },
      },
    });

    expect(result).toMatchObject({
      provider: "google_maps",
      profile: {
        samples: 4,
        minElevationMeters: 100,
        maxElevationMeters: 140.1,
        totalClimbMeters: 47.4,
        totalDescentMeters: 7.3,
      },
    });
    const profile = result.profile as {
      points: Array<{ location: { latitude: number; longitude: number }; elevationMeters: number }>;
    };
    expect(profile.points).toEqual(
      expect.arrayContaining([
        {
          location: { latitude: 43.64, longitude: -79.38 },
          elevationMeters: 100,
          resolutionMeters: 30,
        },
      ]),
    );
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

  it("does not expose the server-only Google Maps key as browser config", () => {
    vi.stubEnv("VOICEFORGE_GOOGLE_MAPS_API_KEY", "server-maps-key");

    expect(getGoogleMapsBrowserConfig()).toEqual({
      enabled: false,
      apiKey: null,
      mapId: "DEMO_MAP_ID",
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
