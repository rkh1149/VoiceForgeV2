import type { ArchitecturePlan } from "../architecture";
import type { AppSpec } from "../spec";
import type { WorkflowContract } from "../workflow-contract";
import type { FailureFingerprint } from "./debug-progress";
import type { HumanCompletenessSourceContext } from "./human-completeness-review";
import type { FileMap } from "./template";
import {
  synthesizeWorkflowAcceptancePlan,
  type WorkflowAcceptanceJourney,
} from "./workflow-acceptance-plan";

export const WORKFLOW_REPAIR_PACKAGE_VERSION = 1 as const;

export type WorkflowRepairClassification =
  | "missing_control"
  | "missing_route_or_navigation"
  | "broken_save"
  | "broken_refresh_persistence"
  | "broken_workflow_handoff"
  | "wrong_platform_field_keys"
  | "incorrect_permissions"
  | "generated_test_defect"
  | "external_service_failure";

export type WorkflowRepairTargetSurface =
  | "application_source"
  | "generated_test"
  | "external_environment";

export type WorkflowRepairStatus =
  | "classified"
  | "candidate"
  | "focused_validated"
  | "accepted"
  | "rolled_back"
  | "external_retry";

export type WorkflowRepairValidationState = {
  staticReview: "pending" | "passed" | "failed" | "not_applicable";
  unit: "pending" | "passed" | "failed" | "not_applicable";
  browserJourney: "pending" | "passed" | "failed" | "not_applicable";
  fullGauntlet: "pending" | "passed" | "failed";
  targetResolved: boolean;
  unrelatedFindingsAdded: string[];
};

export type WorkflowRepairAttempt = {
  round: number;
  strategy: string;
  suspectedRootCause: string;
  filesInspected: string[];
  filesWritten: string[];
  filesDeleted: string[];
  outcome: "candidate" | "accepted" | "rolled_back" | "external_retry";
  reason: string;
};

export type WorkflowRepairPackage = {
  version: typeof WORKFLOW_REPAIR_PACKAGE_VERSION;
  id: string;
  status: WorkflowRepairStatus;
  createdAt: string;
  failedStep: string;
  repairDomain: string;
  classification: {
    category: WorkflowRepairClassification;
    subtype: string;
    targetSurface: WorkflowRepairTargetSurface;
    confidence: "high" | "medium" | "low";
    reasons: string[];
  };
  target: {
    kind: "workflow" | "control" | "step" | "save" | "handoff" | "journey";
    id: string;
    workflowId: string;
    workflowName: string;
    controlId: string;
    stepId: string;
    saveId: string;
    handoffId: string;
    journeyId: string;
  };
  promise: {
    statement: string;
    originalRequest: string;
    approvedSummary: string;
    roles: string[];
    startingRoute: string;
    startingScreen: string;
    destinationRoute: string;
    expectedControls: Array<{
      id: string;
      accessibleName: string;
      route: string;
    }>;
    visibleResult: string;
  };
  data: {
    entities: Array<{
      entityKey: string;
      entityName: string;
      fieldKeys: string[];
      operations: string[];
    }>;
    producerWorkflowIds: string[];
    consumerWorkflowIds: string[];
    handoffs: Array<{
      id: string;
      produces: string;
      consumerWorkflowId: string;
      consumerRoute: string;
      consumerControlId: string;
    }>;
  };
  evidence: {
    blockingIssues: string[];
    browserFailure: string;
    failureFingerprint?: FailureFingerprint;
    previousAttempts: string[];
  };
  scope: {
    inspectionPaths: string[];
    mutationPaths: string[];
    protectedPaths: string[];
    reason: string;
  };
  focusedValidation: {
    reviewDomain: string;
    unitTestFiles: string[];
    journeyId: string;
    e2eGrep: string;
    expectedConsumerRoute: string;
    expectedConsumerControl: string;
    expectedVisibleResult: string;
  };
  rollback: {
    checkpointId: string;
    checkpointStage: "reviewing" | "testing";
  } | null;
  baselineBlockingIssues: string[];
  validation: WorkflowRepairValidationState;
  attempts: WorkflowRepairAttempt[];
};

type ReviewLike = {
  agentKey: string;
  blockingIssues: string[];
};

export type CreateWorkflowRepairPackageInput = {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  files: FileMap;
  failedStep: string;
  errorOutput: string;
  repairDomain?: string;
  blockingIssues?: readonly string[];
  reviews?: readonly ReviewLike[];
  previousAttempts?: readonly string[];
  failureFingerprint?: FailureFingerprint;
  createdAt?: string;
  source?: HumanCompletenessSourceContext;
};

const LOCKED_REPAIR_PATHS = new Set([
  "src/app/globals.css",
  "src/lib/platform-data.ts",
  "src/lib/platform-files.ts",
  "src/lib/platform-notifications.ts",
  "src/lib/platform-integrations.ts",
  "src/lib/device-location.ts",
  "src/lib/voiceforge-modules.ts",
  "src/components/voiceforge-reusable.tsx",
  "src/components/voiceforge-google-map.tsx",
  "e2e/smoke.spec.ts",
  "e2e/voiceforge-acceptance.ts",
  "e2e/voiceforge-progress-reporter.ts",
]);

