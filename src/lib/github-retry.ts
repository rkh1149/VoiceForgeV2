const GITHUB_RETRY_DELAYS_MS = [750, 1500, 3000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getGitHubErrorStatus(err: unknown): number | undefined {
  return typeof (err as { status?: unknown }).status === "number"
    ? (err as { status: number }).status
    : undefined;
}

function getGitHubErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(err);
}

function getGitHubErrorDetails(err: unknown): string {
  const responseData = (err as { response?: { data?: unknown } } | null)
    ?.response?.data;
  if (!responseData) return getGitHubErrorMessage(err);
  const dataText =
    typeof responseData === "string"
      ? responseData
      : JSON.stringify(responseData);
  return `${getGitHubErrorMessage(err)} ${dataText}`;
}

export function isRetryableGitHubError(err: unknown): boolean {
  const status = getGitHubErrorStatus(err);
  if (status && [408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  if (status === 403) {
    const headers = (err as { response?: { headers?: Record<string, unknown> } })
      .response?.headers;
    const remaining = headers?.["x-ratelimit-remaining"];
    const message = getGitHubErrorDetails(err).toLowerCase();
    return (
      remaining === "0" ||
      remaining === 0 ||
      message.includes("rate limit") ||
      message.includes("abuse detection")
    );
  }

  return /no server is currently available|service unavailable|bad gateway|gateway timeout|fetch failed|network socket disconnected|econnreset|etimedout/i.test(
    getGitHubErrorDetails(err),
  );
}

export async function withGitHubRetry<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  const maxAttempts = GITHUB_RETRY_DELAYS_MS.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !isRetryableGitHubError(err)) {
        throw err;
      }

      const delayMs = GITHUB_RETRY_DELAYS_MS[attempt - 1];
      console.warn(
        `[github] ${label} failed with a transient error; retrying in ${delayMs}ms (${attempt}/${maxAttempts}).`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}
