import type { FileMap } from "./template";

export type FailureCase = {
  id: string;
  signature: string;
};

export type FailureFingerprint = {
  version: 1;
  step: string;
  failedTests: string[];
  sourceLocations: string[];
  errorKinds: string[];
  cases: FailureCase[];
  stableKeys: string[];
  summary: string;
};

export type FailureProgressStatus =
  | "resolved"
  | "improved"
  | "unchanged"
  | "changed"
  | "regressed";

export type FailureProgress = {
  status: FailureProgressStatus;
  previousCount: number;
  currentCount: number;
  newFailures: string[];
  resolvedFailures: string[];
  changedFailures: string[];
  summary: string;
};

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SOURCE_LOCATION_PATTERN =
  /\b((?:src|e2e)\/[A-Za-z0-9_./@-]+\.(?:tsx?|jsx?)(?::\d+(?::\d+)?)?)/g;
const ERROR_KIND_PATTERN =
  /\b(AssertionError|TestingLibraryElementError|TypeError|ReferenceError|SyntaxError|RangeError|ZodError|Error TS\d+|Error)(?::|\b)/g;
const VITEST_FAILURE_PATTERN = /^\s*FAIL\s+(.+?)\s*$/;
const PLAYWRIGHT_FAILURE_PATTERN =
  /^\s*\d+\)\s+(?:\[[^\]]+\]\s+[^\w]*)?((?:src|e2e)\/.*?)(?::\d+:\d+)?\s+[>›]\s+(.+?)\s*$/;
const MAX_SIGNATURE_LENGTH = 240;

export function createFailureFingerprint(
  step: string,
  rawOutput: string,
): FailureFingerprint {
  const output = stripAnsi(rawOutput).replaceAll("\r", "");
  const lines = output.split("\n");
  const cases = extractFailureCases(lines);
  const failedTests = uniqueStrings(cases.map((item) => item.id)).sort();
  const sourceLocations = uniqueStrings(
    [...output.matchAll(SOURCE_LOCATION_PATTERN)].map((match) => match[1]),
  ).sort();
  const errorKinds = uniqueStrings(
    [...output.matchAll(ERROR_KIND_PATTERN)].map((match) => match[1]),
  ).sort();
  const stableKeys =
    failedTests.length > 0
      ? failedTests
      : uniqueStrings([
          ...sourceLocations,
          ...errorKinds,
          ...fallbackDiagnosticLines(lines),
        ]).slice(0, 20);
  const count = failedTests.length || stableKeys.length;

  return {
    version: 1,
    step,
    failedTests,
    sourceLocations,
    errorKinds,
    cases,
    stableKeys,
    summary:
      count > 0
        ? `${count} structured failure key(s): ${stableKeys.slice(0, 5).join(" | ")}`
        : "No structured failure keys could be extracted.",
  };
}

export function compareFailureFingerprints(
  previous: FailureFingerprint,
  current: FailureFingerprint,
): FailureProgress {
  const previousKeys = comparisonKeys(previous);
  const currentKeys = comparisonKeys(current);
  const previousSet = new Set(previousKeys);
  const currentSet = new Set(currentKeys);
  const newFailures = currentKeys.filter((key) => !previousSet.has(key));
  const resolvedFailures = previousKeys.filter((key) => !currentSet.has(key));
  const changedFailures = changedCaseSignatures(previous, current);
  const advancedToLaterJourney = isLaterGeneratedJourneyProgress(
    previous,
    newFailures,
    resolvedFailures,
  );

  let status: FailureProgressStatus;
  if (currentKeys.length === 0) {
    status = "resolved";
  } else if (advancedToLaterJourney) {
    status = "improved";
  } else if (newFailures.length > 0 || currentKeys.length > previousKeys.length) {
    status = "regressed";
  } else if (resolvedFailures.length > 0) {
    status = "improved";
  } else if (changedFailures.length > 0) {
    status = "changed";
  } else {
    status = "unchanged";
  }

  return {
    status,
    previousCount: previousKeys.length,
    currentCount: currentKeys.length,
    newFailures,
    resolvedFailures,
    changedFailures,
    summary: progressSummary({
      status,
      previousCount: previousKeys.length,
      currentCount: currentKeys.length,
      newFailures,
      resolvedFailures,
      changedFailures,
    }),
  };
}