const WORKFLOW_MARKER = /\[voiceforge-workflow:([^\]]+)\]/i;
const CONTROL_MARKER = /\[voiceforge-control:([^\]]+)\]/i;
const STEP_MARKER = /\[voiceforge-step:([^\]]+)\]/i;
const SAVE_MARKER = /\[voiceforge-save:([^\]]+)\]/i;
const HANDOFF_MARKER = /\[voiceforge-handoff:([^\]]+)\]/i;
const JOURNEY_MARKER = /\[voiceforge-journey:([^\]]+)\]/i;

export function isWorkflowLinkedFailure(errorOutput: string): boolean {
  return (
    WORKFLOW_MARKER.test(errorOutput) ||
    CONTROL_MARKER.test(errorOutput) ||
    STEP_MARKER.test(errorOutput) ||
    SAVE_MARKER.test(errorOutput) ||
    HANDOFF_MARKER.test(errorOutput) ||
    JOURNEY_MARKER.test(errorOutput)
  );
}

export function selectWorkflowRepairIssueCluster(
  issues: readonly string[],
): string[] {
  const unique = uniqueStrings(issues);
  const first = unique[0];
  if (!first) return [];
  const workflowName = first.match(/Workflow\s+"([^"]+)"/i)?.[1];
  if (workflowName) {
    const cluster = unique.filter((issue) =>
      issue.includes(`Workflow "${workflowName}"`),
    );
    if (cluster.length > 0) return cluster;
  }
  const workflowId = first.match(/\(([a-z0-9][a-z0-9-]+)\)/i)?.[1];
  if (workflowId) {
    const cluster = unique.filter((issue) => issue.includes(workflowId));
    if (cluster.length > 0) return cluster;
  }
  const boundWorkflowId = first.match(
    /\[voiceforge-workflow:([a-z0-9][a-z0-9-]+)\]/i,
  )?.[1];
  if (boundWorkflowId) {
    const marker = `[voiceforge-workflow:${boundWorkflowId}]`;
    const cluster = unique.filter((issue) => issue.includes(marker));
    if (cluster.length > 0) return cluster;
  }
  const journeyId = first.match(/Journey\s+([a-z0-9][a-z0-9-]+)/i)?.[1];
  if (journeyId) {
    const cluster = unique.filter((issue) => issue.includes(journeyId));
    if (cluster.length > 0) return cluster;
  }
  const handoffId = first.match(/Handoff\s+([a-z0-9][a-z0-9-]+)/i)?.[1];
  if (handoffId) {
    const cluster = unique.filter((issue) => issue.includes(handoffId));
    if (cluster.length > 0) return cluster;
  }
  return [first];
}

