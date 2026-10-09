export const BROWSER_FAILURE_EVIDENCE_VERSION = 1 as const;

export type BrowserFailureEvidence = {
  version: typeof BROWSER_FAILURE_EVIDENCE_VERSION;
  testNames: string[];
  sourcePaths: string[];
  urls: string[];
  httpStatuses: number[];
  signals: string[];
  likelySurface: "application_source" | "generated_test" | "external_environment" | "ambiguous";
  confidence: "high" | "medium" | "low";
  reason: string;
};

/** Convert Playwright's text output into evidence before choosing what to edit. */
export function collectBrowserFailureEvidence(output: string): BrowserFailureEvidence {
  const testNames = unique(matches(output, /\[voiceforge-e2e\]\s+Failed\s+(.+?)\s+in\s+\d+/gi));
  const sourcePaths = unique(matches(output, /\b((?:src|e2e)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx))(?::\d+)?/g));
  const urls = unique(matches(output, /https?:\/\/[^\s)'"<>]+/g));
  const httpStatuses = unique(
    matches(output, /\b(?:HTTP\s*|status(?:\s+of)?\s*|responded with\s+)([1-5]\d\d)\b/gi)
      .map(Number)
      .filter(Number.isFinite),
  );
  const signals: string[] = [];
  const hasExternal = httpStatuses.some((status) => [429, 502, 503, 504].includes(status)) ||
    /quota|rate limit|provider unavailable|external service/i.test(output);
  const hasApplicationEvidence =
    /record data failed validation|pageerror|console error|uncaught|failed to fetch|api\/|save failed|upload failed/i.test(output) ||
    httpStatuses.some((status) => status >= 400 && status !== 404);
  const hasNavigationWait = /waitForURL|toHaveURL|navigation timeout/i.test(output);
  const hasPureLocatorEvidence = /strict mode violation|locator resolved to|element is not visible|toBeVisible/i.test(output);
  const generatedOnly = sourcePaths.length > 0 && sourcePaths.every((path) => path.startsWith("e2e/generated/"));

  if (hasExternal) signals.push("external_provider_response");
  if (hasApplicationEvidence) signals.push("application_runtime_error");
  if (hasNavigationWait) signals.push("navigation_or_save_transition");
  if (hasPureLocatorEvidence) signals.push("locator_or_visibility_assertion");
  if (generatedOnly) signals.push("generated_test_path_only");

  if (hasExternal) {
    return result("external_environment", "high", "The browser output includes an external-provider, quota, or transient gateway response.");
  }
  if (hasApplicationEvidence) {
    return result("application_source", "high", "The browser output includes a runtime, API, validation, or save failure from the application.");
  }
  if (hasNavigationWait) {
    return result("ambiguous", "medium", "A navigation/save transition timed out. Inspect the triggering application action and the test expectation together before editing either one.");
  }
  if (hasPureLocatorEvidence && generatedOnly) {
    return result("generated_test", "medium", "The evidence is limited to a generated locator/assertion and names no application runtime failure.");
  }
  return result("ambiguous", "low", "The text output does not prove whether application behavior or the generated journey is responsible.");

  function result(
    likelySurface: BrowserFailureEvidence["likelySurface"],
    confidence: BrowserFailureEvidence["confidence"],
    reason: string,
  ): BrowserFailureEvidence {
    return {
      version: BROWSER_FAILURE_EVIDENCE_VERSION,
      testNames,
      sourcePaths,
      urls,
      httpStatuses,
      signals: unique(signals),
      likelySurface,
      confidence,
      reason,
    };
  }
}

function matches(value: string, pattern: RegExp): string[] {
  return [...value.matchAll(pattern)].map((match) => match[1] ?? match[0]);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
