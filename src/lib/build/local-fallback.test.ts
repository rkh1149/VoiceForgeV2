import { afterEach, describe, expect, it } from "vitest";
import { POST as dataPOST } from "../../../templates/nextjs-base/src/app/api/data/route";
import { POST as filesPOST } from "../../../templates/nextjs-base/src/app/api/files/route";
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
    };
    delete globalStore.__voiceforgeLocalNotifications;
    delete globalStore.__voiceforgeLocalNotificationPrefs;
    delete globalStore.__voiceforgeLocalJobs;
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
});