export function createWorkflowRepairPackage(
  input: CreateWorkflowRepairPackageInput,
): WorkflowRepairPackage {
  const plan = synthesizeWorkflowAcceptancePlan(input.spec, input.architecture);
  const blockingIssues = uniqueStrings([
    ...(input.blockingIssues ?? []),
    ...(input.reviews ?? []).flatMap((review) => review.blockingIssues),
  ]);
  const failedTestEvidence = input.failureFingerprint?.failedTests.join("\n") ?? "";
  const focusedReviewEvidence = input.errorOutput.split(
    /\n\nSTRUCTURED (?:REVIEW|PRODUCT COMPLETENESS) EVIDENCE:/,
    1,
  )[0];
  const markerEvidence = failedTestEvidence || focusedReviewEvidence;
  const markers = extractMarkers(markerEvidence);
  let journey = findJourney(plan.journeys, markers, markerEvidence);
  const workflow = findWorkflow({
    contracts: input.architecture.workflowContracts,
    markers,
    journey,
    text: failedTestEvidence ||
      [input.errorOutput, ...(input.blockingIssues ?? [])].join("\n"),
  });
  if (!journey && workflow) {
    journey = plan.journeys.find((candidate) =>
      candidate.workflowIds.includes(workflow.id),
    );
  }
  const handoff = findHandoff(
    input.architecture.workflowContracts,
    markers.handoffId,
    markerEvidence,
  );
  const producer =
    handoff?.producer ?? workflow ?? input.architecture.workflowContracts[0];
  const consumer = handoff
    ? input.architecture.workflowContracts.find(
        (contract) => contract.id === handoff.handoff.consumerWorkflowId,
      )
    : undefined;
  const classification = classifyWorkflowRepairFailure({
    failedStep: input.failedStep,
    errorOutput: input.errorOutput,
    blockingIssues: input.blockingIssues,
    reviews: input.reviews ?? [],
    hasGeneratedJourney: Boolean(journey),
  });
  const target = createTarget({
    markers,
    journey,
    workflow: producer,
    handoffId: handoff?.handoff.id ?? "",
  });
  const relatedContracts = uniqueContracts([
    producer,
    consumer,
    ...(journey?.workflowIds.map((id) =>
      input.architecture.workflowContracts.find(
        (contract) => contract.id === id,
      ),
    ) ?? []),
  ]);
  const scope = deriveWorkflowRepairScope({
    files: input.files,
    contracts: relatedContracts,
    journey,
    classification: classification.category,
    targetSurface: classification.targetSurface,
    errorOutput: input.errorOutput,
    blockingIssues,
  });
  const expectedHandoffs = uniqueHandoffs(
    relatedContracts.flatMap((contract) => contract.handoffs),
  );
  const expectedConsumerRoute =
    handoff?.handoff.consumerRoute ?? consumer?.start.route ?? "";
  const expectedConsumerControl = handoff
    ? consumer?.controls.find(
        (control) => control.id === handoff.handoff.consumerControlId,
      )?.accessibleName ?? ""
    : "";
  const promiseStatement =
    producer?.source.acceptanceCriteria[0] ||
    producer?.success.visibleResult ||
    producer?.name ||
    input.spec.purpose;
  const reviewDomain =
    input.repairDomain || reviewDomainForClassification(classification.category);

  return {
    version: WORKFLOW_REPAIR_PACKAGE_VERSION,
    id: journey
      ? `workflow-repair-journey-${slugify(journey.id)}`
      : `workflow-repair-${slugify(target.kind)}-${slugify(target.id || "unknown")}`,
    status:
      classification.targetSurface === "external_environment"
        ? "external_retry"
        : "classified",
    createdAt: input.createdAt ?? new Date().toISOString(),
    failedStep: input.failedStep,
    repairDomain: reviewDomain,
    classification,
    target,
    promise: {
      statement: promiseStatement,
      originalRequest: tail(input.source?.userMessages.join("\n\n") ?? "", 4_000),
      approvedSummary: input.source?.approvedSummary ?? "",
      roles: producer?.actor.roles ?? [],
      startingRoute: producer?.start.route ?? journey?.startRoute ?? "/",
      startingScreen: producer?.start.screen ?? producer?.name ?? "App",
      destinationRoute:
        expectedConsumerRoute || producer?.success.route || journey?.startRoute || "/",
      expectedControls:
        producer?.controls.map((control) => ({
          id: control.id,
          accessibleName: control.accessibleName,
          route: control.route,
        })) ?? [],
      visibleResult: producer?.success.visibleResult ?? "Workflow succeeds visibly.",
    },
    data: {
      entities: collectEntities(relatedContracts),
      producerWorkflowIds: producer ? [producer.id] : [],
      consumerWorkflowIds: uniqueStrings([
        ...(consumer ? [consumer.id] : []),
        ...expectedHandoffs.map((candidate) => candidate.consumerWorkflowId),
      ]),
      handoffs: expectedHandoffs.map((candidate) => ({
        id: candidate.id,
        produces: candidate.produces,
        consumerWorkflowId: candidate.consumerWorkflowId,
        consumerRoute: candidate.consumerRoute,
        consumerControlId: candidate.consumerControlId,
      })),
    },
    evidence: {
      blockingIssues: [...(input.blockingIssues ?? [])],
      browserFailure: tail(input.errorOutput, 8_000),
      failureFingerprint: input.failureFingerprint,
      previousAttempts: [...(input.previousAttempts ?? [])],
    },
    scope,
    focusedValidation: {
      reviewDomain,
      unitTestFiles: scope.inspectionPaths.filter(isUnitTestPath),
      journeyId: journey?.id ?? "",
      e2eGrep: journey ? `voiceforge-journey:${journey.id}` : "",
      expectedConsumerRoute,
      expectedConsumerControl,
      expectedVisibleResult: producer?.success.visibleResult ?? "",
    },
    rollback: null,
    baselineBlockingIssues: blockingIssues,
    validation: {
      staticReview:
        input.failedStep === "review_gate" ? "pending" : "not_applicable",
      unit: "pending",
      browserJourney: journey ? "pending" : "not_applicable",
      fullGauntlet: "pending",
      targetResolved: false,
      unrelatedFindingsAdded: [],
    },
    attempts: [],
  };
}

