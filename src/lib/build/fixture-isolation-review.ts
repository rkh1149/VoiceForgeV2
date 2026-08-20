import type {
  AcceptanceManifestJourney,
  VoiceForgeAcceptanceManifest,
} from "./acceptance-manifest";

export type FixtureIsolationReview = {
  version: 1;
  status: "verified" | "needs_repair";
  summary: {
    journeys: number;
    prerequisiteSetups: number;
    runScopedFixtures: number;
    browserLocalSetups: number;
    sharedNamespaces: number;
    parallelSafeJourneys: number;
  };
  warnings: string[];
  blockingIssues: string[];
};

export function analyzeFixtureIsolation(input: {
  manifest: VoiceForgeAcceptanceManifest;
  compiledSource: string;
}): FixtureIsolationReview {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const source = input.compiledSource;

  if (/\btest\.describe\.serial\s*\(/.test(source)) {
    blockingIssues.push(
      "fixture_isolation: Compiled acceptance tests may not depend on serial execution.",
    );
  }
  if (/^(?:export\s+)?(?:let|var)\s+/m.test(source)) {
    blockingIssues.push(
      "fixture_isolation: Compiled acceptance tests may not transfer results through mutable module variables.",
    );
  }
  if (/\blocalStorage\.setItem\s*\(|\/api\/(?:data|files)\b/.test(source)) {
    blockingIssues.push(
      "fixture_isolation: Prerequisite records must be created through visible UI, not direct storage or platform APIs.",
    );
  }

  for (const journey of input.manifest.journeys) {
    reviewJourney(
      journey,
      input.manifest,
      source,
      blockingIssues,
      warnings,
    );
  }

  const summary = {
    journeys: input.manifest.journeys.length,
    prerequisiteSetups: input.manifest.journeys.reduce(
      (total, journey) => total + journey.prerequisites.length,
      0,
    ),
    runScopedFixtures: input.manifest.journeys.reduce(
      (total, journey) =>
        total + journey.fixtures.filter((fixture) => fixture.runScoped).length,
      0,
    ),
    browserLocalSetups: input.manifest.journeys.filter(
      (journey) => journey.isolation.browserLocalPrerequisitesRecreated,
    ).length,
    sharedNamespaces: input.manifest.journeys.filter(
      (journey) => journey.isolation.sharedDataNamespaced,
    ).length,
    parallelSafeJourneys: input.manifest.journeys.filter(
      (journey) => journey.isolation.parallelSafe,
    ).length,
  };
  const uniqueIssues = uniqueStrings(blockingIssues);
  return {
    version: 1,
    status: uniqueIssues.length > 0 ? "needs_repair" : "verified",
    summary,
    warnings: uniqueStrings(warnings),
    blockingIssues: uniqueIssues,
  };
}

function reviewJourney(
  journey: AcceptanceManifestJourney,
  manifest: VoiceForgeAcceptanceManifest,
  source: string,
  issues: string[],
  warnings: string[],
): void {
  const testMarker = `[voiceforge-isolated-journey:${journey.id}]`;
  if (occurrences(source, testMarker) !== 1) {
    issues.push(
      `fixture_isolation: Journey ${journey.id} must compile to exactly one self-contained Playwright test.`,
    );
  }
  const journeyCall = `workflowJourneyTitle(${JSON.stringify(journey.id)}`;
  const journeyIndex = source.indexOf(journeyCall);
  if (journeyIndex < 0) {
    issues.push(
      `fixture_isolation: Journey ${journey.id} has no primary workflow marker.`,
    );
  }
  if (
    !source.includes(
      `acceptanceRunSuffix(testInfo, ${JSON.stringify(
        journey.isolation.fixtureNamespace,
      )})`,
    )
  ) {
    issues.push(
      `fixture_isolation: Journey ${journey.id} does not derive fixtures from its Playwright attempt identity.`,
    );
  }
  if (!source.includes(`acceptanceRetryProbe(testInfo, ${JSON.stringify(journey.id)})`)) {
    issues.push(
      `fixture_isolation: Journey ${journey.id} is missing retry-isolation validation.`,
    );
  }
  if (!source.includes("voiceForgeIsolationHeaders(")) {
    issues.push(
      `fixture_isolation: Journey ${journey.id} does not namespace platform-data requests.`,
    );
  }

  for (const prerequisite of journey.prerequisites) {
    const marker = `workflowFixtureSetupTitle(${JSON.stringify(
      journey.id,
    )}, ${JSON.stringify(prerequisite.journeyId)})`;
    const setupIndex = source.indexOf(marker);
    if (occurrences(source, marker) !== 1 || setupIndex < 0) {
      issues.push(
        `fixture_isolation: Journey ${journey.id} is missing visible setup for ${prerequisite.journeyId}.`,
      );
    } else if (journeyIndex >= 0 && setupIndex > journeyIndex) {
      issues.push(
        `fixture_isolation: Journey ${journey.id} runs ${prerequisite.journeyId} setup after the dependent workflow.`,
      );
    }
    if (prerequisite.setupStrategy !== "visible_ui") {
      issues.push(
        `fixture_isolation: Journey ${journey.id} uses an unsupported prerequisite setup strategy.`,
      );
    }
    const sourceJourney = manifest.journeys.find(
      (candidate) => candidate.id === prerequisite.journeyId,
    );
    if (!sourceJourney) continue;
    const selected = new Set(prerequisite.workflowIds);
    for (const step of sourceJourney.steps) {
      const stepMarker = `workflowFixtureStepTitle(${JSON.stringify(
        journey.id,
      )}, ${JSON.stringify(prerequisite.journeyId)}, ${JSON.stringify(
        step.workflowId,
      )}, ${JSON.stringify(step.contractStepId)}`;
      const expected = selected.has(step.workflowId) ? 1 : 0;
      if (occurrences(source, stepMarker) !== expected) {
        issues.push(
          expected === 1
            ? `fixture_isolation: Journey ${journey.id} does not visibly recreate prerequisite workflow ${step.workflowId}.`
            : `fixture_isolation: Journey ${journey.id} replays unrelated prerequisite workflow ${step.workflowId}.`,
        );
      }
    }
  }

  for (const fixture of journey.fixtures) {
    if (
      fixture.relationEntityKey &&
      (!fixture.relationFixtureId ||
        !journeyFixtureIds(journey).has(fixture.relationFixtureId))
    ) {
      issues.push(
        `fixture_isolation: Relation fixture ${fixture.id} cannot resolve its prerequisite record.`,
      );
    }
    if (
      (fixture.type === "file" || fixture.type === "image") &&
      !fixture.runScoped
    ) {
      issues.push(
        `fixture_isolation: Uploaded fixture ${fixture.id} must use a run-scoped filename.`,
      );
    }
  }

  const parallelMarker = `[voiceforge-parallel]`;
  const testWindow = isolatedTestWindow(source, testMarker);
  if (journey.isolation.parallelSafe && !testWindow.includes(parallelMarker)) {
    issues.push(
      `fixture_isolation: Journey ${journey.id} is parallel-safe but is absent from parallel validation.`,
    );
  }
  if (!journey.isolation.parallelSafe && testWindow.includes(parallelMarker)) {
    issues.push(
      `fixture_isolation: Journey ${journey.id} has unsafe dependencies but is included in parallel validation.`,
    );
  }
  if (!journey.isolation.parallelSafe) {
    warnings.push(
      `fixture_isolation: Journey ${journey.id} will run independently and on retry, but parallel execution is disabled: ${journey.isolation.parallelBlockers.join(", ")}.`,
    );
  }
}

function journeyFixtureIds(journey: AcceptanceManifestJourney): Set<string> {
  return new Set([
    ...journey.fixtures.map((fixture) => fixture.id),
    ...journey.prerequisites.flatMap((prerequisite) => prerequisite.fixtureIds),
  ]);
}

function isolatedTestWindow(source: string, marker: string): string {
  const index = source.indexOf(marker);
  if (index < 0) return "";
  const next = source.indexOf("[voiceforge-isolated-journey:", index + marker.length);
  return source.slice(index, next < 0 ? source.length : next);
}

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
