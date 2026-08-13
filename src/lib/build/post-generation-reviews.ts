import type { ArchitecturePlan } from "../architecture";
import type { AppSpec } from "../spec";
import { platformEntityFromSpec } from "../platform/spec-seeding";
import {
  artifactStatusFromIssues,
  type BuildAgentArtifactStatus,
} from "./agent-artifact-utils";
import type { FileMap } from "./template";
import { analyzeGeneratedAcceptanceTests } from "./acceptance-test-review";
import { analyzePersistenceHandoffs } from "./persistence-handoff-review";
import { analyzeUiAffordances } from "./ui-affordance-review";

export type PostGenerationReviewAgentKey =
  | "code_reviewer"
  | "test_reviewer"
  | "security_reviewer"
  | "ux_accessibility_reviewer"
  | "ui_affordance_reviewer"
  | "persistence_handoff_reviewer"
  | "acceptance_test_reviewer"
  | "product_completeness_reviewer";

export type PostGenerationReview = {
  agentKey: PostGenerationReviewAgentKey;
  phaseKey: string;
  artifactType:
    | "review_gate"
    | "ui_affordance_review"
    | "persistence_handoff_review"
    | "acceptance_test_review"
    | "human_completeness_review";
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
  "src/lib/device-location.ts",
  "src/lib/voiceforge-modules.ts",
  "src/components/voiceforge-reusable.tsx",
  "src/components/voiceforge-google-map.tsx",
  "src/app/api/ai/route.ts",
  "src/app/api/data/route.ts",
  "src/app/api/files/route.ts",
  "src/app/api/notifications/route.ts",
  "src/app/api/integrations/route.ts",
  "e2e/smoke.spec.ts",
  "e2e/voiceforge-acceptance.ts",
  "e2e/voiceforge-progress-reporter.ts",
]);