export function classifyWorkflowRepairFailure(input: {
  failedStep: string;
  errorOutput: string;
  blockingIssues?: readonly string[];
  reviews?: readonly ReviewLike[];
  hasGeneratedJourney?: boolean;
}): WorkflowRepairPackage["classification"] {
  const text = [input.errorOutput, ...(input.blockingIssues ?? [])].join("\n");
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  const result = (
    category: WorkflowRepairClassification,
    subtype: string,
    targetSurface: WorkflowRepairTargetSurface,
    confidence: "high" | "medium" | "low",
    reason: string,
  ): WorkflowRepairPackage["classification"] => ({
    category,
    subtype,
    targetSurface,
    confidence,
    reasons: uniqueStrings([...reasons, reason]),
  });

  if (
    /\b(?:http\s*)?(?:429|502|503)\b|rate limit|quota exceeded|service unavailable|temporarily unavailable|external service/i.test(
      text,
    )
  ) {
    return result(
      "external_service_failure",
      /429|rate limit|quota/i.test(text) ? "rate_limit_or_quota" : "provider_unavailable",
      "external_environment",
      "high",
      "The failure reports an external provider or quota response; generated source should remain unchanged.",
    );
  }
  if (/\bacceptance_test:/i.test(text)) {
    const subtype = /acceptance_test:save/i.test(text)
      ? "missing_persistence_trace"
      : /acceptance_test:handoff/i.test(text)
        ? "missing_handoff_trace"
        : /acceptance_test:step/i.test(text)
          ? "missing_contract_step_trace"
          : /acceptance_test:role/i.test(text)
            ? "missing_role_trace"
            : "static_acceptance_trace";
    return result(
      "generated_test_defect",
      subtype,
      "generated_test",
      "high",
      "A deterministic acceptance-test finding identifies missing or unrecognized proof in the generated Playwright journey.",
    );
  }
  if (/\bcontract_control:/i.test(text)) {
    return result(
      "missing_control",
      /duplicate|appears on \d+ unscoped controls/i.test(text)
        ? "duplicate_contract_binding"
        : /non-interactive|wrong route|rendered on/i.test(text)
          ? "misplaced_contract_binding"
          : "missing_or_invalid_contract_binding",
      "application_source",
      "high",
      "The stable control gate identified an exact workflow/control identity that is missing, duplicated, or attached to the wrong interface element.",
    );
  }
  const staticBlockers = (input.reviews ?? []).flatMap(
    (review) => review.blockingIssues,
  );
  const generatedTestPathOnly =
    /e2e\/generated\//i.test(text) &&
    !/\bsrc\/(?:app|components|lib)\//i.test(text);
  if (
    input.failedStep === "e2e" &&
    input.hasGeneratedJourney &&
    staticBlockers.length === 0 &&
    (generatedTestPathOnly || /expect\(locator\)|locator\.|strict mode violation|toBeVisible|toHaveURL/i.test(text))
  ) {
    const subtype = /localstorage|sessionstorage|fresh browser context|describe\.serial/i.test(lower)
      ? "test_isolation"
      : /mark as watched|delete|remove|archive|complete|finish|state.*clear/i.test(lower)
        ? "state_capture_after_clearing_action"
        : /selectoption|option.*not found|prerequisite|no routes|no records/i.test(lower)
          ? "missing_test_prerequisite"
          : /navigation|tohaveurl|page\.reload/i.test(lower)
            ? "test_navigation_race"
            : "locator_or_assertion_defect";
    return result(
      "generated_test_defect",
      subtype,
      "generated_test",
      "high",
      "The contracted browser journey failed while deterministic application workflow reviews had no blockers.",
    );
  }
  if (/persistence_handoff:schema|record data failed validation|unknown field|exact (?:entity|field) key/i.test(text)) {
    return result(
      "wrong_platform_field_keys",
      "schema_or_payload_key_mismatch",
      "application_source",
      "high",
      "The persistence evidence identifies an entity or field-key mismatch.",
    );
  }
  if (/persistence_handoff:handoff|voiceforge-handoff|consumer.*(?:load|select|display)|producer.*consumer/i.test(text)) {
    return result(
      "broken_workflow_handoff",
      "producer_consumer_disconnect",
      "application_source",
      "high",
      "The failed evidence names a saved output that does not reach its consumer workflow.",
    );
  }
  if (/persistence_handoff:reload|fresh (?:screen|entry|mount)|after refresh|persists after reload/i.test(text)) {
    return result(
      "broken_refresh_persistence",
      "saved_record_not_reloaded",
      "application_source",
      "high",
      "The failure is specifically about reloading a durable record after mount or refresh.",
    );
  }
  if (/persistence_handoff:save|durable write|save operation|failed save/i.test(text)) {
    return result(
      "broken_save",
      "write_path_or_saved_reference",
      "application_source",
      "high",
      "The workflow save operation or returned durable reference is missing or broken.",
    );
  }
  if (/\b(?:owner|editor|viewer|public)\b.*\b(?:permission|read-only|control)|voiceforge-role|canwrite|incorrect permissions/i.test(text)) {
    return result(
      "incorrect_permissions",
      "role_control_or_write_guard",
      "application_source",
      "high",
      "The failure concerns role-specific visibility or write access.",
    );
  }
  if (/ui_affordance:.*(?:does not exist|cannot reach|not reachable|target .* does not match)|missing route|hidden url|navigation/i.test(text)) {
    return result(
      "missing_route_or_navigation",
      "route_missing_or_unreachable",
      "application_source",
      "high",
      "The interface review identifies a missing route or visible navigation path.",
    );
  }
  if (/ui_affordance:|missing.*(?:button|link|form|control)|no discoverable|visible control/i.test(text)) {
    return result(
      "missing_control",
      "workflow_action_not_discoverable",
      "application_source",
      "high",
      "The workflow cannot be started or completed through a visible control.",
    );
  }

  if (input.failedStep === "e2e" && input.hasGeneratedJourney) {
    return result(
      "generated_test_defect",
      "browser_journey_requires_diagnosis",
      "generated_test",
      "medium",
      "The failure is isolated to a generated contract journey, but its assertion and application behavior must be inspected together.",
    );
  }

  return result(
    "missing_control",
    "workflow_failure_requires_diagnosis",
    "application_source",
    "low",
    "The failure is workflow-linked but does not yet match a more specific deterministic category.",
  );
}

