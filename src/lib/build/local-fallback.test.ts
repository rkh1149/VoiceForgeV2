import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { POST as dataPOST } from "../../../templates/nextjs-base/src/app/api/data/route";
import { POST as filesPOST } from "../../../templates/nextjs-base/src/app/api/files/route";
import { POST as integrationsPOST } from "../../../templates/nextjs-base/src/app/api/integrations/route";
import { POST as notificationsPOST } from "../../../templates/nextjs-base/src/app/api/notifications/route";

const schema = [
  {
    key: "activity",
    name: "Activity",
    fields: [
      {
        key: "name",
        label: "Activity name",
        type: "text",
        required: true,
        options: [],
      },
      {
        key: "planned_date",
        label: "Planned date",
        type: "date",
        required: false,
        options: [],
      },
      {
        key: "estimated_cost",
        label: "Estimated cost",
        type: "number",
        required: false,
        options: [],
      },
    ],
  },
];

describe("generated app local platform fallback", () => {
  afterEach(() => {
    delete process.env.VOICEFORGE_DATA_LOCAL_FALLBACK;
    delete process.env.VOICEFORGE_PLATFORM_SCHEMA_JSON;
    const globalStore = globalThis as typeof globalThis & {
      __voiceforgeLocalNotifications?: Map<string, unknown>;
      __voiceforgeLocalNotificationPrefs?: Map<string, unknown>;
      __voiceforgeLocalJobs?: Map<string, unknown>;
      __voiceforgeLocalData?: Map<string, unknown>;
      __voiceforgeLocalSavedFilters?: Map<string, unknown>;
    };
    delete globalStore.__voiceforgeLocalData;
    delete globalStore.__voiceforgeLocalNotifications;
    delete globalStore.__voiceforgeLocalNotificationPrefs;
    delete globalStore.__voiceforgeLocalJobs;
    delete globalStore.__voiceforgeLocalSavedFilters;
  });

  it("validates local records against seeded platform schema keys", async () => {
    process.env.VOICEFORGE_DATA_LOCAL_FALLBACK = "1";
    process.env.VOICEFORGE_PLATFORM_SCHEMA_JSON = JSON.stringify(schema);

    const invalid = await dataPOST(
      new Request("http://local.test/api/data", {
        method: "POST",
        body: JSON.stringify({
          action: "createRecord",
          entityKey: "Activity",
          data: {
            name: "Family picnic",
            plannedDate: "2026-07-18",
            estimatedCost: 12,
          },
        }),
      }),
    );

    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      code: "invalid_record",
      details: ['Unknown field "plannedDate".', 'Unknown field "estimatedCost".'],
    });

    const valid = await dataPOST(
      new Request("http://local.test/api/data", {
        method: "POST",
        body: JSON.stringify({
          action: "createRecord",
          entityKey: "Activity",
          data: {
            name: "Family picnic",
            planned_date: "2026-07-18",
            estimated_cost: 12,
          },
        }),
      }),
    );

    expect(valid.status).toBe(201);
  });

  it("supports local file upload, download, and archive for browser tests", async () => {
    process.env.VOICEFORGE_DATA_LOCAL_FALLBACK = "1";

    const upload = await filesPOST(
      new Request("http://local.test/api/files", {
        method: "POST",
        body: JSON.stringify({
          action: "uploadFile",
          fileName: "receipt.txt",
          contentType: "text/plain",
          dataBase64: btoa("field trip receipt"),
        }),
      }),
    );

    expect(upload.status).toBe(201);
    const uploadPayload = (await upload.json()) as {
      file: { id: string; fileName: string; sizeBytes: number };
    };
    expect(uploadPayload.file.fileName).toBe("receipt.txt");
    expect(uploadPayload.file.sizeBytes).toBeGreaterThan(0);

    const download = await filesPOST(
      new Request("http://local.test/api/files", {
        method: "POST",
        body: JSON.stringify({
          action: "downloadFile",
          fileId: uploadPayload.file.id,
        }),
      }),
    );
    expect(download.status).toBe(200);
    await expect(download.json()).resolves.toMatchObject({
      dataBase64: btoa("field trip receipt"),
    });

    const deleted = await filesPOST(
      new Request("http://local.test/api/files", {
        method: "POST",
        body: JSON.stringify({
          action: "deleteFile",
          fileId: uploadPayload.file.id,
        }),
      }),
    );
    expect(deleted.status).toBe(200);
  });

  it("supports local search, saved filters, reports, and CSV exports", async () => {
    process.env.VOICEFORGE_DATA_LOCAL_FALLBACK = "1";
    process.env.VOICEFORGE_PLATFORM_SCHEMA_JSON = JSON.stringify(schema);

    for (const data of [
      {
        name: "Family picnic",
        planned_date: "2026-08-01",
        estimated_cost: 35,
      },
      {
        name: "Museum visit",
        planned_date: "2026-07-24",
        estimated_cost: 50,
      },
    ]) {
      const created = await dataPOST(
        new Request("http://local.test/api/data", {
          method: "POST",
          body: JSON.stringify({
            action: "createRecord",
            entityKey: "activity",
            data,
          }),
        }),
      );
      expect(created.status).toBe(201);
    }

    const search = await dataPOST(
      new Request("http://local.test/api/data", {
        method: "POST",
        body: JSON.stringify({
          action: "searchRecords",
          entityKey: "activity",
          query: {
            query: "picnic",
            fields: ["name"],
            sort: [{ fieldKey: "planned_date", direction: "asc" }],
          },
        }),
      }),
    );
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      total: 1,
      records: [
        {
          data: { name: "Family picnic" },
        },
      ],
    });

    const saved = await dataPOST(
      new Request("http://local.test/api/data", {
        method: "POST",
        body: JSON.stringify({
          action: "saveFilter",
          entityKey: "activity",
          name: "Picnic search",
          definition: { query: "picnic", fields: ["name"] },
        }),
      }),
    );
    expect(saved.status).toBe(201);

    const filters = await dataPOST(
      new Request("http://local.test/api/data", {
        method: "POST",
        body: JSON.stringify({
          action: "listSavedFilters",
          entityKey: "activity",
        }),
      }),
    );
    expect(filters.status).toBe(200);
    await expect(filters.json()).resolves.toMatchObject({
      filters: [
        {
          name: "Picnic search",
          definition: { query: "picnic" },
        },
      ],
    });

    const report = await dataPOST(
      new Request("http://local.test/api/data", {
        method: "POST",
        body: JSON.stringify({
          action: "runReport",
          entityKey: "activity",
          report: {
            metric: "sum",
            metricFieldKey: "estimated_cost",
          },
        }),
      }),
    );
    expect(report.status).toBe(200);
    await expect(report.json()).resolves.toMatchObject({
      report: {
        totalRecords: 2,
        rows: [{ label: "All records", count: 2, sum: 85 }],
      },
    });

    const exported = await dataPOST(
      new Request("http://local.test/api/data", {
        method: "POST",
        body: JSON.stringify({
          action: "exportRecordsCsv",
          entityKey: "activity",
          fileName: "activity-export",
        }),
      }),
    );
    expect(exported.status).toBe(200);
    const payload = (await exported.json()) as {
      export: { fileName: string; csv: string; rowCount: number };
    };
    expect(payload.export.fileName).toBe("activity-export.csv");
    expect(payload.export.csv).toContain("Family picnic");
    expect(payload.export.rowCount).toBe(2);
  });

  it("supports local notification send, inbox, preferences, and scheduled jobs", async () => {
    process.env.VOICEFORGE_DATA_LOCAL_FALLBACK = "1";

    const sent = await notificationsPOST(
      new Request("http://local.test/api/notifications", {
        method: "POST",
        body: JSON.stringify({
          action: "sendNotification",
          templateKey: "app_reminder",
          channel: "both",
          recipientGroup: "current_user",
          title: "Pack lunches",
          message: "Remember lunches before school.",
        }),
      }),
    );

    expect(sent.status).toBe(201);
    const sentPayload = (await sent.json()) as {
      notifications: Array<{ id: string; channel: string; readAt: string | null }>;
    };
    expect(sentPayload.notifications.map((item) => item.channel).sort()).toEqual([
      "email",
      "in_app",
    ]);

    const inbox = await notificationsPOST(
      new Request("http://local.test/api/notifications", {
        method: "POST",
        body: JSON.stringify({ action: "listNotifications", unreadOnly: true }),
      }),
    );
    expect(inbox.status).toBe(200);
    const inboxPayload = (await inbox.json()) as {
      notifications: Array<{ id: string; channel: string; readAt: string | null }>;
    };
    expect(inboxPayload.notifications).toHaveLength(1);

    const read = await notificationsPOST(
      new Request("http://local.test/api/notifications", {
        method: "POST",
        body: JSON.stringify({
          action: "markNotificationRead",
          notificationId: inboxPayload.notifications[0].id,
        }),
      }),
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      notification: { readAt: expect.any(String) },
    });

    const preferences = await notificationsPOST(
      new Request("http://local.test/api/notifications", {
        method: "POST",
        body: JSON.stringify({
          action: "updatePreferences",
          emailEnabled: false,
          inAppEnabled: true,
          digestEnabled: true,
        }),
      }),
    );
    expect(preferences.status).toBe(200);
    await expect(preferences.json()).resolves.toMatchObject({
      preferences: { emailEnabled: false, digestEnabled: true },
    });

    const shortJob = await notificationsPOST(
      new Request("http://local.test/api/notifications", {
        method: "POST",
        body: JSON.stringify({
          action: "upsertScheduledJob",
          jobKey: "too_fast",
          displayName: "Too fast",
          templateKey: "app_reminder",
          channel: "in_app",
          recipientGroup: "owner",
          intervalMinutes: 30,
          title: "Too fast",
          message: "This should fail.",
        }),
      }),
    );
    expect(shortJob.status).toBe(400);

    const job = await notificationsPOST(
      new Request("http://local.test/api/notifications", {
        method: "POST",
        body: JSON.stringify({
          action: "upsertScheduledJob",
          jobKey: "weekly_memory_prompt",
          displayName: "Weekly memory prompt",
          templateKey: "app_reminder",
          channel: "in_app",
          recipientGroup: "owner",
          intervalMinutes: 60 * 24 * 7,
          title: "Add a memory",
          message: "Capture one memory from this week.",
        }),
      }),
    );
    expect(job.status).toBe(200);
    await expect(job.json()).resolves.toMatchObject({
      job: {
        jobKey: "weekly_memory_prompt",
        status: "active",
        intervalMinutes: 60 * 24 * 7,
      },
    });
  });

  it("supports local approved integration catalogue and invocation", async () => {
    process.env.VOICEFORGE_DATA_LOCAL_FALLBACK = "1";

    const providers = await integrationsPOST(
      new Request("http://local.test/api/integrations", {
        method: "POST",
        body: JSON.stringify({ action: "listProviders" }),
      }),
    );

    expect(providers.status).toBe(200);
    await expect(providers.json()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          providerKey: "demo_directory",
        }),
        expect.objectContaining({
          providerKey: "google_maps",
        }),
      ]),
    });

    const browserConfig = await integrationsPOST(
      new Request("http://local.test/api/integrations", {
        method: "POST",
        body: JSON.stringify({ action: "getGoogleMapsBrowserConfig" }),
      }),
    );

    expect(browserConfig.status).toBe(200);
    await expect(browserConfig.json()).resolves.toEqual({
      config: {
        enabled: false,
        apiKey: null,
        mapId: "DEMO_MAP_ID",
        authReferrerPolicy: "origin",
      },
    });

    const contacts = await integrationsPOST(
      new Request("http://local.test/api/integrations", {
        method: "POST",
        body: JSON.stringify({
          action: "invoke",
          providerKey: "demo_directory",
          actionKey: "list_contacts",
          input: { query: "avery" },
        }),
      }),
    );

    expect(contacts.status).toBe(200);
    await expect(contacts.json()).resolves.toMatchObject({
      result: {
        contacts: [
          expect.objectContaining({
            id: "demo-avery",
          }),
        ],
      },
    });

    const route = await integrationsPOST(
      new Request("http://local.test/api/integrations", {
        method: "POST",
        body: JSON.stringify({
          action: "invoke",
          providerKey: "google_maps",
          actionKey: "compute_route",
          input: {
            origin: { placeId: "local-union-station" },
            destination: { placeId: "local-cn-tower" },
            computeAlternativeRoutes: true,
          },
        }),
      }),
    );

    expect(route.status).toBe(200);
    await expect(route.json()).resolves.toMatchObject({
      result: {
        provider: "google_maps",
        route: {
          distanceMeters: expect.any(Number),
          durationSeconds: expect.any(Number),
          travelMode: "DRIVE",
          warnings: [],
          legs: [
            expect.objectContaining({
              startLocation: { latitude: 43.6453, longitude: -79.3806 },
              endLocation: { latitude: 43.6426, longitude: -79.3871 },
            }),
          ],
        },
        routes: [
          expect.objectContaining({ routeLabels: ["DEFAULT_ROUTE"] }),
          expect.objectContaining({ routeLabels: ["DEFAULT_ROUTE_ALTERNATE"] }),
        ],
      },
    });

    const bikeRoute = await integrationsPOST(
      new Request("http://local.test/api/integrations", {
        method: "POST",
        body: JSON.stringify({
          action: "invoke",
          providerKey: "google_maps",
          actionKey: "compute_route",
          input: {
            origin: { placeId: "local-union-station" },
            destination: { placeId: "local-cn-tower" },
            travelMode: "BICYCLE",
          },
        }),
      }),
    );

    expect(bikeRoute.status).toBe(200);
    await expect(bikeRoute.json()).resolves.toMatchObject({
      result: {
        route: {
          travelMode: "BICYCLE",
          safetyNotice: expect.stringContaining("bicycling"),
          warnings: [expect.stringContaining("bicycling")],
        },
      },
    });

    const elevation = await integrationsPOST(
      new Request("http://local.test/api/integrations", {
        method: "POST",
        body: JSON.stringify({
          action: "invoke",
          providerKey: "google_maps",
          actionKey: "get_elevation_profile",
          input: {
            path: [
              { latitude: 43.6453, longitude: -79.3806 },
              { latitude: 43.6426, longitude: -79.3871 },
            ],
            samples: 5,
          },
        }),
      }),
    );

    expect(elevation.status).toBe(200);
    await expect(elevation.json()).resolves.toMatchObject({
      result: {
        provider: "google_maps",
        profile: {
          samples: 5,
          points: expect.arrayContaining([
            expect.objectContaining({
              location: expect.objectContaining({
                latitude: expect.any(Number),
                longitude: expect.any(Number),
              }),
              elevationMeters: expect.any(Number),
            }),
          ]),
          totalClimbMeters: expect.any(Number),
          totalDescentMeters: expect.any(Number),
        },
      },
    });

    const invalidBikeRoute = await integrationsPOST(
      new Request("http://local.test/api/integrations", {
        method: "POST",
        body: JSON.stringify({
          action: "invoke",
          providerKey: "google_maps",
          actionKey: "compute_route",
          input: {
            origin: { placeId: "local-union-station" },
            destination: { placeId: "local-cn-tower" },
            travelMode: "BICYCLE",
            routingPreference: "TRAFFIC_AWARE",
          },
        }),
      }),
    );
    expect(invalidBikeRoute.status).toBe(400);

    const unsupported = await integrationsPOST(
      new Request("http://local.test/api/integrations", {
        method: "POST",
        body: JSON.stringify({
          action: "invoke",
          providerKey: "google_calendar",
          actionKey: "list_events",
        }),
      }),
    );
    expect(unsupported.status).toBe(404);
  });
});

describe("generated app auth template", () => {
  it("keeps the sign-in screen out of the unknown auth loading state", () => {
    const source = readFileSync(
      "templates/nextjs-base/src/components/voiceforge-reusable.tsx",
      "utf8",
    );

    expect(source).toContain("usePlatformSessionState");
    expect(source).toContain("if (isLoading && !session)");
    expect(source).toContain("Checking access");
    expect(source).toContain("cachedPlatformSession");
    expect(source.indexOf("if (isLoading && !session)")).toBeLessThan(
      source.indexOf("VoiceForge sign-in"),
    );
  });
});

describe("generated app Google Maps template", () => {
  it("constructs map bounds from the core/global Maps API instead of the maps library import", () => {
    const source = readFileSync(
      "templates/nextjs-base/src/components/voiceforge-google-map.tsx",
      "utf8",
    );

    expect(source).toContain('importLibrary("core")');
    expect(source).toContain("resolveLatLngBoundsConstructor");
    expect(source).toContain(
      "const bounds = LatLngBounds ? new LatLngBounds() : null;",
    );
    expect(source).not.toContain("new mapsLibrary.LatLngBounds()");
  });
});