export function shouldEscalateDebugScope(ineffectiveRounds: number): boolean {
  return ineffectiveRounds >= 2;
}

export function restoreFileMap(target: FileMap, snapshot: FileMap): string[] {
  const removedPaths = Object.keys(target).filter(
    (path) => snapshot[path] === undefined,
  );
  for (const path of Object.keys(target)) delete target[path];
  Object.assign(target, snapshot);
  return removedPaths;
}

function extractFailureCases(lines: string[]): FailureCase[] {
  const cases: FailureCase[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const vitest = line.match(VITEST_FAILURE_PATTERN);
    if (vitest) {
      cases.push({
        id: normalizeFailureId(vitest[1]),
        signature: findFailureSignature(lines, index + 1),
      });
      continue;
    }
    const playwright = line.match(PLAYWRIGHT_FAILURE_PATTERN);
    if (playwright) {
      cases.push({
        id: normalizeFailureId(`${playwright[1]} > ${playwright[2]}`),
        signature: findFailureSignature(lines, index + 1),
      });
    }
  }
  return deduplicateCases(cases);
}

function findFailureSignature(lines: string[], start: number): string {
  for (let index = start; index < Math.min(lines.length, start + 80); index++) {
    const line = normalizeDiagnosticLine(lines[index]);
    if (!line) continue;
    if (VITEST_FAILURE_PATTERN.test(line)) break;
    if (
      /^(?:AssertionError|TestingLibraryElementError|TypeError|ReferenceError|SyntaxError|RangeError|Error:|expected\b|received\b|unable to find\b|found multiple\b|record data failed validation)/i.test(
        line,
      )
    ) {
      const locator = /^Error: (?:expect\(locator\)|locator\.)/i.test(line)
        ? findPlaywrightLocator(lines, index + 1)
        : "";
      const accessibilityDetail = /accessibility violations/i.test(line)
        ? findAccessibilityDiagnostic(lines, index + 1)
        : "";
      return [line, locator, accessibilityDetail]
        .filter(Boolean)
        .join(" | ")
        .slice(0, MAX_SIGNATURE_LENGTH);
    }
  }
  return "unspecified failure";
}

function findAccessibilityDiagnostic(lines: string[], start: number): string {
  for (let index = start; index < Math.min(lines.length, start + 80); index++) {
    const line = normalizeDiagnosticLine(lines[index]);
    if (
      /(?:color-contrast|target=|contrast ratio|aria-|document-title|heading-order)/i.test(
        line,
      )
    ) {
      return line;
    }
    if (VITEST_FAILURE_PATTERN.test(line) || PLAYWRIGHT_FAILURE_PATTERN.test(line)) {
      break;
    }
  }
  return "";
}

function findPlaywrightLocator(lines: string[], start: number): string {
  for (let index = start; index < Math.min(lines.length, start + 30); index++) {
    const line = normalizeDiagnosticLine(lines[index]);
    if (/^(?:Locator:\s+|-?\s*waiting for\s+)/i.test(line)) return line;
    if (VITEST_FAILURE_PATTERN.test(line) || PLAYWRIGHT_FAILURE_PATTERN.test(line)) {
      break;
    }
  }
  return "";
}

function fallbackDiagnosticLines(lines: string[]): string[] {
  return lines
    .map(normalizeDiagnosticLine)
    .filter(
      (line) =>
        line.length > 0 &&
        /(?:error|failed|failure|cannot|unable|expected|received|timed out|invalid)/i.test(
          line,
        ),
    )
    .slice(-8);
}