export function validateWorkflowRepairMutationScope(input: {
  repair: WorkflowRepairPackage;
  filesWritten: readonly string[];
  filesDeleted?: readonly string[];
}): { ok: boolean; outOfScopePaths: string[]; reason: string } {
  const allowed = new Set(input.repair.scope.mutationPaths);
  const changed = uniqueStrings([
    ...input.filesWritten,
    ...(input.filesDeleted ?? []),
  ]);
  const outOfScopePaths = changed.filter((path) => !allowed.has(path));
  return {
    ok: outOfScopePaths.length === 0,
    outOfScopePaths,
    reason:
      outOfScopePaths.length === 0
        ? `All ${changed.length} changed file(s) are inside the workflow repair scope.`
        : `Repair attempted to change protected file(s): ${outOfScopePaths.join(", ")}.`,
  };
}

export function assessWorkflowRepairCandidate(input: {
  repair: WorkflowRepairPackage;
  currentBlockingIssues: readonly string[];
}): {
  accepted: boolean;
  improved: boolean;
  targetResolved: boolean;
  targetIssuesRemaining: string[];
  unrelatedFindingsAdded: string[];
  reason: string;
} {
  const baseline = new Set(input.repair.baselineBlockingIssues);
  const current = uniqueStrings([...input.currentBlockingIssues]);
  const targetIssuesRemaining = current.filter((issue) =>
    issueMatchesTargetEvidence(issue, input.repair.evidence.blockingIssues),
  );
  const unrelatedFindingsAdded = current.filter(
    (issue) =>
      !baseline.has(issue) &&
      !issueMatchesTargetEvidence(issue, input.repair.evidence.blockingIssues),
  );
  const targetIssues = input.repair.evidence.blockingIssues;
  const targetResolved = targetIssuesRemaining.length === 0;
  const improved =
    !targetResolved &&
    targetIssuesRemaining.length < targetIssues.length &&
    unrelatedFindingsAdded.length === 0;
  const accepted = targetResolved && unrelatedFindingsAdded.length === 0;
  return {
    accepted,
    improved,
    targetResolved,
    targetIssuesRemaining,
    unrelatedFindingsAdded,
    reason: accepted
      ? "The named workflow finding is resolved and no unrelated workflow findings were added."
      : improved
        ? `The named workflow findings improved from ${targetIssues.length} to ${targetIssuesRemaining.length}; continue from this candidate.`
        : !targetResolved && unrelatedFindingsAdded.length === 0
          ? `The named workflow findings did not improve (${targetIssues.length} -> ${targetIssuesRemaining.length}).`
        : `The candidate added unrelated workflow finding(s): ${unrelatedFindingsAdded.join(" ")}`,
  };
}

function issueMatchesTargetEvidence(
  issue: string,
  targetIssues: readonly string[],
): boolean {
  return targetIssues.some((target) => {
    if (target === issue) return true;
    const targetIdentity = reviewIssueIdentity(target);
    const issueIdentity = reviewIssueIdentity(issue);
    return Boolean(
      targetIdentity &&
        issueIdentity &&
        targetIdentity === issueIdentity,
    );
  });
}

function reviewIssueIdentity(issue: string): string {
  const category = issue.match(/^([a-z_]+:[a-z_]+)/i)?.[1]?.toLowerCase() ?? "";
  if (!category) return "";
  const bracketMarkers = [
    ...issue.matchAll(
      /\[voiceforge-(workflow|control|step|save|handoff|journey):([^\]]+)\]/gi,
    ),
  ].map((match) => `${match[1].toLowerCase()}:${match[2].toLowerCase()}`);
  if (bracketMarkers.length > 0) {
    return `${category}|${bracketMarkers.join("|")}`;
  }
  const handoffOrSaveProof = issue.match(
    /\b(?:(?:downstream|persistence|reload) proof|saved result for)\s+([a-z0-9][a-z0-9:_-]*)/i,
  )?.[1];
  if (handoffOrSaveProof) {
    return `${category}|proof:${handoffOrSaveProof.toLowerCase()}`;
  }
  const journeyId = issue.match(
    /\bJourney\s+([a-z0-9][a-z0-9-]*)/i,
  )?.[1];
  const stepId = issue.match(
    /\bstep\s+([a-z0-9][a-z0-9-]*)/i,
  )?.[1];
  if (journeyId && stepId) {
    return `${category}|journey:${journeyId.toLowerCase()}|step:${stepId.toLowerCase()}`;
  }
  if (journeyId) return `${category}|journey:${journeyId.toLowerCase()}`;
  const workflow = issue.match(
    /\bWorkflow\s+"([^"]+)"(?:\s+\(([a-z0-9][a-z0-9-]+)\))?/i,
  );
  if (workflow) {
    return `${category}|workflow:${(workflow[2] || workflow[1]).toLowerCase()}`;
  }
  return issue
    .replace(/((?:src|e2e)\/[A-Za-z0-9_./@-]+):\d+/g, "$1:<line>")
    .toLowerCase();
}

