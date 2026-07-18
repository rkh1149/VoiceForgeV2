import { and, count, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  appJobRuns,
  appMemberships,
  appNotificationPreferences,
  appNotifications,
  appRecordEvents,
  appRecords,
  appScheduledJobs,
  apps,
  users,
  type AppNotification,
  type AppScheduledJob,
  type User,
} from "../../db/schema";
import {
  assertCanManageAppData,
  assertCanReadAppData,
  assertCanWriteAppData,
  PlatformDataError,
  type JsonObject,
} from "./data";

type Database = ReturnType<typeof getDb>;
type PlatformNotificationUser = Pick<User, "id" | "role">;

export type NotificationChannel = "in_app" | "email" | "both";
export type NotificationTemplateKey =
  | "app_reminder"
  | "app_update"
  | "build_preview_ready"
  | "build_failed";
export type NotificationRecipientGroup =
  | "owner"
  | "editors"
  | "members"
  | "current_user";

export type NotificationDraft = {
  templateKey: NotificationTemplateKey;
  channel: NotificationChannel;
  recipientGroup: NotificationRecipientGroup;
  title: string;
  message: string;
  recordId?: string;
  payload?: JsonObject;
};

export type ScheduledJobDraft = {
  jobKey: string;
  displayName: string;
  templateKey: Extract<NotificationTemplateKey, "app_reminder" | "app_update">;
  channel: NotificationChannel;
  recipientGroup: NotificationRecipientGroup;
  intervalMinutes: number;
  title: string;
  message: string;
  active: boolean;
  payload?: JsonObject;
};

export const PLATFORM_NOTIFICATIONS_MAX_RECIPIENTS_PER_REQUEST = 20;
export const PLATFORM_NOTIFICATIONS_MAX_PER_APP_PER_DAY = 250;
export const PLATFORM_NOTIFICATIONS_RATE_LIMIT_WINDOW_MS = 60_000;
export const PLATFORM_NOTIFICATIONS_RATE_LIMIT_MAX_REQUESTS = 60;
export const PLATFORM_JOBS_MAX_PER_APP = 10;
export const PLATFORM_JOBS_MIN_INTERVAL_MINUTES = 60;
export const PLATFORM_JOBS_MAX_INTERVAL_MINUTES = 60 * 24 * 30;

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export function consumePlatformNotificationRateLimit(
  key: string,
  now = Date.now(),
): { remaining: number; resetAt: number } {
  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + PLATFORM_NOTIFICATIONS_RATE_LIMIT_WINDOW_MS;
    rateLimitBuckets.set(key, { count: 1, resetAt });
    return {
      remaining: PLATFORM_NOTIFICATIONS_RATE_LIMIT_MAX_REQUESTS - 1,
      resetAt,
    };
  }
  if (existing.count >= PLATFORM_NOTIFICATIONS_RATE_LIMIT_MAX_REQUESTS) {
    throw new PlatformDataError(
      429,
      "rate_limited",
      "Too many platform notification requests. Please wait a moment and try again.",
      { resetAt: new Date(existing.resetAt).toISOString() },
    );
  }
  existing.count += 1;
  return {
    remaining: PLATFORM_NOTIFICATIONS_RATE_LIMIT_MAX_REQUESTS - existing.count,
    resetAt: existing.resetAt,
  };
}

export function resetPlatformNotificationRateLimitsForTests(): void {
  rateLimitBuckets.clear();
}

export function normalizeScheduledJobDraft(
  input: ScheduledJobDraft,
): ScheduledJobDraft {
  const jobKey = normalizeJobKey(input.jobKey);
  const intervalMinutes = Math.floor(input.intervalMinutes);
  if (
    intervalMinutes < PLATFORM_JOBS_MIN_INTERVAL_MINUTES ||
    intervalMinutes > PLATFORM_JOBS_MAX_INTERVAL_MINUTES
  ) {
    throw new PlatformDataError(
      400,
      "invalid_job_interval",
      `Scheduled jobs must run every ${PLATFORM_JOBS_MIN_INTERVAL_MINUTES} to ${PLATFORM_JOBS_MAX_INTERVAL_MINUTES} minutes.`,
    );
  }
  return {
    ...input,
    jobKey,
    displayName: truncateClean(input.displayName, 120) || "Scheduled notification",
    title: truncateClean(input.title, 160) || "Reminder",
    message: truncateClean(input.message, 2000),
    intervalMinutes,
  };
}

