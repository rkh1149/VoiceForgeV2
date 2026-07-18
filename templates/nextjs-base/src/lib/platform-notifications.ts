/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * Typed browser client for generated apps that use VoiceForge platform
 * notifications and scheduled notification jobs. It talks only to the
 * same-origin /api/notifications route; app secrets remain on the server.
 */

import { getStoredSessionToken } from "./platform-data";

export type NotificationChannel = "in_app" | "email" | "both";
export type NotificationTemplateKey = "app_reminder" | "app_update";
export type NotificationRecipientGroup =
  | "owner"
  | "editors"
  | "members"
  | "current_user";

export type PlatformNotification = {
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

export type PlatformNotificationPreferences = {
  id: string;
  appId: string;
  userId: string;
  emailEnabled: boolean;
  inAppEnabled: boolean;
  digestEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PlatformScheduledJob = {
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
  createdBy: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SendPlatformNotificationInput = {
  templateKey: NotificationTemplateKey;
  channel: NotificationChannel;
  recipientGroup: NotificationRecipientGroup;
  title: string;
  message: string;
  recordId?: string;
  payload?: Record<string, unknown>;
};

export type UpsertPlatformScheduledJobInput = SendPlatformNotificationInput & {
  jobKey: string;
  displayName: string;
  intervalMinutes: number;
  active?: boolean;
};

type RequestBody =
  | { action: "listNotifications"; unreadOnly?: boolean; limit?: number }
  | { action: "markNotificationRead"; notificationId: string }
  | { action: "getPreferences" }
  | {
      action: "updatePreferences";
      emailEnabled: boolean;
      inAppEnabled: boolean;
      digestEnabled: boolean;
    }
  | ({ action: "sendNotification" } & SendPlatformNotificationInput)
  | { action: "listScheduledJobs" }
  | ({ action: "upsertScheduledJob" } & UpsertPlatformScheduledJobInput)
  | { action: "archiveScheduledJob"; jobId: string };

async function request<TResponse>(body: RequestBody): Promise<TResponse> {
  const res = await fetch("/api/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, sessionToken: getStoredSessionToken() }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & TResponse;
  if (!res.ok) {
    throw new Error(payload.error ?? "Platform notification request failed.");
  }
  return payload;
}

export async function listPlatformNotifications(
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<PlatformNotification[]> {
  const result = await request<{ notifications: PlatformNotification[] }>({
    action: "listNotifications",
    ...options,
  });
  return result.notifications;
}

export async function markPlatformNotificationRead(
  notificationId: string,
): Promise<PlatformNotification> {
  const result = await request<{ notification: PlatformNotification }>({
    action: "markNotificationRead",
    notificationId,
  });
  return result.notification;
}

export async function getPlatformNotificationPreferences(): Promise<PlatformNotificationPreferences> {
  const result = await request<{
    preferences: PlatformNotificationPreferences;
  }>({
    action: "getPreferences",
  });
  return result.preferences;
}

export async function updatePlatformNotificationPreferences(input: {
  emailEnabled: boolean;
  inAppEnabled: boolean;
  digestEnabled: boolean;
}): Promise<PlatformNotificationPreferences> {
  const result = await request<{
    preferences: PlatformNotificationPreferences;
  }>({
    action: "updatePreferences",
    ...input,
  });
  return result.preferences;
}

export async function sendPlatformNotification(
  input: SendPlatformNotificationInput,
): Promise<PlatformNotification[]> {
  const result = await request<{ notifications: PlatformNotification[] }>({
    action: "sendNotification",
    ...input,
  });
  return result.notifications;
}

export async function listPlatformScheduledJobs(): Promise<PlatformScheduledJob[]> {
  const result = await request<{ jobs: PlatformScheduledJob[] }>({
    action: "listScheduledJobs",
  });
  return result.jobs;
}

export async function upsertPlatformScheduledJob(
  input: UpsertPlatformScheduledJobInput,
): Promise<PlatformScheduledJob> {
  const result = await request<{ job: PlatformScheduledJob }>({
    action: "upsertScheduledJob",
    active: true,
    ...input,
  });
  return result.job;
}

export async function archivePlatformScheduledJob(
  jobId: string,
): Promise<PlatformScheduledJob> {
  const result = await request<{ job: PlatformScheduledJob }>({
    action: "archiveScheduledJob",
    jobId,
  });
  return result.job;
}