export function restoreWorkflowRepairPackages(
  value: unknown,
): WorkflowRepairPackage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isWorkflowRepairPackage);
}

export function workflowRepairAgentContext(
  repair: WorkflowRepairPackage,
): string {
  return JSON.stringify(
    {
      id: repair.id,
      classification: repair.classification,
      target: repair.target,
      promise: repair.promise,
      data: repair.data,
      evidence: repair.evidence,
      scope: {
        inspectionPaths: repair.scope.inspectionPaths,
        mutationPaths: repair.scope.mutationPaths,
        protectedFileCount: repair.scope.protectedPaths.length,
        reason: repair.scope.reason,
      },
      focusedValidation: repair.focusedValidation,
      previousAttempts: repair.attempts,
    },
    null,
    2,
  );
}

function deriveWorkflowRepairScope(input: {
  files: FileMap;
  contracts: WorkflowContract[];
  journey: WorkflowAcceptanceJourney | undefined;
  classification: WorkflowRepairClassification;
  targetSurface: WorkflowRepairTargetSurface;
  errorOutput: string;
  blockingIssues: string[];
}): WorkflowRepairPackage["scope"] {
  const allPaths = Object.keys(input.files).sort();
  const allGeneratedE2ePaths = allPaths.filter((path) =>
    /^e2e\/generated\/.+\.spec\.tsx?$/.test(path),
  );
  const matchedE2ePaths = allGeneratedE2ePaths.filter(
    (path) =>
      (!input.journey ||
        input.files[path]?.includes(`workflowJourneyTitle("${input.journey.id}"`) ||
        input.files[path]?.includes(`workflowJourneyTitle('${input.journey.id}'`) ||
        input.files[path]?.includes(`[voiceforge-journey:${input.journey.id}]`)),
  );
  const e2ePaths =
    matchedE2ePaths.length > 0 ? matchedE2ePaths : allGeneratedE2ePaths;
  const routePaths = uniqueStrings(
    input.contracts.flatMap((contract) =>
      uniqueStrings([
        contract.start.route,
        contract.success.route,
        ...contract.controls.map((control) => control.route),
        ...contract.steps.map((step) => step.route),
        ...contract.handoffs.map((handoff) => handoff.consumerRoute),
      ]).map(routeToPagePath),
    ),
  );
  const tokens = uniqueStrings(
    input.contracts.flatMap((contract) => [
      contract.id,
      contract.name,
      ...contract.controls.map((control) => control.accessibleName),
      ...contract.controls.map((control) => control.id),
      ...contract.requiredData.map((data) => data.entityKey),
      ...contract.expectedSaves.flatMap((save) => [
        save.entityKey,
        ...save.fieldKeys,
      ]),
      ...contract.handoffs.flatMap((handoff) => [
        handoff.id,
        handoff.produces,
        handoff.consumerControlId,
      ]),
    ]),
  ).filter((token) => token.length >= 3);
  const mentionedPaths = extractSourcePaths(
    `${input.errorOutput}\n${input.blockingIssues.join("\n")}`,
  );
  const sourceMatches = allPaths.filter((path) => {
    if (!/^src\/(?:app|components|lib)\/.+\.(?:ts|tsx)$/.test(path)) {
      return false;
    }
    if (LOCKED_REPAIR_PATHS.has(path)) return false;
    const source = input.files[path] ?? "";
    const matchCount = tokens.reduce(
      (count, token) => count + (containsLoose(source, token) ? 1 : 0),
      0,
    );
    return matchCount >= 2;
  });
  const navigationMatches = allPaths.filter((path) => {
    if (!/^src\/(?:app|components)\/.+\.tsx$/.test(path)) return false;
    if (LOCKED_REPAIR_PATHS.has(path)) return false;
    const source = input.files[path] ?? "";
    return (
      /<(?:nav|header)\b|\bhref\s*=|\brouter\.(?:push|replace)\s*\(/.test(
        source,
      ) &&
      input.contracts.some((contract) =>
        [contract.start.route, contract.success.route].some((route) =>
          source.includes(route),
        ),
      )
    );
  });
  const permissionMatches =
    input.classification === "incorrect_permissions"
      ? allPaths.filter(
          (path) =>
            /^src\/(?:app|components|lib)\/.+\.(?:ts|tsx)$/.test(path) &&
            !LOCKED_REPAIR_PATHS.has(path) &&
            /\b(?:canWrite|owner|editor|viewer|permission|role|session)\b/i.test(
              input.files[path] ?? "",
            ),
        )
      : [];
  const unitTests = allPaths.filter(
    (path) =>
      isUnitTestPath(path) &&
      tokens.some((token) => containsLoose(input.files[path] ?? "", token)),
  );
  const availableRoutePaths = routePaths.filter((path) => path in input.files);
  const missingRoutePaths = routePaths.filter((path) => !(path in input.files));
  const appMutationPaths = uniqueStrings([
    ...mentionedPaths,
    ...availableRoutePaths,
    ...sourceMatches,
    ...navigationMatches,
    ...permissionMatches,
    ...unitTests,
    ...e2ePaths,
    ...(input.classification === "missing_route_or_navigation"
      ? missingRoutePaths
      : []),
  ]).filter((path) => !LOCKED_REPAIR_PATHS.has(path));
  const mutationPaths =
    input.targetSurface === "external_environment"
      ? []
      : input.targetSurface === "generated_test"
        ? e2ePaths
        : appMutationPaths.slice(0, 24);
  const inspectionPaths = uniqueStrings([
    ...mutationPaths,
    ...availableRoutePaths,
    ...sourceMatches,
    ...unitTests,
    ...e2ePaths,
    ...allPaths.filter((path) =>
      LOCKED_REPAIR_PATHS.has(path) &&
      input.contracts.some((contract) =>
        contract.dependencies.platformServices.some((service) =>
          lockedPathMatchesService(path, service),
        ),
      ),
    ),
  ]).slice(0, 36);
  const protectedPaths = allPaths.filter((path) => !mutationPaths.includes(path));

  return {
    inspectionPaths,
    mutationPaths,
    protectedPaths,
    reason:
      input.targetSurface === "generated_test"
        ? "Deterministic workflow reviews passed, so only the generated journey that failed may change."
        : input.targetSurface === "external_environment"
          ? "External provider failures are retried and reported without editing generated source."
          : `Scope follows ${input.contracts.length} connected workflow contract(s), their routes, saved entities, consumer handoffs, and targeted tests.`,
  };
}

function findJourney(
  journeys: WorkflowAcceptanceJourney[],
  markers: ReturnType<typeof extractMarkers>,
  text: string,
): WorkflowAcceptanceJourney | undefined {
  return (
    journeys.find((journey) => journey.id === markers.journeyId) ??
    journeys.find((journey) =>
      markers.workflowId
        ? journey.workflowIds.includes(markers.workflowId)
        : false,
    ) ??
    journeys.find((journey) => text.includes(journey.id))
  );
}

function findWorkflow(input: {
  contracts: WorkflowContract[];
  markers: ReturnType<typeof extractMarkers>;
  journey: WorkflowAcceptanceJourney | undefined;
  text: string;
}): WorkflowContract | undefined {
  const completenessWorkflowId = input.text.match(
    /human_completeness:workflow:([a-z0-9][a-z0-9-]*)/i,
  )?.[1];
  return (
    input.contracts.find(
      (contract) => contract.id === completenessWorkflowId,
    ) ??
    input.contracts.find(
      (contract) => contract.id === input.markers.workflowId,
    ) ??
    input.contracts.find((contract) =>
      input.markers.controlId
        ? contract.controls.some(
            (control) => control.id === input.markers.controlId,
          )
        : false,
    ) ??
    input.contracts.find((contract) =>
      input.markers.stepId
        ? contract.steps.some((step) => step.id === input.markers.stepId)
        : false,
    ) ??
    input.contracts.find((contract) =>
      input.markers.saveId
        ? input.markers.saveId.startsWith(`${contract.id}:`)
        : false,
    ) ??
    input.contracts.find(
      (contract) =>
        input.text.includes(`(${contract.id})`) ||
        input.text.includes(`"${contract.name}"`) ||
        input.text.includes(contract.name),
    ) ??
    input.contracts.find((contract) =>
      contract.requiredData.some(
        (entity) =>
          containsLoose(input.text, entity.entityKey) ||
          containsLoose(input.text, entity.entityName),
      ),
    ) ??
    input.contracts.find((contract) =>
      uniqueStrings([
        contract.start.route,
        contract.success.route,
        ...contract.controls.map((control) => control.route),
        ...contract.steps.map((step) => step.route),
      ]).some(
        (route) => route !== "/" && input.text.includes(route),
      ),
    ) ??
    input.contracts.find(
      (contract) => contract.id === input.journey?.workflowIds[0],
    )
  );
}

function findHandoff(
  contracts: WorkflowContract[],
  handoffId: string,
  text: string,
):
  | {
      producer: WorkflowContract;
      handoff: WorkflowContract["handoffs"][number];
    }
  | undefined {
  for (const producer of contracts) {
    const handoff = producer.handoffs.find(
      (candidate) =>
        candidate.id === handoffId ||
        (candidate.id.length > 0 && text.includes(candidate.id)),
    );
    if (handoff) return { producer, handoff };
  }
  return undefined;
}

function createTarget(input: {
  markers: ReturnType<typeof extractMarkers>;
  journey: WorkflowAcceptanceJourney | undefined;
  workflow: WorkflowContract | undefined;
  handoffId: string;
}): WorkflowRepairPackage["target"] {
  const kind = input.handoffId
    ? "handoff"
    : input.markers.saveId
      ? "save"
      : input.markers.stepId
        ? "step"
        : input.markers.controlId
          ? "control"
        : input.markers.journeyId
          ? "journey"
          : "workflow";
  const id =
    input.handoffId ||
    input.markers.saveId ||
    input.markers.stepId ||
    input.markers.controlId ||
    input.markers.journeyId ||
    input.workflow?.id ||
    "unknown-workflow";
  return {
    kind,
    id,
    workflowId: input.markers.workflowId || input.workflow?.id || "",
    workflowName: input.workflow?.name || input.journey?.name || "Workflow",
    controlId: input.markers.controlId,
    stepId: input.markers.stepId,
    saveId: input.markers.saveId,
    handoffId: input.handoffId,
    journeyId: input.journey?.id ?? input.markers.journeyId,
  };
}

function extractMarkers(text: string) {
  return {
    workflowId: text.match(WORKFLOW_MARKER)?.[1] ?? "",
    controlId: text.match(CONTROL_MARKER)?.[1] ?? "",
    stepId: text.match(STEP_MARKER)?.[1] ?? "",
    saveId: text.match(SAVE_MARKER)?.[1] ?? "",
    handoffId: text.match(HANDOFF_MARKER)?.[1] ?? "",
    journeyId: text.match(JOURNEY_MARKER)?.[1] ?? "",
  };
}

function collectEntities(contracts: WorkflowContract[]) {
  const byKey = new Map<
    string,
    {
      entityKey: string;
      entityName: string;
      fieldKeys: Set<string>;
      operations: Set<string>;
    }
  >();
  for (const contract of contracts) {
    for (const data of contract.requiredData) {
      const existing = byKey.get(data.entityKey) ?? {
        entityKey: data.entityKey,
        entityName: data.entityName,
        fieldKeys: new Set<string>(),
        operations: new Set<string>(),
      };
      data.requiredFieldKeys.forEach((field) => existing.fieldKeys.add(field));
      data.operations.forEach((operation) => existing.operations.add(operation));
      byKey.set(data.entityKey, existing);
    }
    for (const save of contract.expectedSaves) {
      const existing = byKey.get(save.entityKey) ?? {
        entityKey: save.entityKey,
        entityName: save.entityName,
        fieldKeys: new Set<string>(),
        operations: new Set<string>(),
      };
      save.fieldKeys.forEach((field) => existing.fieldKeys.add(field));
      existing.operations.add(save.operation);
      byKey.set(save.entityKey, existing);
    }
  }
  return [...byKey.values()].map((entity) => ({
    entityKey: entity.entityKey,
    entityName: entity.entityName,
    fieldKeys: [...entity.fieldKeys].sort(),
    operations: [...entity.operations].sort(),
  }));
}

function uniqueContracts(
  values: Array<WorkflowContract | undefined>,
): WorkflowContract[] {
  const byId = new Map<string, WorkflowContract>();
  values.forEach((value) => {
    if (value) byId.set(value.id, value);
  });
  return [...byId.values()];
}

function uniqueHandoffs(values: WorkflowContract["handoffs"]) {
  const byId = new Map<string, WorkflowContract["handoffs"][number]>();
  values.forEach((value) => byId.set(value.id, value));
  return [...byId.values()];
}

function routeToPagePath(route: string): string {
  const clean = route.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "");
  return clean ? `src/app/${clean}/page.tsx` : "src/app/page.tsx";
}

