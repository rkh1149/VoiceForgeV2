import type { ArchitecturePlan } from "../architecture";
import type { AppSpec } from "../spec";
import type { FileMap } from "./template";
import {
  extractAcceptanceTraceCalls,
  findAcceptanceTraceCall,
  type AcceptanceTraceCall,
  type AcceptanceTraceHelper,
} from "./acceptance-trace-parser";
import {
  synthesizeWorkflowAcceptancePlan,
  validateWorkflowAcceptancePlan,
  type WorkflowAcceptanceJourney,
  type WorkflowAcceptancePlan,
  type WorkflowAcceptanceStep,
} from "./workflow-acceptance-plan";

export type AcceptanceJourneyReview = {
  journeyId: string;
  name: string;
  workflowIds: string[];
  status: "verified" | "needs_repair";
  files: string[];
  stepsRequired: number;
  stepsVerified: number;
  savesRequired: number;
  savesVerified: number;
  refreshChecksRequired: number;
  refreshChecksVerified: number;
  handoffsRequired: number;
  handoffsVerified: number;
  roleScenariosRequired: number;
  roleScenariosVerified: number;
  downloadsRequired: number;
  downloadsVerified: number;
  geolocationRequired: boolean;
  geolocationVerified: boolean;
  blockingIssues: string[];
  warnings: string[];
};

export type AcceptanceTestReview = {
  version: 1;
  plan: WorkflowAcceptancePlan;
  summary: {
    journeysPlanned: number;
    journeysGenerated: number;
    journeysVerified: number;
    workflowsRequired: number;
    workflowsVerified: number;
    stepsRequired: number;
    stepsVerified: number;
    savesRequired: number;
    savesVerified: number;
    refreshChecksRequired: number;
    refreshChecksVerified: number;
    handoffsRequired: number;
    handoffsVerified: number;
    roleScenariosRequired: number;
    roleScenariosVerified: number;
    downloadsRequired: number;
    downloadsVerified: number;
    geolocationJourneysRequired: number;
    geolocationJourneysVerified: number;
    nonBrowserWorkflows: number;
  };
  generatedTestFiles: string[];
  journeys: AcceptanceJourneyReview[];
  warnings: string[];
  blockingIssues: string[];
};

type SourceEntry = {
  path: string;
  source: string;
  traceCalls: AcceptanceTraceCall[];
};

