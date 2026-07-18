import { beforeEach, describe, expect, it } from "vitest";
import { PlatformDataError } from "./data";
import {
  consumePlatformNotificationRateLimit,
  normalizeScheduledJobDraft,
  PLATFORM_JOBS_MAX_INTERVAL_MINUTES,
  PLATFORM_JOBS_MIN_INTERVAL_MINUTES,
  PLATFORM_NOTIFICATIONS_RATE_LIMIT_MAX_REQUESTS,
  PLATFORM_NOTIFICATIONS_RATE_LIMIT_WINDOW_MS,
  renderNotificationTemplate,
  resetPlatformNotificationRateLimitsForTests,
} from "./notifications";

describe("platform notification templates", () => {
  it("renders locked app and VoiceForge notification templates", () => {
    expect(
      renderNotificationTemplate({
        appName: "Family Memory Vault",
        templateKey: "app_reminder",
        title: "Weekly story",
        message: "Add one memory this weekend.",
      }),
    ).toEqual({
      subject: "Family Memory Vault: Weekly story",
      body: "Add one memory this weekend.",
    });

    expect(
      renderNotificationTemplate({
        appName: "Chore Board",
        templateKey: "build_preview_ready",
        title: "ignored",
        message: "",
      }).subject,
    ).toBe("VoiceForge preview ready: Chore Board");
  });
});

describe("platform scheduled notification jobs", () => {
  it("normalizes job keys and enforces platform intervals", () => {
    const job = normalizeScheduledJobDraft({
      jobKey: "Weekly Memory Prompt",
      displayName: " Weekly memory prompt ",
      templateKey: "app_reminder",
      channel: "in_app",
      recipientGroup: "owner",
      intervalMinutes: PLATFORM_JOBS_MIN_INTERVAL_MINUTES,
      title: " Add a story ",
      message: " Share one detail from this week. ",
      active: true,
    });

    expect(job.jobKey).toBe("weekly_memory_prompt");
    expect(job.title).toBe("Add a story");

    expect(() =>
      normalizeScheduledJobDraft({
        ...job,
        intervalMinutes: PLATFORM_JOBS_MIN_INTERVAL_MINUTES - 1,
      }),
    ).toThrow(PlatformDataError);

    expect(() =>
      normalizeScheduledJobDraft({
        ...job,
        intervalMinutes: PLATFORM_JOBS_MAX_INTERVAL_MINUTES + 1,
      }),
    ).toThrow(PlatformDataError);
  });
});

describe("platform notification rate limits", () => {
  beforeEach(() => {
    resetPlatformNotificationRateLimitsForTests();
  });

  it("limits bursts and resets after the window", () => {
    const now = Date.now();
    for (let i = 0; i < PLATFORM_NOTIFICATIONS_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      consumePlatformNotificationRateLimit("app:notification", now);
    }

    expect(() =>
      consumePlatformNotificationRateLimit("app:notification", now),
    ).toThrow(PlatformDataError);

    const afterWindow = now + PLATFORM_NOTIFICATIONS_RATE_LIMIT_WINDOW_MS + 1;
    expect(
      consumePlatformNotificationRateLimit("app:notification", afterWindow)
        .remaining,
    ).toBe(PLATFORM_NOTIFICATIONS_RATE_LIMIT_MAX_REQUESTS - 1);
  });
});
