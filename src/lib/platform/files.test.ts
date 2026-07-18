import { beforeEach, describe, expect, it } from "vitest";
import { PlatformDataError } from "./data";
import {
  consumePlatformFileRateLimit,
  PLATFORM_FILES_MAX_FILE_BYTES,
  PLATFORM_FILES_RATE_LIMIT_MAX_REQUESTS,
  PLATFORM_FILES_RATE_LIMIT_WINDOW_MS,
  resetPlatformFileRateLimitsForTests,
  validatePlatformFileUpload,
} from "./files";

describe("platform file validation", () => {
  it("normalizes names, content types, and data-url payloads", () => {
    const result = validatePlatformFileUpload({
      fileName: " receipts/July.txt ",
      contentType: "TEXT/PLAIN; charset=utf-8",
      dataBase64: `data:text/plain;base64,${Buffer.from("receipt").toString(
        "base64",
      )}`,
    });

    expect(result.fileName).toBe("receipts-July.txt");
    expect(result.contentType).toBe("text/plain");
    expect(result.sizeBytes).toBe(7);
  });

  it("rejects unsupported file types and invalid payloads", () => {
    expect(() =>
      validatePlatformFileUpload({
        fileName: "script.html",
        contentType: "text/html",
        dataBase64: Buffer.from("<script>").toString("base64"),
      }),
    ).toThrow(PlatformDataError);

    expect(() =>
      validatePlatformFileUpload({
        fileName: "broken.pdf",
        contentType: "application/pdf",
        dataBase64: "not valid!",
      }),
    ).toThrow(PlatformDataError);
  });

  it("rejects oversized uploads", () => {
    expect(() =>
      validatePlatformFileUpload({
        fileName: "large.txt",
        contentType: "text/plain",
        dataBase64: Buffer.alloc(PLATFORM_FILES_MAX_FILE_BYTES + 1).toString(
          "base64",
        ),
      }),
    ).toThrow(PlatformDataError);
  });
});

describe("platform file rate limits", () => {
  beforeEach(() => {
    resetPlatformFileRateLimitsForTests();
  });

  it("limits bursts and resets after the window", () => {
    const now = Date.now();
    for (let i = 0; i < PLATFORM_FILES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      consumePlatformFileRateLimit("app:file", now);
    }

    expect(() => consumePlatformFileRateLimit("app:file", now)).toThrow(
      PlatformDataError,
    );

    const afterWindow = now + PLATFORM_FILES_RATE_LIMIT_WINDOW_MS + 1;
    expect(consumePlatformFileRateLimit("app:file", afterWindow).remaining).toBe(
      PLATFORM_FILES_RATE_LIMIT_MAX_REQUESTS - 1,
    );
  });
});