const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const EXTERNAL_URL_PATTERN = /https?:\/\/[^\s"'`<>)]+/g;
const CREDENTIAL_PATTERN =
  /\b(process\.env|OPENAI_API_KEY|GITHUB_TOKEN|VERCEL_TOKEN|DATABASE_URL|VOICEFORGE_APP_TOKEN|VOICEFORGE_PUBLIC_URL|VOICEFORGE_PLATFORM_SESSION_SECRET|RESEND_API_KEY|GOOGLE_MAPS_API_KEY)\b/;
const DANGEROUS_CODE_PATTERN =
  /\b(eval\s*\(|new Function\s*\(|dangerouslySetInnerHTML\b)/;
const DIRECT_GEOLOCATION_PATTERN = /\bnavigator\.geolocation\b/;
const DIRECT_SERVICE_IMPORT_PATTERN =
  /from\s+["'](@neondatabase\/serverless|@octokit\/rest|openai|resend|nodemailer|googleapis)["']/;
const PDF_BLOB_PATTERN =
  /\bnew\s+Blob\s*\([\s\S]{0,600}\btype\s*:\s*["']application\/pdf["']/;
const MEMBER_ACCESS_ACTION_PATTERN =
  /\b(invite member|invite user|remove member|remove access|revoke access|grant access|resend invite)\b/i;
const MEMBER_ACCESS_NOTE_PATTERN =
  /\b(VoiceForge dashboard|managed from VoiceForge|managed in VoiceForge|VoiceForge app dashboard|access is managed)\b/i;
const PLATFORM_RECORD_CALL_PATTERN =
  /\b(createPlatformRecord|updatePlatformRecord)\s*\(\s*["'`]([A-Za-z0-9_-]+)["'`]\s*,([\s\S]{0,1200}?)\)/g;
const PLATFORM_DATA_WRITE_PATTERN =
  /\b(?:createPlatformRecord|updatePlatformRecord)\b/;
const PLATFORM_RECORD_WRITE_CALLS = [
  "createPlatformRecord",
  "updatePlatformRecord",
  "deletePlatformRecord",
] as const;
const INTEGRATION_RUNTIME_CALL_PATTERN =
  /\b(listPlatformIntegrationProviders|invokePlatformIntegration|searchGoogleMapsPlaces|getGoogleMapsPlaceDetails|geocodeGoogleMapsAddress|computeGoogleMapsRoute|getGoogleMapsElevationProfile)\s*\(/;
const PLATFORM_SEARCH_RUNTIME_CALL_PATTERN =
  /\bsearchPlatformRecords(?:\s*<[\s\S]{0,250}?>)?\s*\(/;
const PLATFORM_FILE_UPLOAD_PATTERN =
  /\b(uploadPlatformFile|uploadPlatformFileData|PlatformFileUploadInput)\b/;
const PLATFORM_FILE_PERSISTENCE_PATTERN =
  /\b(createPlatformRecord|updatePlatformRecord|create[A-Za-z0-9_$]*(?:Photo|Image|File|Attachment|Journal)|listPlatformFiles|downloadPlatformFile|downloadPlatformFileToBrowser)\s*\(/;
const RAW_PLATFORM_BINARY_PAYLOAD_PATTERN =
  /\b(?:generated_)?(?:image|photo|file|attachment|pdf)[A-Za-z0-9_$]*\s*:\s*(?:[A-Za-z_$][\w$]*\.)?(?:imageBase64|base64Image|generatedImageBase64|rawImageData|rawFileData|rawPdfData|dataUrl|base64)\b/i;
const PLATFORM_RECORD_RAW_BINARY_WINDOW_PATTERN =
  /\b(?:createPlatformRecord|updatePlatformRecord)(?:\s*<[^>()]+>)?\s*\([\s\S]{0,1200}\b(?:imageBase64|base64Image|generatedImageBase64|rawImageData|rawFileData|rawPdfData|dataUrl|base64)\b/i;
const RELATION_VALUE_ERROR_COLLISION_PATTERN =
  /\bconst\s+([A-Za-z_$][\w$]*Id)\s*=\s*(?:required|validateRequired|requiredText|requiredField|requiredString)\s*\(\s*[A-Za-z_$][\w$]*\.\1\b[\s\S]{0,1200}\b[A-Za-z_$][\w$]*Ids?\.has\(\s*[A-Za-z_$][\w$]*\.\1\b/i;
const RAW_AI_IMAGE_TO_CREATION_PATTERN =
  /\b(?:imageBase64|base64Image|generatedImageBase64|dataUrl|base64)\b[\s\S]{0,1200}\bcreate[A-Za-z0-9_$]*Creation\s*\([\s\S]{0,700}\bgeneratedImage\s*:\s*(?:[A-Za-z_$][\w$]*\.)?(?:imageBase64|base64Image|generatedImageBase64|dataUrl|base64)\b/i;
const GENERATED_IMAGE_VARIABLE_TO_CREATION_PATTERN =
  /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+generate[A-Za-z0-9_$]*Image\s*\([\s\S]{0,1400}\bcreate[A-Za-z0-9_$]*Creation\s*\([\s\S]{0,700}\bgeneratedImage\s*:\s*\1\b/i;
const GOOGLE_MAPS_RUNTIME_CALL_PATTERN =
  /\b(searchGoogleMapsPlaces|getGoogleMapsPlaceDetails|geocodeGoogleMapsAddress|computeGoogleMapsRoute|getGoogleMapsElevationProfile)\s*\(/;
const GOOGLE_MAPS_INVOKE_PATTERN =
  /\binvokePlatformIntegration\s*\([\s\S]{0,900}\bproviderKey\s*:\s*["'`]google_maps["'`]/;
const GOOGLE_MAPS_MAP_COMPONENT_PATTERN = /<\s*GoogleMapsTripMap\b/;
const GOOGLE_MAPS_AUTOCOMPLETE_PATTERN = /<\s*GooglePlaceAutocomplete\b/;
const GOOGLE_MAPS_BICYCLE_PATTERN =
  /\btravelMode\s*:\s*["'`]BICYCLE["'`]|\btravelMode\s*=\s*["'`]BICYCLE["'`]/;
const GOOGLE_MAPS_PLACE_SEARCH_PLACEHOLDER_LINK_PATTERN =
  /<\s*(?:a|Link)\b(?=[\s\S]{0,500}\bhref\s*=\s*["'`]\/(?:two-point-route-explorer|route-comparison|map-view)["'`])(?=[\s\S]{0,500}>\s*Search\s+places\s*<)/i;
const OBJECT_KEY_PATTERN = /[{,]\s*([A-Za-z_$][\w$]*)\s*:/g;
const NON_PAYLOAD_OBJECT_KEYS = new Set([
  "children",
  "className",
  "disabled",
  "entityKey",
  "error",
  "id",
  "key",
  "onClick",
  "onSubmit",
  "recordId",
  "role",
  "style",
  "type",
  "value",
]);
const FORM_CONTROL_PATTERN = /<(input|select|textarea)\b(?![^>]*type=["']hidden["'])/gi;
const ACCESSIBLE_NAME_PATTERN = /(<label\b|htmlFor=|aria-label=|aria-labelledby=)/i;
const IMAGE_WITHOUT_ALT_PATTERN = /<img\b(?![^>]*\balt=)/i;
const H1_PATTERN = /<h1(\s|>)/i;
const WRITE_ACTION_WORDS = [
  "add",
  "calculate",
  "change",
  "choose",
  "compare",
  "create",
  "delete",
  "edit",
  "export",
  "filter",
  "new",
  "plan",
  "record",
  "remove",
  "request",
  "save",
  "search",
  "select",
  "start",
  "submit",
  "track",
  "update",
  "upload",
] as const;
const WRITE_ACTION_PATTERN = new RegExp(
  `\\b(${WRITE_ACTION_WORDS.join("|")})(?:s|d|ed|ing)?\\b`,
  "i",
);
const WRITE_ACTION_FUNCTION_PATTERN = new RegExp(
  `\\b(?:${WRITE_ACTION_WORDS.join("|")})[A-Za-z0-9_$]*\\b`,
  "i",
);
const GENERIC_ENTITY_TERMS = new Set([
  "app",
  "data",
  "day",
  "detail",
  "entry",
  "info",
  "item",
  "option",
  "record",
  "trip",
  "update",
]);
const GENERIC_WORKFLOW_TERMS = new Set([
  "app",
  "data",
  "detail",
  "information",
  "member",
  "page",
  "record",
  "screen",
  "shared",
  "user",
  "workflow",
]);

export function runPostGenerationReviews(
  input: PostGenerationReviewInput,
): PostGenerationReview[] {
  return [
    reviewGeneratedCode(input),
    reviewUiAffordances(input),
    reviewPersistenceHandoffs(input),
    reviewGeneratedAcceptanceJourneys(input),
    reviewGeneratedTests(input),
    reviewSecurity(input),
    reviewUxAccessibility(input),
  ];
}

function reviewGeneratedAcceptanceJourneys(
  input: PostGenerationReviewInput,
): PostGenerationReview {
  const userActionContracts = input.architecture.workflowContracts.filter(
    (contract) => contract.trigger === "user_action",
  );
  if (userActionContracts.length === 0) {
    return {
      agentKey: "acceptance_test_reviewer",
      phaseKey: "generated-acceptance-test-review",
      artifactType: "acceptance_test_review",
      status: "skipped",
      summary:
        "Generated acceptance test review skipped because no user-action workflow contracts were planned.",
      warnings: [],
      blockingIssues: [],
      payload: {
        version: 1,
        skipped: true,
        reason: "No Stage 14A user-action workflow contracts were available.",
        summary: {
          journeysPlanned: 0,
          journeysGenerated: 0,
          journeysVerified: 0,
          workflowsRequired: 0,
          workflowsVerified: 0,
          stepsRequired: 0,
          stepsVerified: 0,
          savesRequired: 0,
          savesVerified: 0,
          refreshChecksRequired: 0,
          refreshChecksVerified: 0,
          handoffsRequired: 0,
          handoffsVerified: 0,
          roleScenariosRequired: 0,
          roleScenariosVerified: 0,
          downloadsRequired: 0,
          downloadsVerified: 0,
          geolocationJourneysRequired: 0,
          geolocationJourneysVerified: 0,
          nonBrowserWorkflows: 0,
        },
        generatedTestFiles: [],
        journeys: [],
        warnings: [],
        blockingIssues: [],
      },
    };
  }

  const report = analyzeGeneratedAcceptanceTests({
    spec: input.spec,
    architecture: input.architecture,
    files: input.allFiles,
  });
  return {
    agentKey: "acceptance_test_reviewer",
    phaseKey: "generated-acceptance-test-review",
    artifactType: "acceptance_test_review",
    status: artifactStatusFromIssues({
      failed: report.blockingIssues.length > 0,
      warnings: report.warnings,
    }),
    summary:
      report.blockingIssues.length > 0
        ? `Acceptance journey review found ${report.blockingIssues.length} blocking issue${report.blockingIssues.length === 1 ? "" : "s"}; ${report.summary.journeysVerified}/${report.summary.journeysPlanned} journeys and ${report.summary.handoffsVerified}/${report.summary.handoffsRequired} handoffs are verified.`
        : report.warnings.length > 0
          ? `Acceptance journey review passed with ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}; ${report.summary.stepsVerified}/${report.summary.stepsRequired} contract steps are verified.`
          : `Acceptance journey review passed: ${report.summary.journeysVerified}/${report.summary.journeysPlanned} journeys, ${report.summary.stepsVerified}/${report.summary.stepsRequired} steps, and ${report.summary.refreshChecksVerified}/${report.summary.refreshChecksRequired} refresh checks are verified.`,
    warnings: report.warnings,
    blockingIssues: report.blockingIssues,
    payload: { ...report },
  };
}

function reviewPersistenceHandoffs(
  input: PostGenerationReviewInput,
): PostGenerationReview {
  const savesRequired = input.architecture.workflowContracts.reduce(
    (total, contract) => total + contract.expectedSaves.length,
    0,
  );
  const handoffsRequired = input.architecture.workflowContracts.reduce(
    (total, contract) => total + contract.handoffs.length,
    0,
  );
  if (savesRequired === 0 && handoffsRequired === 0) {
    return {
      agentKey: "persistence_handoff_reviewer",
      phaseKey: "generated-persistence-handoff-review",
      artifactType: "persistence_handoff_review",
      status: "skipped",
      summary:
        "Persistence and handoff review skipped because no durable saves or downstream handoffs were planned.",
      warnings: [],
      blockingIssues: [],
      payload: {
        version: 1,
        skipped: true,
        reason: "No Stage 14A save transitions or handoffs were available.",
        summary: {
          savesRequired: 0,
          savesVerified: 0,
          exactSchemasRequired: 0,
          exactSchemasVerified: 0,
          reloadPathsRequired: 0,
          reloadPathsVerified: 0,
          handoffsRequired: 0,
          handoffsVerified: 0,
          persistenceTestsRequired: 0,
          persistenceTestsVerified: 0,
        },
        saves: [],
        reloads: [],
        handoffs: [],
        warnings: [],
        blockingIssues: [],
      },
    };
  }

  const report = analyzePersistenceHandoffs({
    spec: input.spec,
    architecture: input.architecture,
    files: input.allFiles,
  });
  return {
    agentKey: "persistence_handoff_reviewer",
    phaseKey: "generated-persistence-handoff-review",
    artifactType: "persistence_handoff_review",
    status: artifactStatusFromIssues({
      failed: report.blockingIssues.length > 0,
      warnings: report.warnings,
    }),
    summary:
      report.blockingIssues.length > 0
        ? `Persistence and handoff review found ${report.blockingIssues.length} blocking issue${report.blockingIssues.length === 1 ? "" : "s"}; ${report.summary.savesVerified}/${report.summary.savesRequired} saves and ${report.summary.handoffsVerified}/${report.summary.handoffsRequired} handoffs are verified.`
        : report.warnings.length > 0
          ? `Persistence and handoff review passed with ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}; ${report.summary.reloadPathsVerified}/${report.summary.reloadPathsRequired} refresh paths are verified.`
          : `Persistence and handoff review passed: ${report.summary.savesVerified}/${report.summary.savesRequired} saves, ${report.summary.reloadPathsVerified}/${report.summary.reloadPathsRequired} refresh paths, and ${report.summary.handoffsVerified}/${report.summary.handoffsRequired} handoffs are verified.`,
    warnings: report.warnings,
    blockingIssues: report.blockingIssues,
    payload: { ...report },
  };
}

function reviewUiAffordances(
  input: PostGenerationReviewInput,
): PostGenerationReview {
  if (input.architecture.workflowContracts.length === 0) {
    return {
      agentKey: "ui_affordance_reviewer",
      phaseKey: "generated-ui-affordance-review",
      artifactType: "ui_affordance_review",
      status: "skipped",
      summary: "Interface readiness skipped because no user-workflow contracts were planned.",
      warnings: [],
      blockingIssues: [],
      payload: {
        version: 1,
        skipped: true,
        reason: "No Stage 14A workflow contracts were available.",
        summary: {
          routesFound: 0,
          reachableRoutes: 0,
          workflowsPlanned: 0,
          workflowsDiscoverable: 0,
          controlsExpected: 0,
          controlsMatched: 0,
          entityPathsRequired: 0,
          entityPathsAvailable: 0,
          hiddenRoutes: 0,
          placeholderPages: 0,
          vagueControls: 0,
          uncertainControls: 0,
        },
        routes: [],
        workflows: [],
        entities: [],
        hiddenRoutes: [],
        placeholderRoutes: [],
        vagueControls: [],
        uncertainControls: [],
        warnings: [],
        blockingIssues: [],
      },
    };
  }

  const report = analyzeUiAffordances({
    spec: input.spec,
    architecture: input.architecture,
    files: input.allFiles,
  });
  return {
    agentKey: "ui_affordance_reviewer",
    phaseKey: "generated-ui-affordance-review",
    artifactType: "ui_affordance_review",
    status: artifactStatusFromIssues({
      failed: report.blockingIssues.length > 0,
      warnings: report.warnings,
    }),
    summary:
      report.blockingIssues.length > 0
        ? `Interface readiness found ${report.blockingIssues.length} blocking issue${report.blockingIssues.length === 1 ? "" : "s"}; ${report.summary.workflowsDiscoverable}/${report.summary.workflowsPlanned} workflows are discoverable.`
        : report.warnings.length > 0
          ? `Interface readiness passed with ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}; ${report.summary.workflowsDiscoverable}/${report.summary.workflowsPlanned} workflows are discoverable.`
          : `Interface readiness passed: ${report.summary.workflowsDiscoverable}/${report.summary.workflowsPlanned} workflows and ${report.summary.reachableRoutes}/${report.summary.routesFound} routes are discoverable.`,
    warnings: report.warnings,
    blockingIssues: report.blockingIssues,
    payload: { ...report },
  };
}

export function getPostGenerationBlockingIssues(
  reviews: readonly PostGenerationReview[],
): string[] {
  return uniqueStrings(reviews.flatMap((review) => review.blockingIssues));
}

export type PostGenerationRepairDomain =
  | "implementation"
  | "interface"
  | "persistence"
  | "acceptance"
  | "completeness";

export type PostGenerationRepairBatch = {
  domain: PostGenerationRepairDomain;
  issues: string[];
};

export type PostGenerationIssueCounts = Record<
  PostGenerationRepairDomain,
  number
>;

export type PostGenerationRepairAssessment = {
  accepted: boolean;
  targetProgress: ReturnType<typeof comparePostGenerationIssueSets>;
  previousCounts: PostGenerationIssueCounts;
  currentCounts: PostGenerationIssueCounts;
  regressedDomains: PostGenerationRepairDomain[];
  reason: string;
};

const POST_GENERATION_REPAIR_PRIORITY: PostGenerationRepairDomain[] = [
  "implementation",
  "interface",
  "persistence",
  "acceptance",
  "completeness",
];

export function postGenerationRepairDomain(
  issue: string,
): PostGenerationRepairDomain {
  if (issue.startsWith("ui_affordance:")) return "interface";
  if (issue.startsWith("persistence_handoff:")) return "persistence";
  if (issue.startsWith("acceptance_test:")) return "acceptance";
  if (issue.startsWith("human_completeness:")) return "completeness";
  return "implementation";
}

export function selectPostGenerationRepairBatch(
  issues: readonly string[],
): PostGenerationRepairBatch | null {
  const uniqueIssues = uniqueStrings([...issues]);
  for (const domain of POST_GENERATION_REPAIR_PRIORITY) {
    const domainIssues = uniqueIssues.filter(
      (issue) => postGenerationRepairDomain(issue) === domain,
    );
    if (domainIssues.length > 0) return { domain, issues: domainIssues };
  }
  return null;
}

export function postGenerationIssuesForDomain(
  issues: readonly string[],
  domain: PostGenerationRepairDomain,
): string[] {
  return uniqueStrings(
    issues.filter((issue) => postGenerationRepairDomain(issue) === domain),
  );
}

export function countPostGenerationIssues(
  issues: readonly string[],
): PostGenerationIssueCounts {
  return {
    implementation: postGenerationIssuesForDomain(issues, "implementation").length,
    interface: postGenerationIssuesForDomain(issues, "interface").length,
    persistence: postGenerationIssuesForDomain(issues, "persistence").length,
    acceptance: postGenerationIssuesForDomain(issues, "acceptance").length,
    completeness: postGenerationIssuesForDomain(issues, "completeness").length,
  };
}

export function assessPostGenerationRepair(input: {
  domain: PostGenerationRepairDomain;
  previousIssues: readonly string[];
  currentIssues: readonly string[];
}): PostGenerationRepairAssessment {
  const previousDomainIssues = postGenerationIssuesForDomain(
    input.previousIssues,
    input.domain,
  );
  const currentDomainIssues = postGenerationIssuesForDomain(
    input.currentIssues,
    input.domain,
  );
  const targetProgress = comparePostGenerationIssueSets(
    previousDomainIssues,
    currentDomainIssues,
  );
  const previousCounts = countPostGenerationIssues(input.previousIssues);
  const currentCounts = countPostGenerationIssues(input.currentIssues);
  const domains: PostGenerationRepairDomain[] = [
    "implementation",
    "interface",
    "persistence",
    "acceptance",
    "completeness",
  ];
  const regressedDomains = domains.filter(
    (domain) => currentCounts[domain] > previousCounts[domain],
  );
  const targetImproved =
    currentCounts[input.domain] < previousCounts[input.domain];
  const accepted = targetImproved && regressedDomains.length === 0;
  const reason = accepted
    ? `${input.domain} findings improved from ${previousCounts[input.domain]} to ${currentCounts[input.domain]} without regressing another review domain.`
    : regressedDomains.length > 0
      ? `The candidate repair increased findings in ${regressedDomains.join(", ")}.`
      : `The candidate repair did not reduce ${input.domain} findings (${previousCounts[input.domain]} -> ${currentCounts[input.domain]}).`;
  return {
    accepted,
    targetProgress,
    previousCounts,
    currentCounts,
    regressedDomains,
    reason,
  };
}

export function createPostGenerationRepairEvidence(input: {
  domain: PostGenerationRepairDomain;
  issues: readonly string[];
  reviews: readonly PostGenerationReview[];
}): Record<string, unknown> {
  const relevantAgent =
    input.domain === "interface"
      ? "ui_affordance_reviewer"
      : input.domain === "persistence"
        ? "persistence_handoff_reviewer"
      : input.domain === "acceptance"
          ? "acceptance_test_reviewer"
          : input.domain === "completeness"
            ? "product_completeness_reviewer"
          : null;
  const reviews = input.reviews
    .filter((review) => relevantAgent === null || review.agentKey === relevantAgent)
    .map((review) => ({
      agentKey: review.agentKey,
      summary: review.summary,
      blockingIssues: review.blockingIssues,
      evidence: compactReviewPayload(review),
    }));
  return {
    repairDomain: input.domain,
    issueCounts: countPostGenerationIssues(
      input.reviews.flatMap((review) => review.blockingIssues),
    ),
    blockingIssues: [...input.issues],
    reviews,
  };
}

export function comparePostGenerationIssueSets(
  previousIssues: readonly string[],
  currentIssues: readonly string[],
): {
  status: "resolved" | "improved" | "unchanged" | "changed" | "regressed";
  resolvedIssues: string[];
  newIssues: string[];
} {
  const previous = uniqueStrings([...previousIssues]).sort();
  const current = uniqueStrings([...currentIssues]).sort();
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  const resolvedIssues = previous.filter((issue) => !currentSet.has(issue));
  const newIssues = current.filter((issue) => !previousSet.has(issue));
  const status =
    current.length === 0
      ? "resolved"
      : newIssues.length === 0 && resolvedIssues.length === 0
        ? "unchanged"
        : newIssues.length === 0 && resolvedIssues.length > 0
          ? "improved"
          : newIssues.length > 0 && resolvedIssues.length === 0
            ? "regressed"
            : "changed";
  return { status, resolvedIssues, newIssues };
}

export function shouldStopUnchangedInterfaceRepairs(
  consecutiveUnchangedRounds: number,
): boolean {
  return consecutiveUnchangedRounds >= 2;
}

function compactReviewPayload(
  review: PostGenerationReview,
): Record<string, unknown> {
  const payload = review.payload;
  if (review.agentKey === "ui_affordance_reviewer") {
    return pickPayload(payload, [
      "summary",
      "workflows",
      "entities",
      "hiddenRoutes",
      "placeholderRoutes",
      "vagueControls",
      "uncertainControls",
    ]);
  }
  if (review.agentKey === "persistence_handoff_reviewer") {
    return pickPayload(payload, [
      "summary",
      "saves",
      "reloads",
      "handoffs",
    ]);
  }
  if (review.agentKey === "acceptance_test_reviewer") {
    return pickPayload(payload, [
      "summary",
      "generatedTestFiles",
      "journeys",
    ]);
  }
  if (review.agentKey === "product_completeness_reviewer") {
    return pickPayload(payload, [
      "summary",
      "overallAssessment",
      "assessments",
      "filesInspected",
      "testFilesInspected",
      "limitations",
    ]);
  }
  return pickPayload(payload, [
    "changedFileCount",
    "pageFiles",
    "missingPageFiles",
    "requiredServices",
    "unitTestFiles",
    "browserTestFiles",
  ]);
}

function pickPayload(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => key in payload)
      .map((key) => [key, payload[key]]),
  );
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
    const message = `code_review: Architecture planned route files that were not generated: ${missingPageFiles.join(", ")}.`;
    if (requiresStrictWorkflowCoverage(input.spec, input.architecture)) {
      blockingIssues.push(message);
    } else {
      warnings.push(message);
    }
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

  if (requiresGeneratedAppSession(input.spec, input.architecture)) {
    const hasReusableGate = combinedSource.includes("PlatformSignInGate");
    const hasRouteStableSession = combinedSource.includes(
      "usePlatformSessionState",
    );
    const hasManualSignIn =
      combinedSource.includes("getPlatformSession") &&
      combinedSource.includes("signInToPlatform") &&
      /\bloginUrl\b/.test(combinedSource);
    if (!hasReusableGate && !hasManualSignIn) {
      blockingIssues.push(
        "code_review: Sign-in or role-aware app did not provide a usable locked platform sign-in action.",
      );
    }
    if (!hasReusableGate && !hasRouteStableSession) {
      warnings.push(
        "code_review: Sign-in app does not use the route-stable reusable session helpers; verify it will not flash the sign-in screen between routes.",
      );
    }
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
    requiresService(input.architecture, "files") &&
    PLATFORM_FILE_UPLOAD_PATTERN.test(combinedSource) &&
    !PLATFORM_FILE_PERSISTENCE_PATTERN.test(combinedSource)
  ) {
    blockingIssues.push(
      "code_review: File upload workflow only uploads a file; persist uploads in app records or list/download them so selected files remain visible after upload.",
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

  if (
    requiresService(input.architecture, "integrations") &&
    !hasRuntimeIntegrationUsage(combinedSource)
  ) {
    blockingIssues.push(
      "code_review: Integration-enabled app did not make a runtime call through the locked platform-integrations client.",
    );
  }

  if (
    requiresService(input.architecture, "device_location") &&
    !usesAny(combinedSource, [
      "device-location",
      "DeviceLocationTracker",
      "getCurrentDeviceLocation",
      "watchDeviceLocation",
    ])
  ) {
    blockingIssues.push(
      "code_review: Device GPS/location app did not use the locked device-location helpers.",
    );
  }

  if (
    requiresService(input.architecture, "search") &&
    !PLATFORM_SEARCH_RUNTIME_CALL_PATTERN.test(combinedSource)
  ) {
    blockingIssues.push(
      "code_review: Architecture requires platform search, but the generated app did not use searchPlatformRecords for server-side search/filter/sort.",
    );
  }
  if (
    requiresService(input.architecture, "reports") &&
    !usesAny(combinedSource, [
      "runPlatformRecordReport",
      "exportPlatformRecordsCsv",
    ])
  ) {
    warnings.push(
      "code_review: Architecture requires platform reports, but the generated app did not use the Stage 12B report/export helpers.",
    );
  }

  if (requiresPlatformData(input.architecture) && /\blocalStorage\b/.test(combinedSource)) {
    warnings.push(
      "code_review: Platform-data app still references localStorage; verify it is only for harmless UI preferences.",
    );
  }

  blockingIssues.push(...detectPlatformFieldKeyIssues(input.spec, appSource));
  blockingIssues.push(...detectRelationValidationCollisions(appSource));
  blockingIssues.push(
    ...detectOversizedPlatformDataPayloadIssues(
      input.spec,
      input.architecture,
      appSource,
    ),
  );
  blockingIssues.push(...detectFakeMemberAccessIssues(appSource));
  blockingIssues.push(
    ...detectGoogleMapsImplementationIssues(input.spec, appSource),
  );
  blockingIssues.push(
    ...detectAdvancedWorkflowUiCoverageIssues(input.spec, input.architecture, appSource),
  );

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
      strictWorkflowCoverage: requiresStrictWorkflowCoverage(
        input.spec,
        input.architecture,
      ),
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

  blockingIssues.push(
    ...detectAdvancedWorkflowTestCoverageIssues(input.spec, input.architecture, [
      ...unitTestFiles,
      ...browserTestFiles,
    ].map((path): [string, string | undefined] => [path, input.allFiles[path]])),
  );

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
      strictWorkflowCoverage: requiresStrictWorkflowCoverage(
        input.spec,
        input.architecture,
      ),
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

    if (DIRECT_GEOLOCATION_PATTERN.test(content)) {
      blockingIssues.push(
        `security_review: ${path} calls navigator.geolocation directly; use the locked device-location helpers instead.`,
      );
    }

    if (PDF_BLOB_PATTERN.test(content)) {
      blockingIssues.push(
        `security_review: ${path} creates a fake PDF by labeling non-PDF bytes as application/pdf; use downloadSimplePdf, downloadRecordsPdf, or jsPDF.`,
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
  const headingReview = reviewRenderedPageHeadings(
    pageEntries.map(([path]) => path),
    input.allFiles,
  );
  const pagesWithoutHeading = headingReview.pagesWithoutHeading;
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
      `ux_accessibility_review: Rendered App Router pages without an h1: ${pagesWithoutHeading.join(", ")}.`,
    );
  }

  if (headingReview.sharedShellsWithHeading.length > 0) {
    warnings.push(
      `ux_accessibility_review: Shared shells render an h1 in addition to each screen heading: ${headingReview.sharedShellsWithHeading.join(", ")}. Use ordinary brand text in the shell and reserve one h1 for the active screen.`,
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
      redirectOnlyPages: headingReview.redirectOnlyPages,
      sharedShellsWithHeading: headingReview.sharedShellsWithHeading,
      imagesWithoutAlt,
      formControlsWithoutNames,
      uxPlan: input.architecture.uxPlan,
    },
  });
}

function reviewRenderedPageHeadings(
  pagePaths: readonly string[],
  files: FileMap,
): {
  pagesWithoutHeading: string[];
  redirectOnlyPages: string[];
  sharedShellsWithHeading: string[];
} {
  const pagesWithoutHeading: string[] = [];
  const redirectOnlyPages: string[] = [];
  const renderedPaths = new Set<string>();

  for (const pagePath of pagePaths) {
    const pageSource = files[pagePath] ?? "";
    if (isRedirectOnlyPage(pageSource)) {
      redirectOnlyPages.push(pagePath);
      continue;
    }
    const closure = collectImportedSourceClosure(pagePath, files);
    closure.forEach((path) => renderedPaths.add(path));
    if (
      ![...closure].some((path) => {
        const source = files[path] ?? "";
        return (
          !PROTECTED_TEMPLATE_FILES.has(path) &&
          !isSharedShellWithHeading(path, source) &&
          H1_PATTERN.test(source)
        );
      })
    ) {
      pagesWithoutHeading.push(pagePath);
    }
  }

  const sharedShellsWithHeading = [...renderedPaths]
    .filter((path) => {
      return isSharedShellWithHeading(path, files[path] ?? "");
    })
    .sort();

  return {
    pagesWithoutHeading: pagesWithoutHeading.sort(),
    redirectOnlyPages: redirectOnlyPages.sort(),
    sharedShellsWithHeading,
  };
}

function isSharedShellWithHeading(path: string, source: string): boolean {
  return (
    path.startsWith("src/components/") &&
    path.endsWith(".tsx") &&
    H1_PATTERN.test(source) &&
    /\{\s*children\s*\}/.test(source) &&
    /[^/]*(?:shell|layout)[^/]*\.tsx$/i.test(path)
  );
}

function isRedirectOnlyPage(source: string): boolean {
  return (
    /\bredirect\s*\(/.test(source) &&
    !/<(?:[A-Za-z][A-Za-z0-9_.:-]*)\b/.test(source)
  );
}

function collectImportedSourceClosure(
  startPath: string,
  files: FileMap,
): Set<string> {
  const visited = new Set<string>();
  const queue = [startPath];
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path || visited.has(path) || files[path] === undefined) continue;
    visited.add(path);
    for (const dependency of internalSourceImports(path, files[path], files)) {
      if (!visited.has(dependency)) queue.push(dependency);
    }
  }
  return visited;
}

function internalSourceImports(
  sourcePath: string,
  source: string,
  files: FileMap,
): string[] {
  const imports: string[] = [];
  for (const match of source.matchAll(
    /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g,
  )) {
    const resolved = resolveGeneratedSourceImport(sourcePath, match[1], files);
    if (resolved) imports.push(resolved);
  }
  return uniqueStrings(imports);
}

function resolveGeneratedSourceImport(
  sourcePath: string,
  specifier: string,
  files: FileMap,
): string | null {
  let base: string | null = null;
  if (specifier.startsWith("@/")) {
    base = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    const sourceDirectory = sourcePath.split("/").slice(0, -1).join("/");
    base = normalizeGeneratedSourcePath(`${sourceDirectory}/${specifier}`);
  }
  if (!base) return null;
  return (
    [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
      .find((candidate) => files[candidate] !== undefined) ?? null
  );
}

function normalizeGeneratedSourcePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
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

function detectPlatformFieldKeyIssues(
  spec: AppSpec,
  source: readonly [string, string][],
): string[] {
  if (spec.dataEntities.length === 0) return [];
  const schemas = new Map(
    spec.dataEntities.map((entity) => {
      const schema = platformEntityFromSpec(entity, spec);
      return [
        schema.key,
        {
          name: schema.name,
          fieldKeys: new Set(schema.fields.map((field) => field.key)),
        },
      ];
    }),
  );
  const issues: string[] = [];

  for (const [path, content] of source) {
    PLATFORM_RECORD_CALL_PATTERN.lastIndex = 0;
    for (const match of content.matchAll(PLATFORM_RECORD_CALL_PATTERN)) {
      const operation = match[1];
      const entityKey = match[2];
      const callTail = match[3] ?? "";
      const schema = schemas.get(entityKey);
      if (!schema) {
        issues.push(
          `code_review: ${path} calls ${operation} with unknown platform entity key "${entityKey}".`,
        );
        continue;
      }
      const payloadSnippet = directPlatformPayloadSnippet(operation, callTail);
      if (!payloadSnippet) continue;
      const payloadKeys = directObjectKeys(payloadSnippet).filter(
        (key) =>
          !schema.fieldKeys.has(key) && !NON_PAYLOAD_OBJECT_KEYS.has(key),
      );
      if (payloadKeys.length > 0) {
        issues.push(
          `code_review: ${path} appears to save fields not in the ${schema.name} platform schema: ${uniqueStrings(payloadKeys).join(", ")}.`,
        );
      }
    }
  }

  return uniqueStrings(issues);
}

function detectOversizedPlatformDataPayloadIssues(
  spec: AppSpec,
  architecture: ArchitecturePlan,
  source: readonly [string, string][],
): string[] {
  if (!requiresPlatformData(architecture) || !mentionsBinaryLikeStorage(spec)) {
    return [];
  }

  const issues: string[] = [];
  for (const [path, content] of source) {
    const hasUnsafePlatformPayload =
      (PLATFORM_DATA_WRITE_PATTERN.test(content) &&
        RAW_PLATFORM_BINARY_PAYLOAD_PATTERN.test(content)) ||
      PLATFORM_RECORD_RAW_BINARY_WINDOW_PATTERN.test(content);
    const hasUnsafeGeneratedImageFlow =
      RAW_AI_IMAGE_TO_CREATION_PATTERN.test(content) ||
      GENERATED_IMAGE_VARIABLE_TO_CREATION_PATTERN.test(content);
    if (hasUnsafePlatformPayload || hasUnsafeGeneratedImageFlow) {
      issues.push(
        `code_review: ${path} appears to save raw image/file data into platform-data records. Platform records are limited JSON payloads; upload binary data with platform-files and store only the returned file id/reference.`,
      );
    }
  }

  return uniqueStrings(issues);
}

function mentionsBinaryLikeStorage(spec: AppSpec): boolean {
  const specText = [
    spec.appName,
    spec.purpose,
    ...spec.features,
    ...spec.dataToStore,
    ...spec.aiFeatures,
    ...spec.fileRequirements.flatMap((requirement) => [
      requirement.name,
      requirement.attachedTo,
      ...requirement.acceptedTypes,
    ]),
  ].join(" ");

  return (
    /\b(image|photo|picture|file|attachment|upload|pdf|generated image|generated picture)\b/i.test(
      specText,
    ) ||
    spec.dataEntities.some((entity) =>
      entity.fields.some(
        (field) =>
          field.type === "image" ||
          field.type === "file" ||
          /\b(image|photo|picture|file|attachment|pdf)\b/i.test(
            `${field.name} ${field.label}`,
          ),
      ),
    )
  );
}

function directPlatformPayloadSnippet(
  operation: string,
  callTail: string,
): string | null {
  const trimmed = callTail.trim().replace(/^,/, "").trim();
  if (operation === "createPlatformRecord") {
    return trimmed.startsWith("{") ? trimmed : null;
  }
  if (operation === "updatePlatformRecord") {
    const payloadMatch = trimmed.match(/^[^,]+,\s*({[\s\S]*)$/);
    return payloadMatch?.[1]?.trim().startsWith("{")
      ? payloadMatch[1]
      : null;
  }
  return null;
}

function directObjectKeys(value: string): string[] {
  const keys: string[] = [];
  OBJECT_KEY_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(OBJECT_KEY_PATTERN)) {
    const key = match[1];
    if (key) keys.push(key);
  }
  return uniqueStrings(keys);
}

function detectFakeMemberAccessIssues(
  source: readonly [string, string][],
): string[] {
  return source
    .filter(
      ([, content]) =>
        MEMBER_ACCESS_ACTION_PATTERN.test(content) &&
        !MEMBER_ACCESS_NOTE_PATTERN.test(content),
    )
    .map(
      ([path]) =>
        `code_review: ${path} appears to implement invite/remove access controls without explaining that real access is managed from the VoiceForge dashboard.`,
    );
}

function detectRelationValidationCollisions(
  source: readonly [string, string][],
): string[] {
  return source
    .filter(([, content]) => RELATION_VALUE_ERROR_COLLISION_PATTERN.test(content))
    .map(
      ([path]) =>
        `code_review: ${path} appears to store a required-field validation error in the related record id variable and then use it for membership validation. Rename the error to fieldNameError, preserve the selected id value, and test both a valid saved id and an unknown id.`,
    );
}

function detectAdvancedWorkflowUiCoverageIssues(
  spec: AppSpec,
  architecture: ArchitecturePlan,
  source: readonly [string, string][],
): string[] {
  if (!requiresStrictWorkflowCoverage(spec, architecture)) return [];

  const combinedSource = stripTypeOnlyIntegrationImports(combine(source));
  const snippets = interactiveSnippets(source).map(normalizeForSearch);
  const missingEntities = editableEntityTargets(spec, architecture)
    .map((target) => {
      const missing: string[] = [];
      if (!hasEntitySaveWiring(combinedSource, target)) {
        missing.push("save/update/delete wiring");
      }
      if (!hasInteractiveCoverage(snippets, target.terms)) {
        missing.push("visible create/edit controls");
      }
      return { ...target, missing };
    })
    .filter((target) => target.missing.length > 0);

  const missingWorkflows = workflowTargets(spec)
    .filter((target) => !hasInteractiveCoverage(snippets, target.terms))
    .map((target) => target.name);

  const issues: string[] = [];
  if (missingEntities.length > 0) {
    issues.push(
      `code_review: Advanced workflow coverage is incomplete; editable entities without complete visible controls/save wiring: ${formatCoverageList(
        missingEntities.map(
          (target) => `${target.name} (${target.missing.join(", ")})`,
        ),
      )}.`,
    );
  }
  if (missingWorkflows.length > 0) {
    issues.push(
      `code_review: Advanced workflow coverage is incomplete; planned workflows without visible action controls: ${formatCoverageList(
        missingWorkflows,
      )}.`,
    );
  }
  return uniqueStrings(issues);
}

function detectAdvancedWorkflowTestCoverageIssues(
  spec: AppSpec,
  architecture: ArchitecturePlan,
  testEntries: readonly [string, string | undefined][],
): string[] {
  if (!requiresStrictWorkflowCoverage(spec, architecture)) return [];

  const testText = normalizeForSearch(combine(testEntries));
  const issues: string[] = [];
  if (!testText.trim()) {
    return [
      "tests_review: Advanced app requires generated tests for each editable entity and planned workflow.",
    ];
  }

  const missingEntities = editableEntityTargets(spec, architecture)
    .filter((target) => !hasActionNearAnyTerm(testText, target.terms))
    .map((target) => target.name);
  const missingWorkflows = workflowTargets(spec)
    .filter((target) => !hasActionNearAnyTerm(testText, target.terms))
    .map((target) => target.name);

  if (missingEntities.length > 0) {
    issues.push(
      `tests_review: Advanced workflow test coverage is incomplete; missing generated tests for editable entities: ${formatCoverageList(
        missingEntities,
      )}.`,
    );
  }
  if (missingWorkflows.length > 0) {
    issues.push(
      `tests_review: Advanced workflow test coverage is incomplete; missing generated tests for planned workflows: ${formatCoverageList(
        missingWorkflows,
      )}.`,
    );
  }
  return uniqueStrings(issues);
}

function detectGoogleMapsImplementationIssues(
  spec: AppSpec,
  source: readonly [string, string][],
): string[] {
  if (!requiresGoogleMaps(spec)) return [];

  const sourceText = stripTypeOnlyIntegrationImports(combine(source));
  const issues: string[] = [];
  if (!hasGoogleMapsRuntimeUsage(sourceText)) {
    issues.push(
      "code_review: Google Maps integration was requested, but generated code only references Maps types or placeholders; call the locked Google Maps integration helpers at runtime.",
    );
  }
  if (
    requiresGoogleMapsRouting(spec) &&
    !hasGoogleMapsAction(sourceText, "computeGoogleMapsRoute", "compute_route")
  ) {
    issues.push(
      "code_review: Google Maps route planning was requested, but generated code does not call computeGoogleMapsRoute or the google_maps compute_route action.",
    );
  }
  if (
    requiresGoogleMapsPlaceSearch(spec) &&
    !hasGoogleMapsAction(sourceText, "searchGoogleMapsPlaces", "search_places") &&
    !GOOGLE_MAPS_AUTOCOMPLETE_PATTERN.test(sourceText)
  ) {
    issues.push(
      "code_review: Google Maps place search/autocomplete was requested, but generated code does not call searchGoogleMapsPlaces or render GooglePlaceAutocomplete.",
    );
  }
  if (
    requiresGoogleMapsPlaceSearch(spec) &&
    GOOGLE_MAPS_PLACE_SEARCH_PLACEHOLDER_LINK_PATTERN.test(sourceText)
  ) {
    issues.push(
      "code_review: Google Maps place search was represented as a navigation-only link to another map screen; implement an actual place search/save workflow where users search places.",
    );
  }
  if (
    requiresGoogleMapsElevation(spec) &&
    !hasGoogleMapsAction(
      sourceText,
      "getGoogleMapsElevationProfile",
      "get_elevation_profile",
    )
  ) {
    issues.push(
      "code_review: Google Maps elevation profiles were requested, but generated code does not call getGoogleMapsElevationProfile or the google_maps get_elevation_profile action.",
    );
  }
  if (
    requiresGoogleMapsRendering(spec) &&
    !GOOGLE_MAPS_MAP_COMPONENT_PATTERN.test(sourceText)
  ) {
    issues.push(
      "code_review: Interactive Google map rendering was requested, but generated code does not render the locked GoogleMapsTripMap component.",
    );
  }
  if (requiresBicycleRouting(spec) && !GOOGLE_MAPS_BICYCLE_PATTERN.test(sourceText)) {
    issues.push(
      "code_review: Bicycle routing was requested, but generated Google Maps route calls do not set travelMode:\"BICYCLE\".",
    );
  }
  return uniqueStrings(issues);
}

function requiresStrictWorkflowCoverage(
  spec: AppSpec,
  architecture: ArchitecturePlan,
): boolean {
  return (
    spec.capabilityTier === "advanced" ||
    architecture.implementationTier === "advanced"
  );
}

type EntityCoverageTarget = {
  name: string;
  key: string;
  aliases: string[];
  terms: string[];
  storage: ArchitecturePlan["dataModel"][number]["storage"];
};

function editableEntityTargets(
  spec: AppSpec,
  architecture: ArchitecturePlan,
): EntityCoverageTarget[] {
  const sourceLike = architecture.dataModel
    .map((entity) => `${entity.name}:${entity.storage}`)
    .join("\n");
  return spec.dataEntities
    .filter((entity) => isEditableEntity(spec, entity.name, entity.ownership))
    .flatMap((entity) => {
      const planned = architecture.dataModel.find(
        (plannedEntity) =>
          normalizeIdentifier(plannedEntity.name) === normalizeIdentifier(entity.name),
      );
      if (planned?.storage === "none" || planned?.storage === "future") return [];
      const schema = platformEntityFromSpec(entity, spec);
      return [{
        name: entity.name,
        key: schema.key,
        aliases: [camelCase(schema.key), ...entityAliasesForKey(sourceLike, schema.key)],
        terms: entityTerms(entity.name, schema.key),
        storage: planned?.storage ?? "platformData",
      }];
    });
}

function isEditableEntity(
  spec: AppSpec,
  entityName: string,
  ownership: AppSpec["dataEntities"][number]["ownership"],
): boolean {
  if (ownership === "system" || ownership === "public_read") return false;
  const matchingRules = spec.permissionRules.filter((rule) =>
    ruleTargetsEntity(rule.entity, entityName),
  );
  if (matchingRules.length === 0) return true;
  return matchingRules.some((rule) =>
    rule.actions.some((action) =>
      ["create", "update", "delete", "admin"].includes(action),
    ),
  );
}

function ruleTargetsEntity(ruleEntity: string, entityName: string): boolean {
  const rule = normalizeForSearch(ruleEntity);
  if (/\ball\b.*\b(saved|record|data|information)\b/.test(rule)) return true;
  const entity = normalizeForSearch(entityName);
  return rule.includes(entity) || entity.includes(rule);
}

function workflowTargets(
  spec: AppSpec,
): Array<{ name: string; terms: string[] }> {
  return spec.workflows
    .map((workflow) => {
      const text = [
        workflow.name,
        workflow.actor,
        workflow.trigger,
        workflow.successOutcome,
        ...workflow.steps,
      ].join(" ");
      return {
        name: workflow.name,
        text: normalizeForSearch(text),
        terms: workflowTerms(text),
      };
    })
    .filter((workflow) => workflow.terms.length > 0)
    .filter((workflow) => WRITE_ACTION_PATTERN.test(workflow.text))
    .map(({ name, terms }) => ({ name, terms }));
}

function hasPlatformEntityWriteCall(
  sourceText: string,
  target: { key: string; aliases: readonly string[] },
): boolean {
  const entityArgument = entityArgumentPattern(target);
  const pattern = new RegExp(
    `\\b(?:${PLATFORM_RECORD_WRITE_CALLS.join("|")})(?:\\s*<[^>()]+>)?\\s*\\(\\s*(?:${entityArgument})`,
  );
  return pattern.test(sourceText);
}

function hasEntitySaveWiring(
  sourceText: string,
  target: EntityCoverageTarget,
): boolean {
  if (target.storage === "platformData") {
    return (
      hasPlatformEntityWriteCall(sourceText, target) ||
      hasGenericEntityKeyedWriteWrapperCall(sourceText, target) ||
      hasNamedPlatformEntityWriteWrapper(sourceText, target)
    );
  }
  const normalizedSource = normalizeForSearch(sourceText);
  return (
    /\b(localStorage\.setItem|save[A-Za-z0-9_$]*|update[A-Za-z0-9_$]*|delete[A-Za-z0-9_$]*|set[A-Z][A-Za-z0-9_$]*)\b/.test(
      sourceText,
    ) && hasActionNearAnyTerm(normalizedSource, target.terms)
  );
}

function hasGenericEntityKeyedWriteWrapperCall(
  sourceText: string,
  target: EntityCoverageTarget,
): boolean {
  if (!usesAny(sourceText, PLATFORM_RECORD_WRITE_CALLS)) return false;
  const entityArgument = entityArgumentPattern(target);
  const pattern = new RegExp(
    `\\b[A-Za-z_$][\\w$]*(?:\\s*<[^>()]+>)?\\s*\\(\\s*(?:${entityArgument})`,
    "g",
  );
  return [...sourceText.matchAll(pattern)].some((match) =>
    WRITE_ACTION_FUNCTION_PATTERN.test(match[0].split("(")[0] ?? ""),
  );
}

function hasNamedPlatformEntityWriteWrapper(
  sourceText: string,
  target: EntityCoverageTarget,
): boolean {
  if (
    !/\b(?:createPlatformRecord|updatePlatformRecord|deletePlatformRecord)(?:\s*<[^>()]+>)?\s*\(/.test(
      sourceText,
    )
  ) {
    return false;
  }
  return entityWriteWrapperPatterns(target).some((pattern) =>
    pattern.test(sourceText),
  );
}

function entityWriteWrapperPatterns(target: EntityCoverageTarget): RegExp[] {
  const bases = uniqueStrings(
    [target.name, target.key, ...target.aliases]
      .map((value) => pascalCase(value))
      .filter(Boolean),
  );
  return bases.flatMap((base) => [
    new RegExp(
      `\\b(?:create|add|save|update|edit|delete|remove)${escapeRegExp(base)}(?:Record|Item|Entry)?\\s*\\(`,
      "i",
    ),
    new RegExp(
      `\\b(?:create|add|save|update|edit|delete|remove)${escapeRegExp(base)}(?:Record|Item|Entry)?\\s*=`,
      "i",
    ),
    new RegExp(
      `\\b(?:create|add|save|update|edit|delete|remove)${escapeRegExp(base)}(?:Record|Item|Entry)?\\s*:`,
      "i",
    ),
  ]);
}

function entityArgumentPattern(target: {
  key: string;
  aliases: readonly string[];
}): string {
  const directKey = `["'\`]${escapeRegExp(target.key)}["'\`]`;
  const aliases = uniqueStrings([...target.aliases])
    .filter(Boolean)
    .map(escapeRegExp);
  const keyedConstants = aliases.map(
    (alias) => `[A-Za-z_$][\\w$]*\\.${alias}`,
  );
  return [directKey, ...keyedConstants].join("|");
}

function hasInteractiveCoverage(
  snippets: readonly string[],
  terms: readonly string[],
): boolean {
  return snippets.some(
    (snippet) => WRITE_ACTION_PATTERN.test(snippet) && containsAnyTerm(snippet, terms),
  );
}

function hasActionNearAnyTerm(
  normalizedText: string,
  terms: readonly string[],
): boolean {
  for (const term of terms) {
    const normalizedTerm = normalizeForSearch(term);
    if (!normalizedTerm) continue;
    let index = normalizedText.indexOf(normalizedTerm);
    while (index >= 0) {
      const window = normalizedText.slice(
        Math.max(0, index - 120),
        index + normalizedTerm.length + 120,
      );
      if (WRITE_ACTION_PATTERN.test(window)) return true;
      index = normalizedText.indexOf(normalizedTerm, index + normalizedTerm.length);
    }
  }
  return false;
}

function containsAnyTerm(
  normalizedText: string,
  terms: readonly string[],
): boolean {
  return terms.some((term) => containsTerm(normalizedText, term));
}

function containsTerm(normalizedText: string, term: string): boolean {
  const normalizedTerm = normalizeForSearch(term);
  if (!normalizedTerm) return false;
  return new RegExp(`\\b${escapeRegExp(normalizedTerm).replace(/\s+/g, "\\s+")}\\b`).test(
    normalizedText,
  );
}

function entityTerms(name: string, key: string): string[] {
  const words = splitWords(name);
  const terms = new Set([words.join(" "), splitWords(key).join(" "), key]);
  const last = words.at(-1);
  if (last && !GENERIC_ENTITY_TERMS.has(last)) terms.add(last);
  const first = words[0];
  if (first && !GENERIC_ENTITY_TERMS.has(first)) terms.add(first);
  if (words.join(" ") === "end of day update") {
    terms.add("end of day");
    terms.add("check in");
    terms.add("check-in");
  }
  if (words.join(" ").includes("photo journal")) {
    terms.add("photo");
    terms.add("journal");
  }
  if (words.includes("photo")) {
    terms.add("image");
    terms.add("picture");
  }
  if (words.includes("gps") || (words.includes("track") && words.includes("session"))) {
    terms.add("gps");
    terms.add("track");
    terms.add("tracking");
    terms.add("ride tracking");
    terms.add("location tracking");
  }
  return uniqueStrings([...terms].filter(Boolean));
}

function workflowTerms(text: string): string[] {
  const words = splitWords(text).filter(
    (word) =>
      word.length > 2 &&
      !GENERIC_WORKFLOW_TERMS.has(word) &&
      !WRITE_ACTION_WORDS.includes(word as (typeof WRITE_ACTION_WORDS)[number]),
  );
  const terms = new Set<string>();
  for (const word of words) {
    terms.add(word);
    if (terms.size >= 6) break;
  }
  for (let index = 0; index < words.length - 1 && terms.size < 10; index++) {
    terms.add(`${words[index]} ${words[index + 1]}`);
  }
  return [...terms];
}

function interactiveSnippets(source: readonly [string, string][]): string[] {
  const snippets: string[] = [];
  const patterns = [
    /<form\b[\s\S]{0,5000}?<\/form>/gi,
    /<button\b[\s\S]{0,2500}?<\/button>/gi,
    /<PrimaryAction\b[\s\S]{0,2500}?(?:\/>|<\/PrimaryAction>)/gi,
    /<AddButton\b[\s\S]{0,2500}?(?:\/>|<\/AddButton>)/gi,
    /<PlatformFileUploadInput\b[\s\S]{0,2500}?(?:\/>|<\/PlatformFileUploadInput>)/gi,
    /<GooglePlaceAutocomplete\b[\s\S]{0,2500}?(?:\/>|<\/GooglePlaceAutocomplete>)/gi,
    /<GoogleMapsTripMap\b[\s\S]{0,2500}?(?:\/>|<\/GoogleMapsTripMap>)/gi,
  ];
  for (const [, content] of source) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        snippets.push(
          snippetWithContext(content, match.index ?? 0, match[0].length),
        );
      }
    }
  }
  return snippets;
}

function snippetWithContext(
  content: string,
  start: number,
  length: number,
): string {
  const before = Math.max(0, start - 700);
  const after = Math.min(content.length, start + length + 700);
  return content.slice(before, after);
}

function hasRuntimeIntegrationUsage(sourceText: string): boolean {
  return INTEGRATION_RUNTIME_CALL_PATTERN.test(
    stripTypeOnlyIntegrationImports(sourceText),
  );
}

function requiresGoogleMaps(spec: AppSpec): boolean {
  return spec.integrations.some((integration) =>
    /\bgoogle\s*maps\b/i.test(`${integration.name} ${integration.purpose}`),
  );
}

function requiresGoogleMapsRouting(spec: AppSpec): boolean {
  return /\b(route|routing|directions?|waypoints?|stops?|origin|destination)\b/.test(
    normalizedSpecText(spec),
  );
}

function requiresGoogleMapsPlaceSearch(spec: AppSpec): boolean {
  return /\b(place search|autocomplete|place|places|destination|origin|stop|stops|accommodation|attraction|restaurant|cafe|repair)\b/.test(
    normalizedSpecText(spec),
  );
}

function requiresGoogleMapsElevation(spec: AppSpec): boolean {
  return /\b(elevation|climb|descent|terrain)\b/.test(normalizedSpecText(spec));
}

function requiresGoogleMapsRendering(spec: AppSpec): boolean {
  return /\b(interactive map|map display|map view|map tiles?|route line|route overlay|pins?|bicycling map)\b/.test(
    normalizedSpecText(spec),
  );
}

function requiresBicycleRouting(spec: AppSpec): boolean {
  return /\b(bike|bicycle|bicycling|cycling|cyclist|ride|rider)\b/.test(
    normalizedSpecText(spec),
  );
}

function hasGoogleMapsRuntimeUsage(sourceText: string): boolean {
  return (
    GOOGLE_MAPS_RUNTIME_CALL_PATTERN.test(sourceText) ||
    GOOGLE_MAPS_INVOKE_PATTERN.test(sourceText)
  );
}

function hasGoogleMapsAction(
  sourceText: string,
  helperName: string,
  actionKey: string,
): boolean {
  const helperPattern = new RegExp(`\\b${escapeRegExp(helperName)}\\s*\\(`);
  return (
    helperPattern.test(sourceText) ||
    (sourceText.includes(`providerKey: "google_maps"`) &&
      sourceText.includes(`actionKey: "${actionKey}"`)) ||
    (sourceText.includes("providerKey: 'google_maps'") &&
      sourceText.includes(`actionKey: '${actionKey}'`))
  );
}

function normalizedSpecText(spec: AppSpec): string {
  return normalizeForSearch(
    [
      spec.purpose,
      spec.deploymentNotes,
      ...spec.features,
      ...spec.dataToStore,
      ...spec.testPlan,
      ...spec.privacyRequirements,
      ...spec.riskFlags,
      ...spec.workflows.flatMap((workflow) => [
        workflow.name,
        workflow.trigger,
        workflow.successOutcome,
        ...workflow.steps,
        ...workflow.failureStates,
      ]),
      ...spec.dataEntities.flatMap((entity) => [
        entity.name,
        entity.description,
        ...entity.fields.flatMap((field) => [
          field.name,
          field.label,
          field.validation,
        ]),
      ]),
      ...spec.integrations.flatMap((integration) => [
        integration.name,
        integration.purpose,
      ]),
      ...spec.reports.flatMap((report) => [
        report.name,
        report.description,
        ...report.dataNeeded,
        ...report.exportFormats,
      ]),
      ...spec.acceptanceCriteria.flatMap((criterion) => [
        criterion.name,
        criterion.scenario,
        criterion.given,
        criterion.when,
        criterion.then,
      ]),
      ...spec.testScenarios.flatMap((scenario) => [
        scenario.name,
        ...scenario.steps,
        scenario.expectedResult,
      ]),
    ].join(" "),
  );
}

function stripTypeOnlyIntegrationImports(content: string): string {
  return content.replace(
    /\b(?:import|export)\s+type\s+[\s\S]{0,300}?\s+from\s+["'][^"']*platform-integrations["'];?/g,
    "",
  );
}

function entityAliasesForKey(sourceText: string, key: string): string[] {
  const aliases = new Set<string>();
  const pattern = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*:\\s*["'\`]${escapeRegExp(key)}["'\`]`,
    "g",
  );
  for (const match of sourceText.matchAll(pattern)) {
    if (match[1]) aliases.add(match[1]);
  }
  return [...aliases];
}

function normalizeForSearch(value: string): string {
  return splitWords(value).join(" ");
}

function splitWords(value: string): string[] {
  return value
    .replace(/gpsride/gi, "gps ride")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(/\s+/)
    .map((word) => stemSearchWord(word.toLowerCase()))
    .filter(Boolean);
}

function stemSearchWord(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith("ing")) {
    let base = word.slice(0, -3);
    const last = base.at(-1);
    if (last && base.endsWith(`${last}${last}`)) base = base.slice(0, -1);
    if (base.endsWith("v")) return `${base}e`;
    return base;
  }
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function camelCase(value: string): string {
  const words = splitWords(value);
  return words
    .map((word, index) =>
      index === 0 ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join("");
}

function pascalCase(value: string): string {
  return splitWords(value)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("");
}

function normalizeIdentifier(value: string): string {
  return splitWords(value).join("");
}

function formatCoverageList(values: readonly string[]): string {
  const shown = values.slice(0, 8);
  const suffix = values.length > shown.length ? `, and ${values.length - shown.length} more` : "";
  return `${shown.join(", ")}${suffix}`;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
