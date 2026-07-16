import { describe, expect, it } from "vitest";
import { isRetryableGitHubError } from "./github-retry";

describe("GitHub retry classification", () => {
  it("retries transient server and rate-limit failures", () => {
    expect(isRetryableGitHubError({ status: 503 })).toBe(true);
    expect(isRetryableGitHubError({ status: 502 })).toBe(true);
    expect(isRetryableGitHubError({ status: 504 })).toBe(true);
    expect(isRetryableGitHubError({ status: 429 })).toBe(true);
    expect(
      isRetryableGitHubError({
        status: 403,
        message: "API rate limit exceeded",
        response: { headers: { "x-ratelimit-remaining": "0" } },
      }),
    ).toBe(true);
  });

  it("retries GitHub HTML service-unavailable pages", () => {
    expect(
      isRetryableGitHubError({
        status: 503,
        response: { data: "No server is currently available" },
      }),
    ).toBe(true);
  });

  it("does not retry expected control-flow or permission errors", () => {
    expect(isRetryableGitHubError({ status: 404 })).toBe(false);
    expect(isRetryableGitHubError({ status: 422 })).toBe(false);
    expect(isRetryableGitHubError({ status: 403, message: "Forbidden" })).toBe(
      false,
    );
  });
});