function extractSourcePaths(text: string): string[] {
  return uniqueStrings(
    [...text.matchAll(/\b((?:src|e2e)\/[A-Za-z0-9_./@-]+\.(?:tsx?|jsx?))/g)].map(
      (match) => match[1],
    ),
  );
}

function lockedPathMatchesService(path: string, service: string): boolean {
  if (service === "data") return path.endsWith("platform-data.ts");
  if (service === "files") return path.endsWith("platform-files.ts");
  if (service === "email" || service === "jobs") {
    return path.endsWith("platform-notifications.ts");
  }
  if (service === "integrations") {
    return path.endsWith("platform-integrations.ts");
  }
  if (service === "device_location") return path.endsWith("device-location.ts");
  return false;
}

function reviewDomainForClassification(
  classification: WorkflowRepairClassification,
): string {
  if (
    classification === "missing_control" ||
    classification === "missing_route_or_navigation"
  ) {
    return "interface";
  }
  if (
    classification === "broken_save" ||
    classification === "broken_refresh_persistence" ||
    classification === "broken_workflow_handoff" ||
    classification === "wrong_platform_field_keys"
  ) {
    return "persistence";
  }
  if (classification === "generated_test_defect") return "acceptance";
  if (classification === "incorrect_permissions") return "implementation";
  return "external";
}

function isUnitTestPath(path: string): boolean {
  return /^src\/.+\.test\.tsx?$/.test(path);
}

function isWorkflowRepairPackage(value: unknown): value is WorkflowRepairPackage {
  if (!isRecord(value)) return false;
  return (
    value.version === WORKFLOW_REPAIR_PACKAGE_VERSION &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    isRecord(value.classification) &&
    isRecord(value.target) &&
    isRecord(value.scope) &&
    Array.isArray(value.attempts)
  );
}

function containsLoose(source: string, value: string): boolean {
  return source.toLowerCase().includes(value.toLowerCase());
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(-max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
