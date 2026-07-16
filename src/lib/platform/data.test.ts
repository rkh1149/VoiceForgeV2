import { describe, expect, it, beforeEach } from "vitest";
import {
  PLATFORM_DATA_MAX_RECORD_PAYLOAD_BYTES,
  PLATFORM_DATA_RATE_LIMIT_MAX_REQUESTS,
  PLATFORM_DATA_RATE_LIMIT_WINDOW_MS,
  PlatformDataError,
  canManageAppData,
  canReadAppData,
  canWriteAppData,
  consumePlatformDataRateLimit,
  normalizeEntityDefinition,
  normalizeEntityKey,
  resetPlatformDataRateLimitsForTests,
  validateRecordData,
} from "./data";

const choreEntity = normalizeEntityDefinition({
  name: "Family Chore",
  fields: [
    {
      label: "Title",
      type: "text",
      required: true,
    },
    {
      label: "Done",
      type: "boolean",
      required: false,
    },
    {
      label: "Status",
      type: "select",
      required: true,
      options: ["todo", "doing", "done"],
    },
  ],
});

describe("platform data validation", () => {
  it("normalizes entity and field names into stable keys", () => {
    expect(normalizeEntityKey("Family Chore Board")).toBe("family_chore_board");
    expect(choreEntity.key).toBe("family_chore");
    expect(choreEntity.fields.map((field) => field.key)).toEqual([
      "title",
      "done",
      "status",
    ]);
  });

  it("accepts records that match the entity metadata", () => {
    const result = validateRecordData(choreEntity, {
      title: "Empty dishwasher",
      done: false,
      status: "todo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.title).toBe("Empty dishwasher");
    }
  });

  it("rejects missing, mistyped, unknown, and unsupported values", () => {
    const result = validateRecordData(choreEntity, {
      title: "",
      done: "no",
      status: "blocked",
      surprise: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain("Title is required.");
      expect(result.issues).toContain("Done must be true or false.");
      expect(result.issues).toContain("Status must be one of: todo, doing, done.");
      expect(result.issues).toContain('Unknown field "surprise".');
    }
  });

  it("rejects oversized record payloads", () => {
    const result = validateRecordData(choreEntity, {
      title: "x".repeat(PLATFORM_DATA_MAX_RECORD_PAYLOAD_BYTES),
      done: false,
      status: "todo",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("too large"))).toBe(true);
    }
  });
});

describe("platform data permissions", () => {
  it("enforces owner/editor/viewer capabilities", () => {
    expect(canReadAppData("owner")).toBe(true);
    expect(canWriteAppData("owner")).toBe(true);
    expect(canManageAppData("owner")).toBe(true);

    expect(canReadAppData("editor")).toBe(true);
    expect(canWriteAppData("editor")).toBe(true);
    expect(canManageAppData("editor")).toBe(false);

    expect(canReadAppData("viewer")).toBe(true);
    expect(canWriteAppData("viewer")).toBe(false);
    expect(canManageAppData("viewer")).toBe(false);

    expect(canReadAppData(null)).toBe(false);
  });
});

describe("platform data rate limits", () => {
  beforeEach(() => {
    resetPlatformDataRateLimitsForTests();
  });

  it("limits bursts and resets after the window", () => {
    const now = Date.now();
    for (let i = 0; i < PLATFORM_DATA_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      consumePlatformDataRateLimit("user:app:records", now);
    }

    expect(() =>
      consumePlatformDataRateLimit("user:app:records", now),
    ).toThrow(PlatformDataError);

    const afterWindow = now + PLATFORM_DATA_RATE_LIMIT_WINDOW_MS + 1;
    expect(
      consumePlatformDataRateLimit("user:app:records", afterWindow).remaining,
    ).toBe(PLATFORM_DATA_RATE_LIMIT_MAX_REQUESTS - 1);
  });
});