export function renderNotificationTemplate(input: {
  appName: string;
  templateKey: NotificationTemplateKey;
  title: string;
  message: string;
}): { subject: string; body: string } {
  const title = truncateClean(input.title, 160);
  const message = truncateClean(input.message, 2000);
  switch (input.templateKey) {
    case "app_reminder":
      return {
        subject: `${input.appName}: ${title || "Reminder"}`,
        body: message || "You have a reminder from this app.",
      };
    case "app_update":
      return {
        subject: `${input.appName}: ${title || "Update"}`,
        body: message || "There is an update from this app.",
      };
    case "build_preview_ready":
      return {
        subject: `VoiceForge preview ready: ${input.appName}`,
        body: message || "Your generated app preview is ready to test.",
      };
    case "build_failed":
      return {
        subject: `VoiceForge build failed: ${input.appName}`,
        body: message || "Your generated app build needs attention.",
      };
  }
}

export async function listPlatformNotifications(
  db: Database,
  input: {
    appId: string;
    user: PlatformNotificationUser;
    unreadOnly?: boolean;
    limit?: number;
  },
): Promise<AppNotification[]> {
  await assertCanReadAppData(db, input.appId, input.user);
  const filters = [
    eq(appNotifications.appId, input.appId),
    eq(appNotifications.channel, "in_app"),
    eq(appNotifications.recipientUserId, input.user.id),
  ];
  if (input.unreadOnly) filters.push(isNull(appNotifications.readAt));
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  return db
    .select()
    .from(appNotifications)
    .where(and(...filters))
    .orderBy(desc(appNotifications.createdAt))
    .limit(limit);
}

export async function markPlatformNotificationRead(
  db: Database,
  input: { notificationId: string; user: PlatformNotificationUser },
): Promise<AppNotification> {
  const [notification] = await db
    .select()
    .from(appNotifications)
    .where(eq(appNotifications.id, input.notificationId))
    .limit(1);
  if (!notification || notification.recipientUserId !== input.user.id) {
    throw new PlatformDataError(
      404,
      "notification_not_found",
      "Notification not found.",
    );
  }
  await assertCanReadAppData(db, notification.appId, input.user);
  const [updated] = await db
    .update(appNotifications)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(eq(appNotifications.id, notification.id))
    .returning();
  return updated;
}

export async function getPlatformNotificationPreferences(
  db: Database,
  input: { appId: string; user: PlatformNotificationUser },
) {
  await assertCanReadAppData(db, input.appId, input.user);
  return getOrCreatePreference(db, input.appId, input.user.id);
}

