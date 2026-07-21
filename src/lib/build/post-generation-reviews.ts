import type { ArchitecturePlan } from "../architecture";
import type { AppSpec } from "../spec";
import {
  artifactStatusFromIssues,
  type BuildAgentArtifactStatus,
} from "./agent-artifact-utils";
import type { FileMap } from "./template";

export type PostGenerationReviewAgentKey =
  | "code_reviewer"
  | "test_reviewer"
  | "security_reviewer"
  | "ux_accessibility_reviewer";

export type PostGenerationReview = {
  agentKey: PostGenerationReviewAgentKey;
  phaseKey: string;
  artifactType: "review_gate";
  status: BuildAgentArtifactStatus;
  summary: string;
  warnings: string[];
  blockingIssues: string[];
  payload: Record<string, unknown>;
};

export type PostGenerationReviewInput = {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  allFiles: FileMap;
  changedFiles: FileMap;
  changedFilePaths: string[];
  deletedFilePaths: string[];
  changeMode: boolean;
};

const PROTECTED_TEMPLATE_FILES = new Set([
  "src/app/globals.css",
  "src/lib/template.test.ts",
  "src/lib/platform-data.ts",
  "src/lib/platform-files.ts",
  "src/lib/platform-notifications.ts",
  "src/lib/platform-integrations.ts",
  "src/lib/voiceforge-modules.ts",
  "src/components/voiceforge-reusable.tsx",
  "src/app/api/ai/route.ts",
  "src/app/api/data/route.ts",
  "src/app/api/files/route.ts",
  "src/app/api/notifications/route.ts",
  "src/app/api/integrations/route.ts",
  "e2e/smoke.spec.ts",
]);

