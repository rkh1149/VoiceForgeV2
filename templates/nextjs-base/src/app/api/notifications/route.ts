import { NextResponse } from "next/server";

/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * Browser code in generated apps calls this same-origin route. This route
 * adds the server-only VoiceForge app token and forwards notification and
 * scheduled-job requests to VoiceForge V2. The token is never sent to the
 * browser.
 */

type NotificationAction =
  | "listNotifications"
  | "markNotificationRead"
  | "getPreferences"
  | "updatePreferences"
  | "sendNotification"
  | "listScheduledJobs"
  | "upsertScheduledJob"
  | "archiveScheduledJob";

type NotificationBody = {
  action?: unknown;
  notificationId?: unknown;
  jobId?: unknown;
  jobKey?: unknown;
  displayName?: unknown;
  templateKey?: unknown;
  channel?: unknown;
  recipientGroup?: unknown;
  title?: unknown;
  message?: unknown;
  recordId?: unknown;
  payload?: unknown;
  intervalMinutes?: unknown;
  active?: unknown;
  unreadOnly?: unknown;
  limit?: unknown;
  emailEnabled?: unknown;
  inAppEnabled?: unknown;
  digestEnabled?: unknown;
  sessionToken?: unknown;
};

type LocalNotification = {
  id: string;
  appId: string;
  recordId: string | null;
  senderUserId: string | null;
  recipientUserId: string | null;
  recipientEmail: string | null;
  channel: "in_app" | "email";
  templateKey: string;
  subject: string;
  body: string;
  payload: unknown;
  status: string;
  provider: string;
  providerMessageId: string | null;
  attempts: number;
  lastError: string | null;
  scheduledFor: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type LocalPreferences = {
  id: string;
  appId: string;
  userId: string;
  emailEnabled: boolean;
  inAppEnabled: boolean;
  digestEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type LocalJob = {
  id: string;
  appId: string;
  jobKey: string;
  displayName: string;
  templateKey: string;
  channel: string;
  recipientGroup: string;
  intervalMinutes: number;
  payload: unknown;
  status: string;
  createdBy: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const ACTIONS = new Set<NotificationAction>([
  "listNotifications",
  "markNotificationRead",
  "getPreferences",
  "updatePreferences",
  "sendNotification",
  "listScheduledJobs",
  "upsertScheduledJob",
  "archiveScheduledJob",
]);

const GENERATED_TEMPLATES = new Set(["app_reminder", "app_update"]);
const CHANNELS = new Set(["in_app", "email", "both"]);
const RECIPIENT_GROUPS = new Set(["owner", "editors", "members", "current_user"]);
const MIN_JOB_INTERVAL_MINUTES = 60;
const MAX_JOB_INTERVAL_MINUTES = 60 * 24 * 30;
const MAX_JOBS = 10;

const globalStore = globalThis as typeof globalThis & {
  __voiceforgeLocalNotifications?: Map<string, LocalNotification>;
  __voiceforgeLocalNotificationPrefs?: Map<string, LocalPreferences>;
  __voiceforgeLocalJobs?: Map<string, LocalJob>;
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as NotificationBody | null;
  if (
    !body ||
    typeof body.action !== "string" ||
    !ACTIONS.has(body.action as NotificationAction)
  ) {
    return NextResponse.json(
      { error: "Invalid notification action." },
      { status: 400 },
    );
  }

  if (process.env.VOICEFORGE_DATA_LOCAL_FALLBACK === "1") {
    return handleLocalNotifications(
      body as NotificationBody & { action: NotificationAction },
    );
  }

  const base = process.env.VOICEFORGE_PUBLIC_URL?.replace(/\/$/, "");
  const token = process.env.VOICEFORGE_APP_TOKEN;
  if (!base || !token) {
    return NextResponse.json(
      { error: "Platform notifications are not enabled for this app." },
      { status: 503 },
    );
  }
  const requireSession = process.env.VOICEFORGE_REQUIRE_SIGN_IN === "1";
  const sharingModel = normalizeSharingModel(process.env.VOICEFORGE_SHARING_MODEL);
  const sessionToken =
    typeof body.sessionToken === "string" ? body.sessionToken : undefined;

  const platformRes = await fetch(`${base}/api/platform-notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      token,
      sessionToken,
      requireSession,
      sharingModel,
    }),
  }).catch(() => null);

  if (!platformRes) {
    return NextResponse.json(
      { error: "Platform notifications are unavailable right now." },
      { status: 502 },
    );
  }

  const text = await platformRes.text();
  return new Response(text, {
    status: platformRes.status,
    headers: {
      "Content-Type":
        platformRes.headers.get("content-type") ?? "application/json",
    },
  });
}

function handleLocalNotifications(
  body: NotificationBody & { action: NotificationAction },
) {
  switch (body.action) {
    case "listNotifications": {
      const unreadOnly = body.unreadOnly === true;
      const limit =
        typeof body.limit === "number" && Number.isFinite(body.limit)
          ? Math.min(Math.max(Math.floor(body.limit), 1), 200)
          : 100;
      const notifications = [...getLocalNotifications().values()]
        .filter(
          (notification) =>
            notification.channel === "in_app" &&
            (!unreadOnly || notification.readAt === null),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
      return NextResponse.json({ notifications });
    }
    case "markNotificationRead": {
      if (typeof body.notificationId !== "string") {
        return localPlatformError(400, "invalid_request", "notificationId required.");
      }
      const notification = getLocalNotifications().get(body.notificationId);
      if (!notification) {
        return localPlatformError(404, "notification_not_found", "Notification not found.");
      }
      const now = new Date().toISOString();
      const updated = { ...notification, readAt: now, updatedAt: now };
      getLocalNotifications().set(updated.id, updated);
      return NextResponse.json({ notification: updated });
    }
    case "getPreferences": {
      return NextResponse.json({ preferences: getLocalPreferences() });
    }
    case "updatePreferences": {
      const now = new Date().toISOString();
      const current = getLocalPreferences();
      const preferences = {
        ...current,
        emailEnabled:
          typeof body.emailEnabled === "boolean"
            ? body.emailEnabled
            : current.emailEnabled,
        inAppEnabled:
          typeof body.inAppEnabled === "boolean"
            ? body.inAppEnabled
            : current.inAppEnabled,
        digestEnabled:
          typeof body.digestEnabled === "boolean"
            ? body.digestEnabled
            : current.digestEnabled,
        updatedAt: now,
      };
      getLocalPreferenceMap().set("local-user", preferences);
      return NextResponse.json({ preferences });
    }
    case "sendNotification": {
      const validation = validateNotificationBody(body);
      if (!validation.ok) {
        return localPlatformError(400, "invalid_notification", validation.error);
      }
      const preferences = getLocalPreferences();
      const channels = channelsForRequest(validation.channel).filter((channel) =>
        channel === "email" ? preferences.emailEnabled : preferences.inAppEnabled,
      );
      const now = new Date().toISOString();
      const created = channels.map((channel) => {
        const notification: LocalNotification = {
          id: crypto.randomUUID(),
          appId: "local",
          recordId: typeof body.recordId === "string" ? body.recordId : null,
          senderUserId: "local-user",
          recipientUserId: "local-user",
          recipientEmail: "local@voiceforge.dev",
          channel,
          templateKey: validation.templateKey,
          subject: `Local app: ${validation.title}`,
          body: validation.message,
          payload: body.payload ?? null,
          status: channel === "email" ? "queued" : "delivered",
          provider: channel === "email" ? "local_outbox" : "in_app",
          providerMessageId: null,
          attempts: channel === "email" ? 0 : 1,
          lastError:
            channel === "email"
              ? "Local fallback records email requests without sending them."
              : null,
          scheduledFor: null,
          deliveredAt: channel === "email" ? null : now,
          readAt: null,
          createdAt: now,
          updatedAt: now,
        };
        getLocalNotifications().set(notification.id, notification);
        return notification;
      });
      return NextResponse.json({ notifications: created }, { status: 201 });
    }
    case "listScheduledJobs": {
      const jobs = [...getLocalJobs().values()].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
      return NextResponse.json({ jobs });
    }
    case "upsertScheduledJob": {
      const validation = validateJobBody(body);
      if (!validation.ok) {
        return localPlatformError(400, "invalid_job", validation.error);
      }
      const jobs = getLocalJobs();
      const existing = [...jobs.values()].find(
        (job) => job.jobKey === validation.jobKey,
      );
      if (!existing && activeLocalJobCount() >= MAX_JOBS) {
        return localPlatformError(
          409,
          "job_quota_exceeded",
          `This app has reached the limit of ${MAX_JOBS} scheduled jobs.`,
        );
      }
      const now = new Date().toISOString();
      const job: LocalJob = {
        id: existing?.id ?? crypto.randomUUID(),
        appId: "local",
        jobKey: validation.jobKey,
        displayName: validation.displayName,
        templateKey: validation.templateKey,
        channel: validation.channel,
        recipientGroup: validation.recipientGroup,
        intervalMinutes: validation.intervalMinutes,
        payload: {
          ...(isPlainObject(body.payload) ? body.payload : {}),
          title: validation.title,
          message: validation.message,
        },
        status: validation.active ? "active" : "paused",
        createdBy: "local-user",
        lastRunAt: existing?.lastRunAt ?? null,
        nextRunAt: validation.active
          ? new Date(Date.now() + validation.intervalMinutes * 60_000).toISOString()
          : null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      jobs.set(job.id, job);
      return NextResponse.json({ job });
    }
    case "archiveScheduledJob": {
      if (typeof body.jobId !== "string") {
        return localPlatformError(400, "invalid_request", "jobId required.");
      }
      const job = getLocalJobs().get(body.jobId);
      if (!job) return localPlatformError(404, "job_not_found", "Scheduled job not found.");
      const now = new Date().toISOString();
      const archived = {
        ...job,
        status: "archived",
        nextRunAt: null,
        updatedAt: now,
      };
      getLocalJobs().set(archived.id, archived);
      return NextResponse.json({ job: archived });
    }
  }
}

function validateNotificationBody(
  body: NotificationBody,
):
  | {
      ok: true;
      templateKey: "app_reminder" | "app_update";
      channel: "in_app" | "email" | "both";
      recipientGroup: "owner" | "editors" | "members" | "current_user";
      title: string;
      message: string;
    }
  | { ok: false; error: string } {
  if (
    typeof body.templateKey !== "string" ||
    !GENERATED_TEMPLATES.has(body.templateKey)
  ) {
    return { ok: false, error: "Approved templateKey required." };
  }
  if (typeof body.channel !== "string" || !CHANNELS.has(body.channel)) {
    return { ok: false, error: "Approved channel required." };
  }
  if (
    typeof body.recipientGroup !== "string" ||
    !RECIPIENT_GROUPS.has(body.recipientGroup)
  ) {
    return { ok: false, error: "Approved recipientGroup required." };
  }
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return { ok: false, error: "title required." };
  }
  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return { ok: false, error: "message required." };
  }
  return {
    ok: true,
    templateKey: body.templateKey as "app_reminder" | "app_update",
    channel: body.channel as "in_app" | "email" | "both",
    recipientGroup: body.recipientGroup as
      | "owner"
      | "editors"
      | "members"
      | "current_user",
    title: body.title.trim().slice(0, 160),
    message: body.message.trim().slice(0, 2000),
  };
}

function validateJobBody(body: NotificationBody):
  | {
      ok: true;
      jobKey: string;
      displayName: string;
      templateKey: "app_reminder" | "app_update";
      channel: "in_app" | "email" | "both";
      recipientGroup: "owner" | "editors" | "members" | "current_user";
      intervalMinutes: number;
      title: string;
      message: string;
      active: boolean;
    }
  | { ok: false; error: string } {
  const notification = validateNotificationBody(body);
  if (!notification.ok) return notification;
  if (typeof body.jobKey !== "string" || body.jobKey.trim().length === 0) {
    return { ok: false, error: "jobKey required." };
  }
  if (typeof body.displayName !== "string" || body.displayName.trim().length === 0) {
    return { ok: false, error: "displayName required." };
  }
  if (
    typeof body.intervalMinutes !== "number" ||
    !Number.isFinite(body.intervalMinutes)
  ) {
    return { ok: false, error: "intervalMinutes required." };
  }
  const intervalMinutes = Math.floor(body.intervalMinutes);
  if (
    intervalMinutes < MIN_JOB_INTERVAL_MINUTES ||
    intervalMinutes > MAX_JOB_INTERVAL_MINUTES
  ) {
    return {
      ok: false,
      error: `Scheduled jobs must run every ${MIN_JOB_INTERVAL_MINUTES} to ${MAX_JOB_INTERVAL_MINUTES} minutes.`,
    };
  }
  return {
    ...notification,
    jobKey: normalizeJobKey(body.jobKey),
    displayName: body.displayName.trim().slice(0, 120),
    intervalMinutes,
    active: body.active !== false,
  };
}

function getLocalNotifications(): Map<string, LocalNotification> {
  globalStore.__voiceforgeLocalNotifications ??= new Map<string, LocalNotification>();
  return globalStore.__voiceforgeLocalNotifications;
}

function getLocalPreferenceMap(): Map<string, LocalPreferences> {
  globalStore.__voiceforgeLocalNotificationPrefs ??= new Map<
    string,
    LocalPreferences
  >();
  return globalStore.__voiceforgeLocalNotificationPrefs;
}

function getLocalPreferences(): LocalPreferences {
  const prefs = getLocalPreferenceMap();
  const existing = prefs.get("local-user");
  if (existing) return existing;
  const now = new Date().toISOString();
  const created: LocalPreferences = {
    id: "local-preferences",
    appId: "local",
    userId: "local-user",
    emailEnabled: true,
    inAppEnabled: true,
    digestEnabled: false,
    createdAt: now,
    updatedAt: now,
  };
  prefs.set("local-user", created);
  return created;
}

function getLocalJobs(): Map<string, LocalJob> {
  globalStore.__voiceforgeLocalJobs ??= new Map<string, LocalJob>();
  return globalStore.__voiceforgeLocalJobs;
}

function activeLocalJobCount(): number {
  return [...getLocalJobs().values()].filter(
    (job) => job.status === "active" || job.status === "paused",
  ).length;
}

function channelsForRequest(channel: "in_app" | "email" | "both") {
  return channel === "both" ? (["in_app", "email"] as const) : [channel];
}

function normalizeJobKey(value: string): string {
  const key = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return key || "job";
}

function normalizeSharingModel(value: string | undefined) {
  if (value === "private" || value === "public") return value;
  return "shared";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localPlatformError(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status });
}