export async function updatePlatformNotificationPreferences(
  db: Database,
  input: {
    appId: string;
    user: PlatformNotificationUser;
    emailEnabled: boolean;
    inAppEnabled: boolean;
    digestEnabled: boolean;
  },
) {
  await assertCanReadAppData(db, input.appId, input.user);
  const [row] = await db
    .insert(appNotificationPreferences)
    .values({
      appId: input.appId,
      userId: input.user.id,
      emailEnabled: input.emailEnabled,
      inAppEnabled: input.inAppEnabled,
      digestEnabled: input.digestEnabled,
    })
    .onConflictDoUpdate({
      target: [
        appNotificationPreferences.appId,
        appNotificationPreferences.userId,
      ],
      set: {
        emailEnabled: input.emailEnabled,
        inAppEnabled: input.inAppEnabled,
        digestEnabled: input.digestEnabled,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function sendPlatformNotification(
  db: Database,
  input: {
    appId: string;
    user: PlatformNotificationUser;
    notification: NotificationDraft;
  },
): Promise<AppNotification[]> {
  await assertCanWriteAppData(db, input.appId, input.user);
  if (input.notification.recordId) {
    await assertRecordBelongsToApp(db, input.appId, input.notification.recordId);
  }
  const [app] = await db
    .select({ id: apps.id, name: apps.name, ownerId: apps.ownerId })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  if (!app) {
    throw new PlatformDataError(404, "app_not_found", "App not found.");
  }

  const recipients = await resolveRecipients(db, {
    appId: app.id,
    ownerId: app.ownerId,
    currentUserId: input.user.id,
    recipientGroup: input.notification.recipientGroup,
  });
  const { subject, body } = renderNotificationTemplate({
    appName: app.name,
    templateKey: input.notification.templateKey,
    title: input.notification.title,
    message: input.notification.message,
  });

  const deliveryTargets: Array<{
    recipient: { id: string; email: string };
    channel: "in_app" | "email";
  }> = [];
  for (const recipient of recipients) {
    const preferences = await getOrCreatePreference(db, app.id, recipient.id);
    const channels = channelsForRequest(input.notification.channel).filter(
      (channel) =>
        channel === "email" ? preferences.emailEnabled : preferences.inAppEnabled,
    );
    for (const channel of channels) {
      deliveryTargets.push({ recipient, channel });
    }
  }
  await assertNotificationQuota(db, app.id, deliveryTargets.length);

  const created: AppNotification[] = [];
  for (const target of deliveryTargets) {
    const notification = await createNotificationRow(db, {
      appId: app.id,
      recordId: input.notification.recordId,
      senderUserId: input.user.id,
      recipientUserId: target.recipient.id,
      recipientEmail: target.recipient.email,
      channel: target.channel,
      templateKey: input.notification.templateKey,
      subject,
      body,
      payload: input.notification.payload,
    });
    created.push(notification);
  }

  await db.insert(appRecordEvents).values({
    appId: app.id,
    recordId: input.notification.recordId,
    userId: input.user.id,
    eventType: "notification_send",
    payload: {
      templateKey: input.notification.templateKey,
      channel: input.notification.channel,
      recipientGroup: input.notification.recipientGroup,
      count: created.length,
    },
  });

  return created;
}

export async function sendVoiceForgeBuildNotification(
  db: Database,
  input: {
    appId: string;
    templateKey: Extract<NotificationTemplateKey, "build_preview_ready" | "build_failed">;
    title: string;
    message: string;
    payload?: JsonObject;
  },
): Promise<AppNotification[]> {
  const [app] = await db
    .select({
      id: apps.id,
      name: apps.name,
      ownerId: apps.ownerId,
      ownerEmail: users.email,
    })
    .from(apps)
    .innerJoin(users, eq(apps.ownerId, users.id))
    .where(eq(apps.id, input.appId))
    .limit(1);
  if (!app) return [];
  const { subject, body } = renderNotificationTemplate({
    appName: app.name,
    templateKey: input.templateKey,
    title: input.title,
    message: input.message,
  });
  return [
    await createNotificationRow(db, {
      appId: app.id,
      senderUserId: app.ownerId,
      recipientUserId: app.ownerId,
      recipientEmail: app.ownerEmail,
      channel: "email",
      templateKey: input.templateKey,
      subject,
      body,
      payload: input.payload,
    }),
    await createNotificationRow(db, {
      appId: app.id,
      senderUserId: app.ownerId,
      recipientUserId: app.ownerId,
      recipientEmail: app.ownerEmail,
      channel: "in_app",
      templateKey: input.templateKey,
      subject,
      body,
      payload: input.payload,
    }),
  ];
}

export async function listPlatformScheduledJobs(
  db: Database,
  input: { appId: string; user: PlatformNotificationUser },
): Promise<AppScheduledJob[]> {
  await assertCanManageAppData(db, input.appId, input.user);
  return db
    .select()
    .from(appScheduledJobs)
    .where(eq(appScheduledJobs.appId, input.appId))
    .orderBy(desc(appScheduledJobs.updatedAt));
}

export async function upsertPlatformScheduledJob(
  db: Database,
  input: {
    appId: string;
    user: PlatformNotificationUser;
    job: ScheduledJobDraft;
  },
): Promise<AppScheduledJob> {
  await assertCanManageAppData(db, input.appId, input.user);
  const job = normalizeScheduledJobDraft(input.job);
  const [existing] = await db
    .select({ id: appScheduledJobs.id })
    .from(appScheduledJobs)
    .where(
      and(
        eq(appScheduledJobs.appId, input.appId),
        eq(appScheduledJobs.jobKey, job.jobKey),
      ),
    )
    .limit(1);
  if (!existing) {
    const [{ used }] = await db
      .select({ used: count() })
      .from(appScheduledJobs)
      .where(
        and(
          eq(appScheduledJobs.appId, input.appId),
          or(eq(appScheduledJobs.status, "active"), eq(appScheduledJobs.status, "paused")),
        ),
      );
    if (used >= PLATFORM_JOBS_MAX_PER_APP) {
      throw new PlatformDataError(
        409,
        "job_quota_exceeded",
        `This app has reached the limit of ${PLATFORM_JOBS_MAX_PER_APP} scheduled jobs.`,
      );
    }
  }

  const payload = {
    ...(job.payload ?? {}),
    title: job.title,
    message: job.message,
  } satisfies JsonObject;
  const nextRunAt = job.active
    ? new Date(Date.now() + job.intervalMinutes * 60_000)
    : null;
  const [row] = await db
    .insert(appScheduledJobs)
    .values({
      appId: input.appId,
      jobKey: job.jobKey,
      displayName: job.displayName,
      templateKey: job.templateKey,
      channel: job.channel,
      recipientGroup: job.recipientGroup,
      intervalMinutes: job.intervalMinutes,
      payload,
      status: job.active ? "active" : "paused",
      createdBy: input.user.id,
      nextRunAt,
    })
    .onConflictDoUpdate({
      target: [appScheduledJobs.appId, appScheduledJobs.jobKey],
      set: {
        displayName: job.displayName,
        templateKey: job.templateKey,
        channel: job.channel,
        recipientGroup: job.recipientGroup,
        intervalMinutes: job.intervalMinutes,
        payload,
        status: job.active ? "active" : "paused",
        nextRunAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function archivePlatformScheduledJob(
  db: Database,
  input: { appId: string; user: PlatformNotificationUser; jobId: string },
): Promise<AppScheduledJob> {
  await assertCanManageAppData(db, input.appId, input.user);
  const [row] = await db
    .update(appScheduledJobs)
    .set({ status: "archived", nextRunAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(appScheduledJobs.id, input.jobId),
        eq(appScheduledJobs.appId, input.appId),
      ),
    )
    .returning();
  if (!row) {
    throw new PlatformDataError(404, "job_not_found", "Scheduled job not found.");
  }
  return row;
}

export async function runDuePlatformScheduledJobs(
  db: Database,
  input: { now?: Date; limit?: number } = {},
): Promise<{ processed: number; failed: number }> {
  const now = input.now ?? new Date();
  const jobs = await db
    .select()
    .from(appScheduledJobs)
    .where(and(eq(appScheduledJobs.status, "active"), lte(appScheduledJobs.nextRunAt, now)))
    .orderBy(appScheduledJobs.nextRunAt)
    .limit(Math.min(input.limit ?? 20, 50));

  let processed = 0;
  let failed = 0;
  for (const job of jobs) {
    const [run] = await db
      .insert(appJobRuns)
      .values({
        appId: job.appId,
        jobId: job.id,
        status: "running",
        payload: job.payload,
      })
      .returning();
    try {
      const [app] = await db
        .select({ ownerId: apps.ownerId })
        .from(apps)
        .where(eq(apps.id, job.appId))
        .limit(1);
      if (!app) throw new Error("App not found.");
      const payload = (job.payload ?? {}) as JsonObject;
      await sendPlatformNotification(db, {
        appId: job.appId,
        user: { id: job.createdBy ?? app.ownerId, role: "user" },
        notification: {
          templateKey:
            job.templateKey === "app_update" ? "app_update" : "app_reminder",
          channel: channelFromString(job.channel),
          recipientGroup: recipientGroupFromString(job.recipientGroup),
          title: stringFromPayload(payload.title) || job.displayName,
          message: stringFromPayload(payload.message),
          payload,
        },
      });
      const nextRunAt = new Date(now.getTime() + job.intervalMinutes * 60_000);
      await db
        .update(appScheduledJobs)
        .set({ lastRunAt: now, nextRunAt, updatedAt: now })
        .where(eq(appScheduledJobs.id, job.id));
      await db
        .update(appJobRuns)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(appJobRuns.id, run.id));
      processed += 1;
    } catch (error) {
      failed += 1;
      await db
        .update(appJobRuns)
        .set({
          status: "failed",
          errorMessage:
            error instanceof Error ? error.message : "Scheduled job failed.",
          finishedAt: new Date(),
        })
        .where(eq(appJobRuns.id, run.id));
    }
  }
  return { processed, failed };
}

async function createNotificationRow(
  db: Database,
  input: {
    appId: string;
    recordId?: string;
    senderUserId?: string;
    recipientUserId?: string;
    recipientEmail?: string;
    channel: "in_app" | "email";
    templateKey: NotificationTemplateKey;
    subject: string;
    body: string;
    payload?: JsonObject;
  },
): Promise<AppNotification> {
  const now = new Date();
  const initial =
    input.channel === "in_app"
      ? { status: "delivered", provider: "in_app", deliveredAt: now }
      : { status: "queued", provider: "outbox", deliveredAt: null };
  const [row] = await db
    .insert(appNotifications)
    .values({
      appId: input.appId,
      recordId: input.recordId,
      senderUserId: input.senderUserId,
      recipientUserId: input.recipientUserId,
      recipientEmail: input.recipientEmail,
      channel: input.channel,
      templateKey: input.templateKey,
      subject: input.subject,
      body: input.body,
      payload: input.payload,
      ...initial,
    })
    .returning();

  if (input.channel !== "email") return row;
  return deliverEmailNotification(db, row);
}

async function deliverEmailNotification(
  db: Database,
  row: AppNotification,
): Promise<AppNotification> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.VOICEFORGE_NOTIFICATION_FROM;
  if (!apiKey || !from || !row.recipientEmail) {
    const [updated] = await db
      .update(appNotifications)
      .set({
        status: "queued",
        provider: "outbox",
        attempts: row.attempts + 1,
        lastError:
          "Email provider is not configured. Set RESEND_API_KEY and VOICEFORGE_NOTIFICATION_FROM.",
        updatedAt: new Date(),
      })
      .where(eq(appNotifications.id, row.id))
      .returning();
    return updated;
  }

  let res: Response | Error;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [row.recipientEmail],
        subject: row.subject,
        text: row.body,
        html: `<p>${escapeHtml(row.body).replace(/\n/g, "<br />")}</p>`,
      }),
    });
  } catch (error) {
    res = error instanceof Error ? error : new Error("Email provider request failed.");
  }

  if (res instanceof Error || !res.ok) {
    const detail =
      res instanceof Error
        ? res.message
        : JSON.stringify(await res.json().catch(() => ({})));
    const [updated] = await db
      .update(appNotifications)
      .set({
        status: "failed",
        provider: "resend",
        attempts: row.attempts + 1,
        lastError: detail.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(appNotifications.id, row.id))
      .returning();
    return updated;
  }

  const payload = (await res.json().catch(() => ({}))) as { id?: string };
  const [updated] = await db
    .update(appNotifications)
    .set({
      status: "delivered",
      provider: "resend",
      providerMessageId: payload.id,
      attempts: row.attempts + 1,
      deliveredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(appNotifications.id, row.id))
    .returning();
  return updated;
}

async function getOrCreatePreference(
  db: Database,
  appId: string,
  userId: string,
) {
  const [existing] = await db
    .select()
    .from(appNotificationPreferences)
    .where(
      and(
        eq(appNotificationPreferences.appId, appId),
        eq(appNotificationPreferences.userId, userId),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(appNotificationPreferences)
    .values({ appId, userId })
    .returning();
  return created;
}

async function resolveRecipients(
  db: Database,
  input: {
    appId: string;
    ownerId: string;
    currentUserId: string;
    recipientGroup: NotificationRecipientGroup;
  },
): Promise<Array<{ id: string; email: string }>> {
  if (input.recipientGroup === "current_user") {
    const [current] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, input.currentUserId))
      .limit(1);
    return current ? [current] : [];
  }

  const membershipRoles: Array<"owner" | "editor" | "viewer"> =
    input.recipientGroup === "editors" ? ["owner", "editor"] : ["owner", "editor", "viewer"];
  const memberRows =
    input.recipientGroup === "owner"
      ? []
      : await db
          .select({ id: users.id, email: users.email })
          .from(appMemberships)
          .innerJoin(users, eq(appMemberships.userId, users.id))
          .where(
            and(
              eq(appMemberships.appId, input.appId),
              inArray(appMemberships.role, membershipRoles),
            ),
          );
  const [owner] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, input.ownerId))
    .limit(1);
  const unique = new Map<string, { id: string; email: string }>();
  if (owner) unique.set(owner.id, owner);
  for (const member of memberRows) unique.set(member.id, member);
  const recipients = [...unique.values()];
  if (recipients.length > PLATFORM_NOTIFICATIONS_MAX_RECIPIENTS_PER_REQUEST) {
    throw new PlatformDataError(
      409,
      "too_many_recipients",
      `Notifications can be sent to at most ${PLATFORM_NOTIFICATIONS_MAX_RECIPIENTS_PER_REQUEST} recipients at a time.`,
    );
  }
  return recipients;
}

async function assertNotificationQuota(
  db: Database,
  appId: string,
  requested: number,
): Promise<void> {
  if (requested <= 0) return;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ used }] = await db
    .select({ used: count() })
    .from(appNotifications)
    .where(
      and(eq(appNotifications.appId, appId), gte(appNotifications.createdAt, since)),
    );
  if (used + requested > PLATFORM_NOTIFICATIONS_MAX_PER_APP_PER_DAY) {
    throw new PlatformDataError(
      409,
      "notification_quota_exceeded",
      `This app has reached the daily limit of ${PLATFORM_NOTIFICATIONS_MAX_PER_APP_PER_DAY} notifications.`,
    );
  }
}

async function assertRecordBelongsToApp(
  db: Database,
  appId: string,
  recordId: string,
): Promise<void> {
  const [record] = await db
    .select({ id: appRecords.id })
    .from(appRecords)
    .where(and(eq(appRecords.id, recordId), eq(appRecords.appId, appId)))
    .limit(1);
  if (!record) {
    throw new PlatformDataError(
      404,
      "record_not_found",
      "Notification record link must belong to this app.",
    );
  }
}

function channelsForRequest(channel: NotificationChannel): Array<"in_app" | "email"> {
  return channel === "both" ? ["in_app", "email"] : [channel];
}

function channelFromString(value: string): NotificationChannel {
  if (value === "email" || value === "both") return value;
  return "in_app";
}

function recipientGroupFromString(value: string): NotificationRecipientGroup {
  if (value === "editors" || value === "members" || value === "current_user") {
    return value;
  }
  return "owner";
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

function truncateClean(value: string, length: number): string {
  return value.trim().replace(/\s+/g, " ").slice(0, length);
}

function stringFromPayload(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