const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const EXTERNAL_URL_PATTERN = /https?:\/\/[^\s"'`<>)]+/g;
const CREDENTIAL_PATTERN =
  /\b(process\.env|OPENAI_API_KEY|GITHUB_TOKEN|VERCEL_TOKEN|DATABASE_URL|VOICEFORGE_APP_TOKEN|VOICEFORGE_PUBLIC_URL|VOICEFORGE_PLATFORM_SESSION_SECRET|RESEND_API_KEY|GOOGLE_MAPS_API_KEY)\b/;
const DANGEROUS_CODE_PATTERN =
  /\b(eval\s*\(|new Function\s*\(|dangerouslySetInnerHTML\b)/;
const DIRECT_SERVICE_IMPORT_PATTERN =
  /from\s+["'](@neondatabase\/serverless|@octokit\/rest|openai|resend|nodemailer|googleapis)["']/;
const FORM_CONTROL_PATTERN = /<(input|select|textarea)\b(?![^>]*type=["']hidden["'])/gi;
const ACCESSIBLE_NAME_PATTERN = /(<label\b|htmlFor=|aria-label=|aria-labelledby=)/i;
const IMAGE_WITHOUT_ALT_PATTERN = /<img\b(?![^>]*\balt=)/i;
const H1_PATTERN = /<h1(\s|>)/i;

export function runPostGenerationReviews(
  input: PostGenerationReviewInput,
): PostGenerationReview[] {
  return [
    reviewGeneratedCode(input),
    reviewGeneratedTests(input),
    reviewSecurity(input),
    reviewUxAccessibility(input),
  ];
}

export function getPostGenerationBlockingIssues(
  reviews: readonly PostGenerationReview[],
): string[] {
  return uniqueStrings(reviews.flatMap((review) => review.blockingIssues));
}

function reviewGeneratedCode(
  input: PostGenerationReviewInput,
): PostGenerationReview {
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const appSource = sourceEntries(input.allFiles);
  const changedSource = sourceEntries(input.changedFiles);
  const pageFiles = appSource
    .map(([path]) => path)
    .filter((path) => isAppRouterPage(path));
  const changedPages = changedSource
    .map(([path]) => path)
    .filter((path) => isAppRouterPage(path));
  const expectedPageFiles = expectedPagesFromArchitecture(input.architecture);
  const missingPageFiles = expectedPageFiles.filter(
    (path) => !Object.prototype.hasOwnProperty.call(input.allFiles, path),
  );

  if (!input.changeMode && changedPages.length === 0) {
    blockingIssues.push(
      "code_review: New app generation did not create or update any App Router page.",
    );
  }

  if (missingPageFiles.length > 0) {
    warnings.push(
      `code_review: Architecture planned route files that were not generated: ${missingPageFiles.join(", ")}.`,
    );
  }

  const combinedSource = combine(appSource);
  if (requiresPlatformData(input.architecture) && !usesAny(combinedSource, [
    "platform-data",
    "listPlatformRecords",
    "createPlatformRecord",
    "updatePlatformRecord",
  ])) {
    blockingIssues.push(
      "code_review: Shared/platform-data app did not use the locked platform-data client.",
    );
  }

  if (requiresGeneratedAppSession(input.spec, input.architecture) && !usesAny(
    combinedSource,
    [
      "usePlatformSessionState",
      "PlatformSignInGate",
      "getPlatformSession",
      "signInToPlatform",
    ],
  )) {
    blockingIssues.push(
      "code_review: Sign-in or role-aware app did not wire the locked platform session flow.",
    );
  }

  if (requiresService(input.architecture, "files") && !usesAny(combinedSource, [
    "platform-files",
    "PlatformFileUploadInput",
    "uploadPlatformFile",
    "listPlatformFiles",
  ])) {
    blockingIssues.push(
      "code_review: File-enabled app did not use the locked platform-files client.",
    );
  }

  if (
    (requiresService(input.architecture, "email") ||
      requiresService(input.architecture, "jobs")) &&
    !usesAny(combinedSource, [
      "platform-notifications",
      "sendPlatformNotification",
      "upsertPlatformScheduledJob",
    ])
  ) {
    blockingIssues.push(
      "code_review: Notification/reminder app did not use the locked platform-notifications client.",
    );
  }

  if (requiresService(input.architecture, "integrations") && !usesAny(
    combinedSource,
    [
      "platform-integrations",
      "listPlatformIntegrationProviders",
      "invokePlatformIntegration",
    ],
  )) {
    blockingIssues.push(
      "code_review: Integration-enabled app did not use the locked platform-integrations client.",
    );
  }

  if (
    (requiresService(input.architecture, "search") ||
      requiresService(input.architecture, "reports")) &&
    !usesAny(combinedSource, [
      "searchPlatformRecords",
      "listPlatformSavedFilters",
      "runPlatformRecordReport",
      "exportPlatformRecordsCsv",
    ])
  ) {
    warnings.push(
      "code_review: Search/report app did not use the Stage 12B platform search/report helpers.",
    );
  }

  if (requiresPlatformData(input.architecture) && /\blocalStorage\b/.test(combinedSource)) {
    warnings.push(
      "code_review: Platform-data app still references localStorage; verify it is only for harmless UI preferences.",
    );
  }

  return reviewResult({
    agentKey: "code_reviewer",
    phaseKey: "generated-code-review",
    summary: summarizeReview(
      "Generated code review",
      warnings,
      blockingIssues,
    ),
    warnings,
    blockingIssues,
    payload: {
      changedFileCount: input.changedFilePaths.length,
      deletedFileCount: input.deletedFilePaths.length,
      pageFiles,
      expectedPageFiles,
      missingPageFiles,
      requiredServices: requiredServices(input.architecture),
    },
  });
}

function reviewGeneratedTests(
  input: PostGenerationReviewInput,
): PostGenerationReview {
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const unitTestFiles = Object.keys(input.allFiles).filter(
    (path) =>
      path.startsWith("src/") &&
      isTestFile(path) &&
      !PROTECTED_TEMPLATE_FILES.has(path),
  );
  const browserTestFiles = Object.keys(input.allFiles).filter((path) =>
    /^e2e\/generated\/.+\.spec\.tsx?$/.test(path),
  );
  const testText = combine(
    [...unitTestFiles, ...browserTestFiles].map((path) => [
      path,
      input.allFiles[path],
    ]),
  );

  if (unitTestFiles.length === 0) {
    warnings.push(
      "tests_review: No generated unit/workflow tests were found under src/.",
    );
  }

  if (
    input.architecture.acceptanceTests.length > 0 &&
    browserTestFiles.length === 0
  ) {
    warnings.push(
      "tests_review: Architecture includes browser-level acceptance scenarios but no e2e/generated tests were added.",
    );
  }

  const unstableTestSignals = [
    "waitForTimeout",
    "setTimeout(",
    "setInterval(",
    "vi.useFakeTimers",
  ].filter((signal) => testText.includes(signal));
  if (unstableTestSignals.length > 0) {
    warnings.push(
      `tests_review: Tests include timing patterns that are usually brittle: ${unstableTestSignals.join(", ")}.`,
    );
  }

  return reviewResult({
    agentKey: "test_reviewer",
    phaseKey: "generated-tests-review",
    summary: summarizeReview("Generated tests review", warnings, blockingIssues),
    warnings,
    blockingIssues,
    payload: {
      unitTestFiles,
      browserTestFiles,
      acceptanceTestCount: input.architecture.acceptanceTests.length,
      testScenarioCount: input.spec.testScenarios.length,
    },
  });
}

function reviewSecurity(input: PostGenerationReviewInput): PostGenerationReview {
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const changedSource = sourceEntries(input.changedFiles);
  const apiRouteFiles = input.changedFilePaths.filter((path) =>
    path.startsWith("src/app/api/"),
  );

  for (const path of apiRouteFiles) {
    blockingIssues.push(
      `security_review: Generated code attempted to create or modify locked API route ${path}.`,
    );
  }

  for (const [path, content] of changedSource) {
    if (CREDENTIAL_PATTERN.test(content)) {
      blockingIssues.push(
        `security_review: ${path} references platform credentials or server environment variables.`,
      );
    }

    if (DIRECT_SERVICE_IMPORT_PATTERN.test(content)) {
      blockingIssues.push(
        `security_review: ${path} imports a server/external service client directly instead of a locked platform wrapper.`,
      );
    }

    if (DANGEROUS_CODE_PATTERN.test(content)) {
      blockingIssues.push(
        `security_review: ${path} uses unsafe dynamic HTML or code execution.`,
      );
    }

    const externalUrls = extractExternalUrls(content);
    if (externalUrls.length > 0) {
      blockingIssues.push(
        `security_review: ${path} references external URLs directly: ${externalUrls.join(", ")}.`,
      );
    }

    if (
      /(<input|<textarea)/i.test(content) &&
      /\b(api key|access token|secret|webhook url|smtp)\b/i.test(content)
    ) {
      warnings.push(
        `security_review: ${path} appears to collect credentials; generated apps should use VoiceForge-managed credentials only.`,
      );
    }
  }

  return reviewResult({
    agentKey: "security_reviewer",
    phaseKey: "security-review",
    summary: summarizeReview("Security review", warnings, blockingIssues),
    warnings,
    blockingIssues,
    payload: {
      reviewedSourceFiles: changedSource.map(([path]) => path),
      apiRouteFiles,
    },
  });
}

function reviewUxAccessibility(
  input: PostGenerationReviewInput,
): PostGenerationReview {
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const uiEntries = sourceEntries(input.allFiles).filter(
    ([path]) =>
      path.endsWith(".tsx") &&
      (path.startsWith("src/app/") || path.startsWith("src/components/")),
  );
  const pageEntries = uiEntries.filter(([path]) => isAppRouterPage(path));
  const pagesWithoutHeading = pageEntries
    .filter(([, content]) => !H1_PATTERN.test(content))
    .map(([path]) => path);
  const imagesWithoutAlt = uiEntries
    .filter(([, content]) => IMAGE_WITHOUT_ALT_PATTERN.test(content))
    .map(([path]) => path);
  const formControlsWithoutNames = uiEntries
    .filter(([, content]) => {
      const controlCount = countMatches(content, FORM_CONTROL_PATTERN);
      return controlCount > 0 && !ACCESSIBLE_NAME_PATTERN.test(content);
    })
    .map(([path]) => path);

  if (uiEntries.length === 0) {
    blockingIssues.push(
      "ux_accessibility_review: Generated app has no inspectable UI files.",
    );
  }

  if (pagesWithoutHeading.length > 0) {
    warnings.push(
      `ux_accessibility_review: App Router pages without an h1: ${pagesWithoutHeading.join(", ")}.`,
    );
  }

  if (imagesWithoutAlt.length > 0) {
    warnings.push(
      `ux_accessibility_review: Images without alt text found in: ${imagesWithoutAlt.join(", ")}.`,
    );
  }

  if (formControlsWithoutNames.length > 0) {
    warnings.push(
      `ux_accessibility_review: Form controls need labels or accessible names in: ${formControlsWithoutNames.join(", ")}.`,
    );
  }

  return reviewResult({
    agentKey: "ux_accessibility_reviewer",
    phaseKey: "ux-accessibility-review",
    summary: summarizeReview(
      "UX/accessibility review",
      warnings,
      blockingIssues,
    ),
    warnings,
    blockingIssues,
    payload: {
      uiFileCount: uiEntries.length,
      pageFiles: pageEntries.map(([path]) => path),
      pagesWithoutHeading,
      imagesWithoutAlt,
      formControlsWithoutNames,
      uxPlan: input.architecture.uxPlan,
    },
  });
}

function reviewResult(input: {
  agentKey: PostGenerationReviewAgentKey;
  phaseKey: string;
  summary: string;
  warnings: string[];
  blockingIssues: string[];
  payload: Record<string, unknown>;
}): PostGenerationReview {
  return {
    agentKey: input.agentKey,
    phaseKey: input.phaseKey,
    artifactType: "review_gate",
    status: artifactStatusFromIssues({
      failed: input.blockingIssues.length > 0,
      warnings: input.warnings,
    }),
    summary: input.summary,
    warnings: input.warnings,
    blockingIssues: input.blockingIssues,
    payload: {
      ...input.payload,
      warnings: input.warnings,
      blockingIssues: input.blockingIssues,
    },
  };
}

function summarizeReview(
  label: string,
  warnings: readonly unknown[],
  blockingIssues: readonly unknown[],
): string {
  if (blockingIssues.length > 0) {
    return `${label} found ${blockingIssues.length} blocking issue${
      blockingIssues.length === 1 ? "" : "s"
    }.`;
  }
  if (warnings.length > 0) {
    return `${label} passed with ${warnings.length} warning${
      warnings.length === 1 ? "" : "s"
    }.`;
  }
  return `${label} passed.`;
}

function sourceEntries(files: FileMap): [string, string][] {
  return Object.entries(files).filter(([path]) => {
    if (!SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      return false;
    }
    if (!path.startsWith("src/") && !path.startsWith("e2e/generated/")) {
      return false;
    }
    if (path.startsWith("src/app/api/")) return false;
    if (PROTECTED_TEMPLATE_FILES.has(path)) return false;
    if (isTestFile(path)) return false;
    return true;
  });
}

function isTestFile(path: string): boolean {
  return /(?:\.test|\.spec)\.tsx?$/.test(path);
}

function isAppRouterPage(path: string): boolean {
  return /^src\/app\/(?:.+\/)?page\.tsx$/.test(path);
}

function expectedPagesFromArchitecture(architecture: ArchitecturePlan): string[] {
  return uniqueStrings(
    architecture.pageMap
      .map((page) => routeToPagePath(page.route))
      .filter((path): path is string => Boolean(path)),
  );
}

function routeToPagePath(route: string): string | null {
  const cleanRoute = route.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleanRoute) return "src/app/page.tsx";
  if (cleanRoute.includes("*")) return null;
  return `src/app/${cleanRoute}/page.tsx`;
}

function requiresPlatformData(architecture: ArchitecturePlan): boolean {
  return (
    architecture.dataModel.some((entity) => entity.storage === "platformData") ||
    requiresService(architecture, "data")
  );
}

function requiresGeneratedAppSession(
  spec: AppSpec,
  architecture: ArchitecturePlan,
): boolean {
  return (
    spec.needsLogin ||
    architecture.permissionModel.some(
      (permission) => permission.enforcement !== "notNeeded",
    ) ||
    requiresService(architecture, "users")
  );
}

function requiresService(
  architecture: ArchitecturePlan,
  serviceName: ArchitecturePlan["platformServices"][number]["service"],
): boolean {
  return architecture.platformServices.some(
    (service) =>
      service.service === serviceName &&
      service.required &&
      service.availability === "available",
  );
}

function requiredServices(architecture: ArchitecturePlan): string[] {
  return architecture.platformServices
    .filter((service) => service.required && service.availability === "available")
    .map((service) => service.service);
}

function usesAny(content: string, needles: readonly string[]): boolean {
  return needles.some((needle) => content.includes(needle));
}

function combine(entries: readonly [string, string | undefined][]): string {
  return entries.map(([, content]) => content ?? "").join("\n");
}

function extractExternalUrls(content: string): string[] {
  const urls = content.match(EXTERNAL_URL_PATTERN) ?? [];
  return uniqueStrings(urls.filter((url) => !isAllowedLocalUrl(url)));
}

function isAllowedLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);
}

function countMatches(content: string, pattern: RegExp): number {
  const matches = content.match(new RegExp(pattern.source, pattern.flags));
  return matches?.length ?? 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