function normalizeDiagnosticLine(line: string): string {
  return line
    .replace(/^[\s│└┌─>›❯×✕]+/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\d{4}-\d{2}-\d{2}T\S+/g, "<timestamp>")
    .replace(/\b\d{2,}-[a-z0-9]{4,}\b/gi, "<run-suffix>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>");
}

function normalizeFailureId(value: string): string {
  const normalized = normalizeDiagnosticLine(value)
    .replace(/\s+\(\d+\s+tests?.*\)$/i, "")
    .replace(/\s+\(retry #\d+\)$/i, "")
    .replace(/\s+[>›]\s+/g, " > ");
  const generatedStep = normalized.search(
    /\s>\s\[voiceforge-(?:workflow|step|save|handoff):/i,
  );
  return generatedStep >= 0
    ? normalized.slice(0, generatedStep).trim()
    : normalized;
}

function deduplicateCases(cases: FailureCase[]): FailureCase[] {
  const byId = new Map<string, FailureCase>();
  for (const failureCase of cases) {
    if (!failureCase.id || byId.has(failureCase.id)) continue;
    byId.set(failureCase.id, failureCase);
  }
  return [...byId.values()];
}

function comparisonKeys(fingerprint: FailureFingerprint): string[] {
  return fingerprint.failedTests.length > 0
    ? fingerprint.failedTests
    : fingerprint.stableKeys;
}

function changedCaseSignatures(
  previous: FailureFingerprint,
  current: FailureFingerprint,
): string[] {
  const previousById = new Map(
    previous.cases.map((failureCase) => [failureCase.id, failureCase.signature]),
  );
  return current.cases
    .filter(
      (failureCase) =>
        previousById.has(failureCase.id) &&
        previousById.get(failureCase.id) !== failureCase.signature,
    )
    .map((failureCase) => failureCase.id);
}

function isLaterGeneratedJourneyProgress(
  previous: FailureFingerprint,
  newFailures: readonly string[],
  resolvedFailures: readonly string[],
): boolean {
  if (
    previous.step !== "e2e" ||
    newFailures.length === 0 ||
    resolvedFailures.length === 0 ||
    newFailures.length > resolvedFailures.length
  ) {
    return false;
  }

  const resolvedJourneys = resolvedFailures
    .map(generatedJourneyOrder)
    .filter((value): value is GeneratedJourneyOrder => value !== null);
  const newJourneys = newFailures
    .map(generatedJourneyOrder)
    .filter((value): value is GeneratedJourneyOrder => value !== null);
  if (
    resolvedJourneys.length !== resolvedFailures.length ||
    newJourneys.length !== newFailures.length
  ) {
    return false;
  }

  return newJourneys.every((next) =>
    resolvedJourneys.some(
      (resolved) =>
        resolved.component === next.component &&
        resolved.sequence < next.sequence,
    ),
  );
}

type GeneratedJourneyOrder = {
  component: number;
  sequence: number;
};

function generatedJourneyOrder(value: string): GeneratedJourneyOrder | null {
  const match = value.match(
    /\[voiceforge-journey:journey-(\d+)-(\d+)(?:-|\])/i,
  );
  if (!match) return null;
  return {
    component: Number(match[1]),
    sequence: Number(match[2]),
  };
}

function progressSummary(input: Omit<FailureProgress, "summary">): string {
  const details = [
    `${input.previousCount} -> ${input.currentCount} failure key(s)`,
  ];
  if (input.newFailures.length > 0) {
    details.push(`new: ${input.newFailures.join(" | ")}`);
  }
  if (input.resolvedFailures.length > 0) {
    details.push(`resolved: ${input.resolvedFailures.join(" | ")}`);
  }
  if (input.changedFailures.length > 0) {
    details.push(`changed error: ${input.changedFailures.join(" | ")}`);
  }
  return `${input.status}: ${details.join("; ")}`;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
