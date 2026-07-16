import { describe, expect, it } from "vitest";
import { GitHubTransientError, isRetryableGitHubError } from "./github-retry";

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

  it("formats exhausted retries without raw provider HTML", () => {
    const error = new GitHubTransientError(
      "repos.get owner/example",
      {
        status: 503,
        response: {
          data: "<!DOCTYPE html><html><title>Unicorn! GitHub</title></html>",
        },
      },
      4,
    );

    expect(error.message).toContain("GitHub is temporarily unavailable");
    expect(error.message).toContain("HTTP 503");
    expect(error.message).not.toContain("<!DOCTYPE");
    expect(error.message).not.toContain("Unicorn");
  });
});