const ASSERTION_PATTERN =
  /\bexpect\s*\([\s\S]{0,700}?\)\s*\.(?:not\.)?(?:toBe|toBeVisible|toBeHidden|toBeEnabled|toBeDisabled|toContainText|toHaveText|toHaveValue|toHaveCount|toHaveAttribute|toHaveURL|toMatch|toEqual|toContain)\s*\(/;
const INTERACTION_PATTERN =
  /\.(?:click|fill|press|selectOption|check|uncheck|setInputFiles|dragTo|dispatchEvent)\s*\(/;
const INPUT_INTERACTION_PATTERN =
  /\.(?:fill|press|selectOption|check|uncheck|setInputFiles)\s*\(/;
const READ_ONLY_ASSERTION_PATTERN =
  /\.not\.(?:toBeVisible|toBeEnabled)\s*\(|\.(?:toBeHidden|toBeDisabled)\s*\(|\.toHaveCount\s*\(\s*0\s*\)/;

export function analyzeGeneratedAcceptanceTests(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  files: FileMap;
}): AcceptanceTestReview {
  const plan = synthesizeWorkflowAcceptancePlan(input.spec, input.architecture);
  const planValidation = validateWorkflowAcceptancePlan(
    input.architecture,
    plan,
  );
  const testEntries = Object.entries(input.files)
    .filter(([path]) => /^e2e\/generated\/.+\.spec\.tsx?$/.test(path))
    .map(([path, source]) => ({
      path,
      source,
      traceCalls: extractAcceptanceTraceCalls(source),
    }));
  const globalBlockingIssues = [
    ...planValidation.blockingIssues,
    ...reviewGlobalTestQuality(testEntries),
  ];
  const journeyReviews = plan.journeys.map((journey) =>
    reviewJourney(journey, testEntries, plan),
  );
  const blockingIssues = uniqueStrings([
    ...globalBlockingIssues,
    ...journeyReviews.flatMap((journey) => journey.blockingIssues),
  ]);
  const warnings = uniqueStrings([
    ...planValidation.warnings,
    ...journeyReviews.flatMap((journey) => journey.warnings),
  ]);

  return {
    version: 1,
    plan,
    summary: {
      journeysPlanned: plan.journeys.length,
      journeysGenerated: journeyReviews.filter((journey) => journey.files.length > 0)
        .length,
      journeysVerified: journeyReviews.filter(
        (journey) => journey.status === "verified",
      ).length,
      workflowsRequired: plan.summary.userActionWorkflows,
      workflowsVerified: uniqueStrings(
        journeyReviews
          .filter((journey) => journey.status === "verified")
          .flatMap((journey) => journey.workflowIds),
      ).length,
      stepsRequired: sum(journeyReviews, "stepsRequired"),
      stepsVerified: sum(journeyReviews, "stepsVerified"),
      savesRequired: sum(journeyReviews, "savesRequired"),
      savesVerified: sum(journeyReviews, "savesVerified"),
      refreshChecksRequired: sum(journeyReviews, "refreshChecksRequired"),
      refreshChecksVerified: sum(journeyReviews, "refreshChecksVerified"),
      handoffsRequired: sum(journeyReviews, "handoffsRequired"),
      handoffsVerified: sum(journeyReviews, "handoffsVerified"),
      roleScenariosRequired: sum(journeyReviews, "roleScenariosRequired"),
      roleScenariosVerified: sum(journeyReviews, "roleScenariosVerified"),
      downloadsRequired: sum(journeyReviews, "downloadsRequired"),
      downloadsVerified: sum(journeyReviews, "downloadsVerified"),
      geolocationJourneysRequired: journeyReviews.filter(
        (journey) => journey.geolocationRequired,
      ).length,
      geolocationJourneysVerified: journeyReviews.filter(
        (journey) => journey.geolocationVerified,
      ).length,
      nonBrowserWorkflows: plan.summary.nonBrowserWorkflows,
    },
    generatedTestFiles: testEntries.map((entry) => entry.path),
    journeys: journeyReviews,
    warnings,
    blockingIssues,
  };
}

function reviewJourney(
  journey: WorkflowAcceptanceJourney,
  allEntries: SourceEntry[],
  plan: WorkflowAcceptancePlan,
): AcceptanceJourneyReview {
  const entries = allEntries.filter((entry) =>
    hasHelperMarker(entry.traceCalls, "workflowJourneyTitle", [journey.id]),
  );
  const issues: string[] = [];
  const warnings: string[] = [];
  const source = entries.map((entry) => entry.source).join("\n");
  const traceCalls = extractAcceptanceTraceCalls(source);
  if (entries.length === 0) {
    issues.push(
      `acceptance_test:journey Missing generated Playwright journey ${journey.id} (${journey.name}).`,
    );
  }
  if (journey.dependsOnJourneyIds.length > 0) {
    const dependencyEntries = journey.dependsOnJourneyIds.flatMap(
      (dependencyId) =>
        allEntries.filter((entry) =>
          hasHelperMarker(entry.traceCalls, "workflowJourneyTitle", [dependencyId]),
        ),
    );
    const sharedFiles = entries.filter((entry) =>
      dependencyEntries.some((dependency) => dependency.path === entry.path),
    );
    if (sharedFiles.length === 0 || !/\btest\.describe\.serial\s*\(/.test(source)) {
      issues.push(
        `acceptance_test:journey Dependent journey ${journey.id} must run after ${journey.dependsOnJourneyIds.join(", ")} in the same test.describe.serial suite.`,
      );
    }

    const browserLocalDependencies = dependentJourneys(plan, journey).filter(
      (dependency) =>
        dependency.saves.some((save) => save.storage === "localStorage") ||
        dependency.handoffs.some(
          (handoff) => handoff.storage === "localStorage",
        ),
    );
    const journeyPrelude = helperMarkerWindow(
      source,
      traceCalls,
      "workflowJourneyTitle",
      [journey.id],
    );
    if (
      browserLocalDependencies.length > 0 &&
      !hasFreshContextPrerequisiteSetup(journeyPrelude)
    ) {
      issues.push(
        `acceptance_test:journey Dependent journey ${journey.id} consumes browser-local records from ${browserLocalDependencies.map((dependency) => dependency.id).join(", ")}, but it does not recreate those prerequisites through visible UI before its first contract step. Playwright gives every test a fresh browser context, so test.describe.serial does not preserve localStorage or sessionStorage.`,
      );
    }
  }
  if (
    source &&
    !containsRouteNavigation(source, journey.startRoute) &&
    !INTERACTION_PATTERN.test(source)
  ) {
    if (hasOpaqueBrowserHelperCall(source)) {
      warnings.push(
        browserArbitrationWarning(
          `Journey ${journey.id} reaches its starting route through an opaque helper that static review cannot inspect`,
        ),
      );
    } else {
      issues.push(
        `acceptance_test:journey Journey ${journey.id} never reaches its starting route ${journey.startRoute} through page navigation or a visible control.`,
      );
    }
  }

  const verifiedSteps = journey.steps.filter((step) => {
    const window = helperMarkerWindow(
      source,
      traceCalls,
      "workflowStepTitle",
      [step.workflowId, step.contractStepId],
    );
    if (!window) {
      issues.push(
        `acceptance_test:step Journey ${journey.id} is missing ${step.workflowId}/${step.contractStepId}: ${step.description}.`,
      );
      return false;
    }
    if (!stepHasRequiredAction(step, window)) {
      if (hasOpaqueBrowserHelperCall(window)) {
        warnings.push(
          browserArbitrationWarning(
            `Journey ${journey.id} delegates ${step.contractStepId} to a helper whose browser action static review cannot prove`,
          ),
        );
        return true;
      }
      issues.push(
        `acceptance_test:step Journey ${journey.id} labels ${step.contractStepId} but does not perform its ${step.kind} action and assertion.`,
      );
      return false;
    }
    if (
      step.accessibleName &&
      !containsLooseText(window, step.accessibleName) &&
      step.controlKind !== "drag_drop"
    ) {
      warnings.push(
        browserArbitrationWarning(
          hasOpaqueBrowserHelperCall(window)
            ? `Journey ${journey.id} uses a helper for ${step.contractStepId}, so static review cannot confirm the contracted accessible name "${step.accessibleName}"`
            : `Journey ${journey.id} performs ${step.contractStepId}, but static review cannot prove that its locator wording is equivalent to the contracted accessible name "${step.accessibleName}"`,
        ),
      );
    }
    return true;
  });

  const verifiedSaves = journey.saves.filter((save) => {
    const window = helperMarkerWindow(
      source,
      traceCalls,
      "workflowSaveTitle",
      [save.id],
    );
    if (!window) {
      issues.push(
        `acceptance_test:save Journey ${journey.id} is missing persistence proof ${save.id}.`,
      );
      return false;
    }
    const refreshed =
      /\bpage\.reload\s*\(/.test(window) ||
      /\bexpectPersistedAfterReload\s*\(/.test(window);
    if (!refreshed || !ASSERTION_PATTERN.test(window)) {
      if (hasOpaqueBrowserHelperCall(window)) {
        warnings.push(
          browserArbitrationWarning(
            `Journey ${journey.id} delegates reload proof ${save.id} to a helper; the running Playwright test must arbitrate persistence`,
          ),
        );
        return true;
      }
      issues.push(
        `acceptance_test:save Journey ${journey.id} does not reload and visibly assert saved ${save.entityKey} data for ${save.id}.`,
      );
      return false;
    }
    const fixture = journey.fixtures.find(
      (candidate) =>
        candidate.entityKey === save.entityKey &&
        typeof candidate.value === "string" &&
        !candidate.value.startsWith("@"),
    );
    if (
      fixture &&
      !source.includes(fixture.value as string) &&
      !hasRunScopedFixture(source)
    ) {
      issues.push(
        `acceptance_test:save Journey ${journey.id} does not use its unique ${save.entityKey} fixture value when proving persistence.`,
      );
      return false;
    }
    return true;
  });

  const verifiedHandoffs = journey.handoffs.filter((handoff) => {
    const window = helperMarkerWindow(
      source,
      traceCalls,
      "workflowHandoffTitle",
      [handoff.id],
    );
    if (!window) {
      issues.push(
        `acceptance_test:handoff Journey ${journey.id} is missing downstream proof ${handoff.id}.`,
      );
      return false;
    }
    const reachesConsumerInMarker =
      containsRouteNavigation(window, handoff.consumerRoute) ||
      (handoff.consumerAccessibleName &&
        containsLooseText(window, handoff.consumerAccessibleName));
    const reachesConsumerEarlierInJourney =
      containsRouteNavigation(source, handoff.consumerRoute) ||
      (handoff.consumerAccessibleName &&
        containsLooseText(source, handoff.consumerAccessibleName));
    const reachesConsumer =
      reachesConsumerInMarker ||
      (/\bpage\.reload\s*\(/.test(window) && reachesConsumerEarlierInJourney);
    if (!reachesConsumer || !ASSERTION_PATTERN.test(window)) {
      if (hasOpaqueBrowserHelperCall(window)) {
        warnings.push(
          browserArbitrationWarning(
            `Journey ${journey.id} delegates downstream proof ${handoff.id} to a helper; the running Playwright test must arbitrate the handoff`,
          ),
        );
        return true;
      }
      issues.push(
        `acceptance_test:handoff Journey ${journey.id} does not reach ${handoff.consumerRoute} and assert the saved result for ${handoff.id}.`,
      );
      return false;
    }
    return true;
  });

  const requiredReadOnlyRoles = uniqueStrings(
    journey.roleScenarios.flatMap((scenario) => scenario.readOnlyRoles),
  );
  const verifiedRoles = requiredReadOnlyRoles.filter((role) => {
    const marker = helperMarkerWindow(
      source,
      traceCalls,
      "voiceForgeRoleHeaders",
      [role],
    );
    if (!marker || !READ_ONLY_ASSERTION_PATTERN.test(marker)) {
      issues.push(
        `acceptance_test:role Journey ${journey.id} does not prove ${role} receives read-only workflow controls.`,
      );
      return false;
    }
    return true;
  });

  let downloadsVerified = 0;
  if (journey.expectedDownloads.length > 0) {
    const downloadEvents = countMatches(
      source,
      /waitForEvent\s*\(\s*["']download["']\s*\)/g,
    );
    const downloadAssertions = countMatches(
      source,
      /expectDownloadedFile\s*\(/g,
    );
    if (
      downloadEvents >= journey.expectedDownloads.length &&
      downloadAssertions >= journey.expectedDownloads.length
    ) {
      downloadsVerified = journey.expectedDownloads.length;
    } else {
      issues.push(
        `acceptance_test:download Journey ${journey.id} promises a download but does not wait for and verify the downloaded file.`,
      );
    }
  }

  const savedFieldKeys = new Set(
    journey.saves.flatMap((save) =>
      save.fieldKeys.map((fieldKey) => `${save.entityKey}:${fieldKey}`),
    ),
  );
  const requiresUpload =
    journey.steps.some((step) => step.controlKind === "file") ||
    journey.fixtures.some(
      (fixture) =>
        (fixture.type === "file" || fixture.type === "image") &&
        savedFieldKeys.has(`${fixture.entityKey}:${fixture.fieldKey}`),
    );
  if (
    requiresUpload &&
    (!/\.setInputFiles\s*\(/.test(source) || !/tinyPngUpload\s*\(/.test(source))
  ) {
    issues.push(
      `acceptance_test:upload Journey ${journey.id} includes a file/image workflow but does not upload a valid test file through the visible input.`,
    );
  }

  const geolocationVerified =
    !journey.requiresGeolocation ||
    (/\bsetGeolocation\s*\(/.test(source) &&
      /\b(?:grantPermissions\s*\(|permissions\s*:\s*\[[^\]]*["']geolocation["'])/.test(
        source,
      ));
  if (!geolocationVerified) {
    issues.push(
      `acceptance_test:geolocation Journey ${journey.id} requires GPS but does not grant geolocation and provide fixed coordinates.`,
    );
  }

  if (entries.length > 1) {
    warnings.push(
      `acceptance_test:journey Journey ${journey.id} is split across ${entries.length} generated files; keep dependent workflow state in one Playwright test unless the setup is deliberately repeated through the UI.`,
    );
  }

  return {
    journeyId: journey.id,
    name: journey.name,
    workflowIds: [...journey.workflowIds],
    status: issues.length > 0 ? "needs_repair" : "verified",
    files: entries.map((entry) => entry.path),
    stepsRequired: journey.steps.length,
    stepsVerified: verifiedSteps.length,
    savesRequired: journey.saves.length,
    savesVerified: verifiedSaves.length,
    refreshChecksRequired: journey.saves.length,
    refreshChecksVerified: verifiedSaves.length,
    handoffsRequired: journey.handoffs.length,
    handoffsVerified: verifiedHandoffs.length,
    roleScenariosRequired: requiredReadOnlyRoles.length,
    roleScenariosVerified: verifiedRoles.length,
    downloadsRequired: journey.expectedDownloads.length,
    downloadsVerified,
    geolocationRequired: journey.requiresGeolocation,
    geolocationVerified,
    blockingIssues: uniqueStrings(issues),
    warnings: uniqueStrings(warnings),
  };
}

function hasRunScopedFixture(source: string): boolean {
  const suffixVariables = [...source.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*acceptanceRunSuffix\s*\(\s*\)/g,
  )].map((match) => match[1]);
  const hasDirectFixture = suffixVariables.some((suffix) => {
    const escaped = escapeRegExp(suffix);
    const fixtureDeclaration = new RegExp(
      `\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*\\$\\{${escaped}\\}`,
    ).exec(source);
    if (!fixtureDeclaration?.[1]) return false;
    const fixtureName = escapeRegExp(fixtureDeclaration[1]);
    return (
      new RegExp(`\\.(?:fill|selectOption)\\s*\\(\\s*${fixtureName}\\s*\\)`).test(
        source,
      ) &&
      new RegExp(
        `\\bexpect\\s*\\([\\s\\S]{0,500}\\b${fixtureName}\\b[\\s\\S]{0,500}\\)\\s*\\.`,
      ).test(source)
    );
  });
  if (hasDirectFixture) return true;

  const factoryDeclarations = [
    ...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g),
  ];
  return factoryDeclarations.some((factory) => {
    const factoryName = factory[1];
    const factoryWindow = source.slice(
      factory.index,
      Math.min(source.length, factory.index + 3_000),
    );
    const factorySuffixes = suffixVariables.filter((suffix) =>
      new RegExp(
        `\\b(?:const|let)\\s+${escapeRegExp(suffix)}\\s*=\\s*acceptanceRunSuffix\\s*\\(\\s*\\)`,
      ).test(factoryWindow),
    );
    if (factorySuffixes.length === 0) return false;

    const runScopedProperties = uniqueStrings(
      factorySuffixes.flatMap((suffix) =>
        [...factoryWindow.matchAll(
          new RegExp(
            "\\b([A-Za-z_$][\\w$]*)\\s*:\\s*`[^`]*\\$\\{" +
              escapeRegExp(suffix) +
              "\\}[^`]*`",
            "g",
          ),
        )].map((match) => match[1]),
      ),
    );
    if (runScopedProperties.length === 0) return false;

    const resultVariables = [
      ...source.matchAll(
        new RegExp(
          `\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(factoryName)}\\s*\\(`,
          "g",
        ),
      ),
    ].map((match) => match[1]);
    return resultVariables.some((resultVariable) =>
      runScopedProperties.some((property) => {
        const reference = `${escapeRegExp(resultVariable)}\\.${escapeRegExp(property)}`;
        const usedAsInput = new RegExp(
          `\\.(?:fill|selectOption)\\s*\\(\\s*${reference}\\b`,
        ).test(source);
        const visiblyAsserted = new RegExp(
          `(?:getByText|toContainText|toHaveText|toHaveValue)\\s*\\(\\s*${reference}\\b`,
        ).test(source);
        return usedAsInput && visiblyAsserted;
      }),
    );
  });
}

function dependentJourneys(
  plan: WorkflowAcceptancePlan,
  journey: WorkflowAcceptanceJourney,
): WorkflowAcceptanceJourney[] {
  const byId = new Map(plan.journeys.map((candidate) => [candidate.id, candidate]));
  const found = new Map<string, WorkflowAcceptanceJourney>();
  const pending = [...journey.dependsOnJourneyIds];
  while (pending.length > 0) {
    const id = pending.shift();
    if (!id || found.has(id)) continue;
    const dependency = byId.get(id);
    if (!dependency) continue;
    found.set(id, dependency);
    pending.push(...dependency.dependsOnJourneyIds);
  }
  return [...found.values()];
}

function hasFreshContextPrerequisiteSetup(source: string): boolean {
  if (!source) return false;
  const directVisibleSetup =
    INPUT_INTERACTION_PATTERN.test(source) && /\.click\s*\(/.test(source);
  const uiSetupHelper =
    /\bawait\s+(?!test\.|expect\b|page\.)[A-Za-z_$][\w$]*\s*\(\s*page\b/.test(
      source,
    );
  return directVisibleSetup || uiSetupHelper;
}

function reviewGlobalTestQuality(entries: SourceEntry[]): string[] {
  const source = entries.map((entry) => entry.source).join("\n");
  const issues: string[] = [];
  if (/\btest\.(?:skip|fixme)\s*\(/.test(source)) {
    issues.push(
      "acceptance_test:quality Generated workflow acceptance tests may not use test.skip or test.fixme.",
    );
  }
  if (/\b(?:page\.)?waitForTimeout\s*\(|\bsetTimeout\s*\(/.test(source)) {
    issues.push(
      "acceptance_test:quality Generated workflow acceptance tests may not use arbitrary timing waits.",
    );
  }
  if (
    /\blocalStorage\.setItem\s*\(/.test(source) ||
    /(?:fetch|request\.(?:get|post|put|delete))\s*\([\s\S]{0,300}\/api\/(?:data|files|integrations|notifications)/.test(
      source,
    )
  ) {
    issues.push(
      "acceptance_test:quality Generated workflow acceptance tests must create and hand off promised records through visible UI controls, not direct storage or platform API setup.",
    );
  }
  return issues;
}

function stepHasRequiredAction(
  step: WorkflowAcceptanceStep,
  sourceWindow: string,
): boolean {
  switch (step.kind) {
    case "navigate":
      return (
        containsRouteNavigation(sourceWindow, step.route) ||
        /\.click\s*\(/.test(sourceWindow)
      );
    case "input":
      return (
        INPUT_INTERACTION_PATTERN.test(sourceWindow) ||
        (step.controlKind !== "textbox" && /\.click\s*\(/.test(sourceWindow))
      );
    case "action":
    case "save":
      return INTERACTION_PATTERN.test(sourceWindow);
    case "result":
    case "automatic":
      return ASSERTION_PATTERN.test(sourceWindow);
  }
}

function hasOpaqueBrowserHelperCall(source: string): boolean {
  return /\bawait\s+(?!test\.|page\.|expect\b)[A-Za-z_$][\w$]*\s*\(/.test(
    source,
  );
}

function browserArbitrationWarning(message: string): string {
  return `acceptance_test:browser_arbitration ${message}. VoiceForge will rely on the actual Playwright result rather than rewrite application code from this uncertain static finding.`;
}

function containsRouteNavigation(source: string, route: string): boolean {
  const escaped = escapeRegExp(route);
  const routeArgument = `["'\`]${escaped}(?:[?#][^"'\`]*)?["'\`]`;
  return (
    new RegExp(`\\bpage\\.(?:goto|waitForURL)\\s*\\(\\s*${routeArgument}`).test(
      source,
    ) ||
    new RegExp(`\\.toHaveURL\\s*\\(\\s*${routeArgument}`).test(source) ||
    new RegExp(
      `\\b(?:href|getAttribute)\\b[\\s\\S]{0,180}${routeArgument}`,
    ).test(source) || containsRouteRegexAssertion(source, route)
  );
}

function containsRouteRegexAssertion(source: string, route: string): boolean {
  const assertions = [
    ...source.matchAll(
      /(?:\.toHaveURL|\bpage\.waitForURL)\s*\(\s*\/((?:\\.|[^/\n])+)\/[dgimsuvy]*/g,
    ),
  ];
  return assertions.some((assertion) => {
    const normalized = assertion[1]
      .replaceAll("\\/", "/")
      .replaceAll("\\-", "-");
    if (route === "/") {
      return normalized.replace(/^\^|\$$/g, "") === "/";
    }
    return normalized.includes(route);
  });
}

function helperMarkerWindow(
  source: string,
  calls: readonly AcceptanceTraceCall[],
  helper: AcceptanceTraceHelper,
  ids: readonly string[],
): string {
  const call = findAcceptanceTraceCall(calls, helper, ids);
  if (!call) return "";
  if (call.scopeStart !== null && call.scopeEnd !== null) {
    return source.slice(call.scopeStart, call.scopeEnd);
  }
  const nextMarkerCandidates = calls
    .filter(
      (candidate) =>
        candidate.index > call.index &&
        (candidate.helper === "workflowStepTitle" ||
          candidate.helper === "workflowSaveTitle" ||
          candidate.helper === "workflowHandoffTitle"),
    )
    .map((candidate) => candidate.index);
  const nextMarker =
    nextMarkerCandidates.length > 0
      ? Math.min(...nextMarkerCandidates)
      : source.length;
  return source.slice(
    call.index,
    Math.min(nextMarker, call.index + 3_500),
  );
}

function hasHelperMarker(
  calls: readonly AcceptanceTraceCall[],
  helper: AcceptanceTraceHelper,
  ids: readonly string[],
): boolean {
  return findAcceptanceTraceCall(calls, helper, ids) !== null;
}

function containsLooseText(source: string, value: string): boolean {
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 2);
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  return words.length === 0 || words.every((word) => normalized.includes(word));
}

function sum(
  journeys: readonly AcceptanceJourneyReview[],
  key:
    | "stepsRequired"
    | "stepsVerified"
    | "savesRequired"
    | "savesVerified"
    | "refreshChecksRequired"
    | "refreshChecksVerified"
    | "handoffsRequired"
    | "handoffsVerified"
    | "roleScenariosRequired"
    | "roleScenariosVerified"
    | "downloadsRequired"
    | "downloadsVerified",
): number {
  return journeys.reduce((total, journey) => total + journey[key], 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}
