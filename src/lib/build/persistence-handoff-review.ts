import type { ArchitecturePlan } from "../architecture";
import { platformEntityFromSpec } from "../platform/spec-seeding";
import type { AppSpec } from "../spec";
import type { WorkflowContract } from "../workflow-contract";
import type { FileMap } from "./template";

export const PERSISTENCE_HANDOFF_REVIEW_VERSION = 1 as const;

type PersistenceStatus = "verified" | "needs_repair";
type SaveContract = WorkflowContract["expectedSaves"][number];
type HandoffContract = WorkflowContract["handoffs"][number];

export type PersistenceSaveEvidence = {
  workflowId: string;
  workflowName: string;
  stepId: string;
  operation: SaveContract["operation"];
  entityName: string;
  entityKey: string;
  storage: SaveContract["storage"];
  requiredFieldKeys: string[];
  sourceRoutes: string[];
  sourceFiles: string[];
  writeFound: boolean;
  exactEntityKeyFound: boolean;
  exactFieldKeysFound: string[];
  missingFieldKeys: string[];
  stableReferenceFound: boolean;
  testFound: boolean;
  status: PersistenceStatus;
  issues: string[];
};

export type PersistenceReloadEvidence = {
  workflowId: string;
  workflowName: string;
  entityName: string;
  entityKey: string;
  storage: SaveContract["storage"];
  route: string;
  sourceFiles: string[];
  readFound: boolean;
  freshLoadFound: boolean;
  refreshTestFound: boolean;
  status: PersistenceStatus;
  issues: string[];
};

export type PersistenceHandoffEvidence = {
  id: string;
  producerWorkflowId: string;
  producerWorkflowName: string;
  consumerWorkflowId: string;
  consumerWorkflowName: string;
  entityKey: string;
  storage: HandoffContract["storage"];
  consumerRoute: string;
  consumerControlId: string;
  producerSaveFound: boolean;
  consumerReadFound: boolean;
  consumerFreshLoadFound: boolean;
  stableReferenceFound: boolean;
  consumerControlFound: boolean;
  handoffTestFound: boolean;
  status: PersistenceStatus;
  issues: string[];
};

export type PersistenceHandoffReview = {
  version: typeof PERSISTENCE_HANDOFF_REVIEW_VERSION;
  summary: {
    savesRequired: number;
    savesVerified: number;
    exactSchemasRequired: number;
    exactSchemasVerified: number;
    reloadPathsRequired: number;
    reloadPathsVerified: number;
    handoffsRequired: number;
    handoffsVerified: number;
    persistenceTestsRequired: number;
    persistenceTestsVerified: number;
  };
  saves: PersistenceSaveEvidence[];
  reloads: PersistenceReloadEvidence[];
  handoffs: PersistenceHandoffEvidence[];
  warnings: string[];
  blockingIssues: string[];
};

type SourceModule = {
  path: string;
  source: string;
  imports: string[];
};

const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const LOCKED_SOURCE_FILES = new Set([
  "src/lib/platform-data.ts",
  "src/lib/platform-files.ts",
  "src/lib/platform-notifications.ts",
  "src/lib/platform-integrations.ts",
  "src/lib/device-location.ts",
  "src/lib/voiceforge-modules.ts",
  "src/components/voiceforge-reusable.tsx",
  "src/components/voiceforge-google-map.tsx",
]);
const RAW_BINARY_PATTERN =
  /\b(imageBase64|base64Image|generatedImageBase64|dataBase64|dataUrl|rawImageData|rawFileData|rawPdfData)\b/i;
const TEST_ASSERTION_PATTERN =
  /\b(toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenNthCalledWith|toEqual|toMatchObject|expect)\b/;
const REFRESH_TEST_PATTERN =
  /\b(unmount|remount|rerender|reload|page\.reload|fresh mount|mount again|after refresh|persist(?:s|ed)? after refresh)\b/i;

export function analyzePersistenceHandoffs(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
  files: FileMap;
}): PersistenceHandoffReview {
  const modules = analyzeModules(input.files);
  const testText = generatedTestText(input.files);
  const saves: PersistenceSaveEvidence[] = [];
  const reloads: PersistenceReloadEvidence[] = [];
  const savesByReference = new Map<string, PersistenceSaveEvidence[]>();

  for (const contract of input.architecture.workflowContracts) {
    for (const save of contract.expectedSaves) {
      const saveStep = contract.steps.find((step) => step.id === save.stepId);
      const routes = uniqueStrings([
        saveStep?.route ?? contract.start.route,
        contract.success.route,
      ]);
      const routeSource = sourceForRoutes(routes, modules, input.files);
      const saveEvidence = reviewSave({
        spec: input.spec,
        contract,
        save,
        routes,
        source: routeSource.source,
        sourceFiles: routeSource.files,
        testText,
      });
      saves.push(saveEvidence);
      const referenceKey = `${contract.id}:${save.producedReference}`;
      savesByReference.set(referenceKey, [
        ...(savesByReference.get(referenceKey) ?? []),
        saveEvidence,
      ]);

      const reloadSource = sourceForRoutes(
        [contract.success.route],
        modules,
        input.files,
      );
      reloads.push(
        reviewReload({
          contract,
          save,
          route: contract.success.route,
          source: reloadSource.source,
          sourceFiles: reloadSource.files,
          testText,
        }),
      );
    }
  }

  const handoffs = input.architecture.workflowContracts.flatMap((producer) =>
    producer.handoffs.map((handoff) => {
      const consumer = input.architecture.workflowContracts.find(
        (candidate) => candidate.id === handoff.consumerWorkflowId,
      );
      const consumerSource = sourceForRoutes(
        [handoff.consumerRoute],
        modules,
        input.files,
      );
      return reviewHandoff({
        producer,
        consumer,
        handoff,
        producerSave: selectProducerSave(
          savesByReference.get(`${producer.id}:${handoff.produces}`) ?? [],
          handoff.fromStepId,
        ),
        consumerSource: consumerSource.source,
        consumerFiles: consumerSource.files,
        testText,
      });
    }),
  );

  const blockingIssues = uniqueStrings([
    ...saves.flatMap((save) => save.issues),
    ...reloads.flatMap((reload) => reload.issues),
    ...handoffs.flatMap((handoff) => handoff.issues),
  ]);
  const warnings = persistenceWarnings({ saves, reloads, handoffs, testText });
  const persistenceTestsRequired = saves.length + reloads.length + handoffs.length;
  const persistenceTestsVerified =
    saves.filter((save) => save.testFound).length +
    reloads.filter((reload) => reload.refreshTestFound).length +
    handoffs.filter((handoff) => handoff.handoffTestFound).length;

  return {
    version: PERSISTENCE_HANDOFF_REVIEW_VERSION,
    summary: {
      savesRequired: saves.length,
      savesVerified: saves.filter((save) => save.status === "verified").length,
      exactSchemasRequired: saves.length,
      exactSchemasVerified: saves.filter(
        (save) => save.exactEntityKeyFound && save.missingFieldKeys.length === 0,
      ).length,
      reloadPathsRequired: reloads.length,
      reloadPathsVerified: reloads.filter(
        (reload) => reload.status === "verified",
      ).length,
      handoffsRequired: handoffs.length,
      handoffsVerified: handoffs.filter(
        (handoff) => handoff.status === "verified",
      ).length,
      persistenceTestsRequired,
      persistenceTestsVerified,
    },
    saves,
    reloads,
    handoffs,
    warnings,
    blockingIssues,
  };
}

function selectProducerSave(
  candidates: PersistenceSaveEvidence[],
  fromStepId: string,
): PersistenceSaveEvidence | undefined {
  return (
    candidates.find((candidate) => candidate.stepId === fromStepId) ??
    candidates.find((candidate) => candidate.status === "verified") ??
    candidates[0]
  );
}

function reviewSave(input: {
  spec: AppSpec;
  contract: WorkflowContract;
  save: SaveContract;
  routes: string[];
  source: string;
  sourceFiles: string[];
  testText: string;
}): PersistenceSaveEvidence {
  const schema = input.spec.dataEntities
    .map((entity) => platformEntityFromSpec(entity, input.spec))
    .find((entity) => entity.key === input.save.entityKey);
  const knownFieldKeys = new Set(schema?.fields.map((field) => field.key) ?? []);
  const exactEntityKeyFound =
    input.save.storage === "platformData"
      ? hasExactToken(input.source, input.save.entityKey)
      : sourceMentionsEntity(input.source, input.save);
  const writeFound = hasWriteOperation(input.source, input.save);
  const exactFieldKeysFound = input.save.fieldKeys.filter((field) =>
    hasExactToken(input.source, field),
  );
  const missingFieldKeys = input.save.fieldKeys.filter(
    (field) => !exactFieldKeysFound.includes(field),
  );
  const stableReferenceFound =
    input.save.operation === "delete" ||
    (input.save.storage === "localStorage"
      ? /\bid\s*:|\.id\b/.test(input.source)
      : hasStableRecordIdentity(input.source, input.save) ||
        hasRetainedWriteResult(input.source, input.save));
  const testFound = hasPersistenceTest(input.testText, input.contract, input.save);
  const issues: string[] = [];

  if (!writeFound) {
    issues.push(
      `persistence_handoff:save Workflow "${input.contract.name}" promises to ${input.save.operation} ${input.save.entityKey}, but no durable ${input.save.storage} write is reachable from ${input.routes.join(" or ")}.`,
    );
  }
  if (!exactEntityKeyFound) {
    issues.push(
      `persistence_handoff:schema Workflow "${input.contract.name}" does not use the exact entity key "${input.save.entityKey}" on its save path.`,
    );
  }
  const unknownContractFields = input.save.fieldKeys.filter(
    (field) => !knownFieldKeys.has(field),
  );
  if (unknownContractFields.length > 0) {
    issues.push(
      `persistence_handoff:schema Workflow "${input.contract.name}" references fields outside the ${input.save.entityKey} platform schema: ${unknownContractFields.join(", ")}.`,
    );
  } else if (missingFieldKeys.length > 0 && input.save.operation !== "delete") {
    issues.push(
      `persistence_handoff:schema Workflow "${input.contract.name}" save path does not show the exact required ${input.save.entityKey} field keys: ${missingFieldKeys.join(", ")}.`,
    );
  }
  if (
    input.save.storage === "platformData" &&
    writeFound &&
    platformWriteIncludesRawBinary(input.source)
  ) {
    issues.push(
      `persistence_handoff:schema Workflow "${input.contract.name}" appears to mix raw file/image bytes into a platform-data save path; upload with platform-files and store only the file id/reference.`,
    );
  }
  if (!stableReferenceFound && input.save.producedReference) {
    issues.push(
      `persistence_handoff:save Workflow "${input.contract.name}" does not retain the saved ${input.save.entityKey} reference for its visible result or downstream workflow.`,
    );
  }
  if (!testFound) {
    issues.push(
      `persistence_handoff:test Workflow "${input.contract.name}" needs a focused test that asserts the ${input.save.operation} of ${input.save.entityKey} with its exact saved fields.`,
    );
  }

  return {
    workflowId: input.contract.id,
    workflowName: input.contract.name,
    stepId: input.save.stepId,
    operation: input.save.operation,
    entityName: input.save.entityName,
    entityKey: input.save.entityKey,
    storage: input.save.storage,
    requiredFieldKeys: input.save.fieldKeys,
    sourceRoutes: input.routes,
    sourceFiles: input.sourceFiles,
    writeFound,
    exactEntityKeyFound,
    exactFieldKeysFound,
    missingFieldKeys,
    stableReferenceFound,
    testFound,
    status: issues.length === 0 ? "verified" : "needs_repair",
    issues,
  };
}

function hasStableRecordIdentity(source: string, save: SaveContract): boolean {
  const entity = entityPattern(save.entityName, save.entityKey);
  const entityRecord = new RegExp(
    `\\b[A-Za-z_$][\\w$]*(?:${entity})[A-Za-z0-9_$]*(?:\\.id\\b|\\.recordId\\b|\\[["']id["']\\])`,
    "i",
  );
  const savedRecord =
    /\b(?:saved|created|updated|uploaded|selected|current|last|latest|recent|record)[A-Za-z0-9_$]*(?:\.id\b|\.recordId\b|\[["']id["']\])/i;
  return entityRecord.test(source) || savedRecord.test(source);
}

function hasRetainedWriteResult(source: string, save: SaveContract): boolean {
  const entity = entityPattern(save.entityName, save.entityKey);
  const operation = operationVerbs(save.operation);
  const directWrite =
    save.storage === "platformFiles"
      ? "(?:uploadPlatformFile(?:Data)?)"
      : save.storage === "platformData"
        ? `(?:${save.operation}PlatformRecord|(?:${operation})[A-Za-z0-9_$]*${entity}[A-Za-z0-9_$]*)`
        : `(?:${operation})[A-Za-z0-9_$]*${entity}[A-Za-z0-9_$]*`;
  const assignedAwait = new RegExp(
    `\\b(?:const|let|var)\\s+(?:[A-Za-z_$][\\w$]*|\\{[^}]+\\}|\\[[^\\]]+\\])(?:\\s*:\\s*[^=;\\n]+)?\\s*=\\s*await\\s+${directWrite}(?:\\s*<[^;()]+>)?\\s*\\(`,
    "i",
  );
  const semanticAssignment =
    /\b(?:const|let|var)\s+(?:saved|created|updated|uploaded|new|last|latest|recent)[A-Za-z0-9_$]*(?:\s*:\s*[^=;\n]+)?\s*=\s*await\b/i;
  const setterAwait = new RegExp(
    `\\bset(?:Saved|Created|Updated|Uploaded|Last|Latest|Recent)[A-Za-z0-9_$]*\\s*\\(\\s*await\\s+${directWrite}(?:\\s*<[^;()]+>)?\\s*\\(`,
    "i",
  );
  const returnedWrite = new RegExp(
    `\\breturn\\s+(?:await\\s+)?${directWrite}(?:\\s*<[^;()]+>)?\\s*\\(`,
    "i",
  );
  return (
    assignedAwait.test(source) ||
    semanticAssignment.test(source) ||
    setterAwait.test(source) ||
    returnedWrite.test(source)
  );
}

function reviewReload(input: {
  contract: WorkflowContract;
  save: SaveContract;
  route: string;
  source: string;
  sourceFiles: string[];
  testText: string;
}): PersistenceReloadEvidence {
  const readFound = hasReadOperation(input.source, input.save);
  const freshLoadFound = readFound && hasFreshLoadLifecycle(input.source, input.save.storage);
  const refreshTestFound = hasRefreshTest(
    input.testText,
    input.contract,
    input.save,
  );
  const issues: string[] = [];
  if (!readFound) {
    issues.push(
      `persistence_handoff:reload Workflow "${input.contract.name}" saves ${input.save.entityKey}, but ${input.route} has no durable read path for that entity.`,
    );
  } else if (!freshLoadFound) {
    issues.push(
      `persistence_handoff:reload Workflow "${input.contract.name}" can read ${input.save.entityKey}, but the success screen does not reload it on a fresh screen entry or mount.`,
    );
  }
  if (!refreshTestFound) {
    issues.push(
      `persistence_handoff:test Workflow "${input.contract.name}" needs a fresh-mount or refresh test proving saved ${input.save.entityKey} data reappears.`,
    );
  }
  return {
    workflowId: input.contract.id,
    workflowName: input.contract.name,
    entityName: input.save.entityName,
    entityKey: input.save.entityKey,
    storage: input.save.storage,
    route: input.route,
    sourceFiles: input.sourceFiles,
    readFound,
    freshLoadFound,
    refreshTestFound,
    status: issues.length === 0 ? "verified" : "needs_repair",
    issues,
  };
}

function reviewHandoff(input: {
  producer: WorkflowContract;
  consumer: WorkflowContract | undefined;
  handoff: HandoffContract;
  producerSave: PersistenceSaveEvidence | undefined;
  consumerSource: string;
  consumerFiles: string[];
  testText: string;
}): PersistenceHandoffEvidence {
  const entityKey = input.handoff.produces.split(".", 1)[0] ?? "";
  const syntheticSave: SaveContract = {
    stepId: input.handoff.fromStepId,
    operation: "create",
    entityName: entityKey,
    entityKey,
    fieldKeys: [],
    storage: input.handoff.storage,
    producedReference: input.handoff.produces,
  };
  const producerSaveFound = input.producerSave?.writeFound ?? false;
  const consumerReadFound = hasReadOperation(input.consumerSource, syntheticSave);
  const consumerFreshLoadFound =
    consumerReadFound &&
    hasFreshLoadLifecycle(input.consumerSource, input.handoff.storage);
  const aggregateConsumer = isAggregateCollectionConsumer(
    input.consumer,
    entityKey,
  );
  const stableReferenceFound =
    consumerReadFound &&
    (aggregateConsumer ||
      /(?:\.id\b|\["id"\]|\['id'\]|recordId|selected[A-Za-z0-9_$]*Id)/.test(
        input.consumerSource,
      ));
  const control = input.consumer?.controls.find(
    (candidate) => candidate.id === input.handoff.consumerControlId,
  );
  const consumerControlFound =
    !input.handoff.consumerControlId ||
    Boolean(control && sourceContainsLabel(input.consumerSource, control.accessibleName));
  const handoffTestFound = hasHandoffTest(
    input.testText,
    input.producer,
    input.consumer,
    entityKey,
  );
  const issues: string[] = [];
  const consumerName = input.consumer?.name ?? input.handoff.consumerWorkflowId;

  if (!producerSaveFound) {
    issues.push(
      `persistence_handoff:handoff Handoff ${input.handoff.id} has no verified producer save for ${input.handoff.produces}.`,
    );
  }
  if (!consumerReadFound) {
    issues.push(
      `persistence_handoff:handoff Workflow "${consumerName}" does not load saved ${entityKey} records on ${input.handoff.consumerRoute}.`,
    );
  } else if (!consumerFreshLoadFound) {
    issues.push(
      `persistence_handoff:handoff Workflow "${consumerName}" can read ${entityKey}, but does not load it on fresh entry to ${input.handoff.consumerRoute}.`,
    );
  } else if (!stableReferenceFound) {
    issues.push(
      `persistence_handoff:handoff Workflow "${consumerName}" loads ${entityKey}, but does not expose or select it by a stable saved record id.`,
    );
  }
  if (!consumerControlFound) {
    issues.push(
      `persistence_handoff:handoff Workflow "${consumerName}" does not connect loaded ${entityKey} records to its contracted consuming control.`,
    );
  }
  if (!handoffTestFound) {
    issues.push(
      `persistence_handoff:test Handoff from "${input.producer.name}" to "${consumerName}" needs a test that saves ${entityKey}, opens the consumer, and selects or displays the saved record.`,
    );
  }

  return {
    id: input.handoff.id,
    producerWorkflowId: input.producer.id,
    producerWorkflowName: input.producer.name,
    consumerWorkflowId: input.handoff.consumerWorkflowId,
    consumerWorkflowName: consumerName,
    entityKey,
    storage: input.handoff.storage,
    consumerRoute: input.handoff.consumerRoute,
    consumerControlId: input.handoff.consumerControlId,
    producerSaveFound,
    consumerReadFound,
    consumerFreshLoadFound,
    stableReferenceFound,
    consumerControlFound,
    handoffTestFound,
    status: issues.length === 0 ? "verified" : "needs_repair",
    issues,
  };
}

function isAggregateCollectionConsumer(
  consumer: WorkflowContract | undefined,
  entityKey: string,
): boolean {
  if (!consumer || consumer.expectedSaves.length > 0) return false;
  const relevantSteps = consumer.steps.filter((step) =>
    step.reads.includes(entityKey),
  );
  if (relevantSteps.length === 0) return false;
  const text = [
    consumer.name,
    consumer.start.screen,
    consumer.success.visibleResult,
    ...relevantSteps.flatMap((step) => [
      step.description,
      step.visibleResult,
    ]),
  ].join(" ");
  return (
    relevantSteps.every(
      (step) => step.kind === "automatic" || step.kind === "result",
    ) &&
    /\b(aggregate|calculate|count|dashboard|metric|overview|summary|total)\b/i.test(
      text,
    )
  );
}

function hasWriteOperation(source: string, save: SaveContract): boolean {
  const entity = entityPattern(save.entityName, save.entityKey);
  if (save.storage === "platformData") {
    const direct =
      save.operation === "create"
        ? "createPlatformRecord"
        : save.operation === "update"
          ? "updatePlatformRecord"
          : "deletePlatformRecord";
    const durableCall = new RegExp(
      `\\b${direct}(?:\\s*<[^;()]+>)?\\s*\\(`,
    ).test(source);
    const namedEntityWrapper = new RegExp(
      `\\b(?:${operationVerbs(save.operation)})[A-Za-z0-9_$]*${entity}[A-Za-z0-9_$]*\\s*\\(`,
      "i",
    ).test(source);
    return (
      durableCall &&
      hasExactToken(source, save.entityKey) &&
      (namedEntityWrapper || source.includes(direct))
    );
  }
  if (save.storage === "platformFiles") {
    return save.operation === "delete"
      ? /\bdeletePlatformFile\s*\(/.test(source)
      : /\buploadPlatformFile(?:Data)?\s*\(/.test(source);
  }
  const durableWrite =
    save.operation === "delete"
      ? /\blocalStorage\.(?:removeItem|setItem)\s*\(/.test(source)
      : /\blocalStorage\.setItem\s*\(/.test(source);
  return durableWrite && sourceMentionsEntity(source, save);
}

function platformWriteIncludesRawBinary(source: string): boolean {
  for (const match of source.matchAll(
    /\b(?:createPlatformRecord|updatePlatformRecord)(?:\s*<[^;()]+>)?\s*\(([\s\S]{0,1400}?)\)\s*[;\n]/g,
  )) {
    if (RAW_BINARY_PATTERN.test(match[1] ?? "")) return true;
  }
  return false;
}

function hasReadOperation(source: string, save: SaveContract): boolean {
  if (save.storage === "platformData") {
    const directRead =
      /\b(?:listPlatformRecords|searchPlatformRecords|getPlatformRecord)(?:\s*<[^;()]+>)?\s*\(/.test(
        source,
      );
    const namedRead = new RegExp(
      `\\b(?:list|load|get|fetch|search|read)[A-Za-z0-9_$]*${entityPattern(save.entityName, save.entityKey)}[A-Za-z0-9_$]*\\s*\\(`,
      "i",
    ).test(source);
    return (directRead || namedRead) && hasExactToken(source, save.entityKey);
  }
  if (save.storage === "platformFiles") {
    return /\b(listPlatformFiles|downloadPlatformFile)\s*\(/.test(source);
  }
  return (
    /\blocalStorage\.getItem\s*\(/.test(source) &&
    sourceMentionsEntity(source, save)
  );
}

function hasFreshLoadLifecycle(
  source: string,
  storage: SaveContract["storage"],
): boolean {
  if (storage === "localStorage") {
    return /\buseEffect\s*\(/.test(source) && /\blocalStorage\.getItem\s*\(/.test(source);
  }
  return (
    /\buseEffect\s*\(/.test(source) ||
    /\buse(?:Query|SWR)\s*\(/.test(source) ||
    (/\bexport\s+default\s+async\s+function\b/.test(source) &&
      /\bawait\b/.test(source))
  );
}

function hasPersistenceTest(
  testText: string,
  contract: WorkflowContract,
  save: SaveContract,
): boolean {
  if (!testMentionsWorkflowOrEntity(testText, contract, save.entityKey)) {
    return false;
  }
  const storageCall =
    save.storage === "platformData"
      ? save.operation === "create"
        ? "createPlatformRecord"
        : save.operation === "update"
          ? "updatePlatformRecord"
          : "deletePlatformRecord"
      : save.storage === "platformFiles"
        ? save.operation === "delete"
          ? "deletePlatformFile"
          : "uploadPlatformFile"
        : save.operation === "delete"
          ? "removeItem"
          : "setItem";
  return (
    (testText.includes(storageCall) ||
      new RegExp(`\\b${operationVerbs(save.operation)}[A-Za-z0-9_$]*`, "i").test(
        testText,
      )) &&
    TEST_ASSERTION_PATTERN.test(testText) &&
    save.fieldKeys.every((field) => hasExactToken(testText, field))
  );
}

function hasRefreshTest(
  testText: string,
  contract: WorkflowContract,
  save: SaveContract,
): boolean {
  return (
    testMentionsWorkflowOrEntity(testText, contract, save.entityKey) &&
    REFRESH_TEST_PATTERN.test(testText) &&
    (hasExactToken(testText, save.entityKey) ||
      hasExactToken(testText, save.entityName))
  );
}

function hasHandoffTest(
  testText: string,
  producer: WorkflowContract,
  consumer: WorkflowContract | undefined,
  entityKey: string,
): boolean {
  if (!consumer) return false;
  return (
    hasExactToken(testText, entityKey) &&
    textOverlaps(testText, producer.name) &&
    textOverlaps(testText, consumer.name) &&
    /\b(id|select|option|display|visible|load|open|navigate|route)\b/i.test(testText) &&
    TEST_ASSERTION_PATTERN.test(testText)
  );
}

function testMentionsWorkflowOrEntity(
  testText: string,
  contract: WorkflowContract,
  entityKey: string,
): boolean {
  return hasExactToken(testText, entityKey) || textOverlaps(testText, contract.name);
}

function sourceMentionsEntity(
  source: string,
  save: Pick<SaveContract, "entityKey" | "entityName">,
): boolean {
  const normalizedSource = normalizeWords(source);
  return [save.entityKey, save.entityName].some((value) => {
    const normalized = normalizeWords(value);
    return (
      normalized.length > 2 &&
      (normalizedSource.includes(normalized) ||
        normalizedSource.includes(`${normalized}s`))
    );
  });
}

function persistenceWarnings(input: {
  saves: PersistenceSaveEvidence[];
  reloads: PersistenceReloadEvidence[];
  handoffs: PersistenceHandoffEvidence[];
  testText: string;
}): string[] {
  const warnings: string[] = [];
  if (
    input.saves.length > 0 &&
    !/\b(save failure|failed save|rejects|error message|keeps|retains|preserves)\b/i.test(
      input.testText,
    )
  ) {
    warnings.push(
      "persistence_handoff:test No focused test was found proving a failed save keeps the user's entered values available for correction.",
    );
  }
  return uniqueStrings(warnings);
}

function analyzeModules(files: FileMap): Map<string, SourceModule> {
  const modules = new Map<string, SourceModule>();
  for (const [path, source] of Object.entries(files)) {
    if (!isGeneratedSource(path) || isTestFile(path) || LOCKED_SOURCE_FILES.has(path)) {
      continue;
    }
    modules.set(path, {
      path,
      source,
      imports: collectInternalImports(path, source, files),
    });
  }
  return modules;
}

function sourceForRoutes(
  routes: readonly string[],
  modules: Map<string, SourceModule>,
  files: FileMap,
): { source: string; files: string[] } {
  const paths = new Set<string>();
  for (const route of routes) {
    const pagePath = pagePathForRoute(route, modules);
    if (!pagePath) continue;
    for (const path of collectModuleClosure(pagePath, modules)) paths.add(path);
  }
  const sourceFiles = [...paths].filter((path) => !LOCKED_SOURCE_FILES.has(path)).sort();
  return {
    source: sourceFiles.map((path) => files[path] ?? "").join("\n"),
    files: sourceFiles,
  };
}

function pagePathForRoute(
  route: string,
  modules: Map<string, SourceModule>,
): string | null {
  const normalizedRoute = normalizeRoute(route);
  const exact = [...modules.keys()].find(
    (path) => isPageFile(path) && pagePathToRoute(path) === normalizedRoute,
  );
  if (exact) return exact;
  return (
    [...modules.keys()].find(
      (path) =>
        isPageFile(path) && routePatternsOverlap(pagePathToRoute(path), normalizedRoute),
    ) ?? null
  );
}

function collectModuleClosure(
  startPath: string,
  modules: Map<string, SourceModule>,
): Set<string> {
  const visited = new Set<string>();
  const queue = [startPath];
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    for (const dependency of modules.get(path)?.imports ?? []) {
      if (!visited.has(dependency)) queue.push(dependency);
    }
  }
  return visited;
}

function collectInternalImports(
  sourcePath: string,
  source: string,
  files: FileMap,
): string[] {
  const imports: string[] = [];
  for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
    const resolved = resolveInternalImport(sourcePath, match[1], files);
    if (resolved) imports.push(resolved);
  }
  return uniqueStrings(imports);
}

function resolveInternalImport(
  sourcePath: string,
  specifier: string,
  files: FileMap,
): string | null {
  let base: string | null = null;
  if (specifier.startsWith("@/")) {
    base = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    const sourceDir = sourcePath.split("/").slice(0, -1).join("/");
    base = normalizeFilePath(`${sourceDir}/${specifier}`);
  }
  if (!base) return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => files[candidate] !== undefined) ?? null;
}

function generatedTestText(files: FileMap): string {
  return Object.entries(files)
    .filter(([path]) => isTestFile(path) || /^e2e\/generated\/.+\.spec\.tsx?$/.test(path))
    .map(([, source]) => source)
    .join("\n");
}

function isGeneratedSource(path: string): boolean {
  return (
    SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
    (path.startsWith("src/app/") ||
      path.startsWith("src/components/") ||
      path.startsWith("src/lib/")) &&
    !path.startsWith("src/app/api/")
  );
}

function isTestFile(path: string): boolean {
  return /(?:\.test|\.spec)\.tsx?$/.test(path);
}

function isPageFile(path: string): boolean {
  return /^src\/app\/(?:.+\/)?page\.tsx$/.test(path);
}

function pagePathToRoute(path: string): string {
  const relative = path.replace(/^src\/app\//, "");
  const directory = relative === "page.tsx" ? "" : relative.replace(/\/page\.tsx$/, "");
  const parts = directory
    .split("/")
    .filter((part) => part && !/^\(.+\)$/.test(part));
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function routePatternsOverlap(left: string, right: string): boolean {
  const leftParts = normalizeRoute(left).split("/").filter(Boolean);
  const rightParts = normalizeRoute(right).split("/").filter(Boolean);
  if (leftParts.length !== rightParts.length) return false;
  return leftParts.every(
    (part, index) =>
      part === rightParts[index] ||
      /^\[[^\]]+\]$/.test(part) ||
      /^\[[^\]]+\]$/.test(rightParts[index] ?? ""),
  );
}

function normalizeRoute(route: string): string {
  const cleaned = route.trim().replace(/\?.*$/, "").replace(/\/+$/, "");
  return cleaned && cleaned !== "" ? (cleaned.startsWith("/") ? cleaned : `/${cleaned}`) : "/";
}

function hasExactToken(source: string, value: string): boolean {
  const escaped = escapeRegExp(value);
  return new RegExp("(?:[\"'`]" + escaped + "[\"'`]|\\b" + escaped + "\\b)").test(
    source,
  );
}

function sourceContainsLabel(source: string, label: string): boolean {
  const normalized = normalizeWords(source);
  const words = normalizeWords(label)
    .split(" ")
    .filter((word) => word.length > 2);
  return words.length > 0 && words.every((word) => normalized.includes(word));
}

function textOverlaps(source: string, value: string): boolean {
  const sourceWords = new Set(normalizeWords(source).split(" "));
  const words = normalizeWords(value)
    .split(" ")
    .filter((word) => word.length > 3);
  return words.length > 0 && words.filter((word) => sourceWords.has(word)).length >= Math.min(2, words.length);
}

function entityPattern(entityName: string, entityKey: string): string {
  const candidates = uniqueStrings([
    pascalCase(entityName),
    pascalCase(entityKey),
    ...splitWords(entityName),
    ...splitWords(entityKey),
  ]).filter((value) => value.length > 2);
  return `(?:${candidates.map(escapeRegExp).join("|")})`;
}

function operationVerbs(operation: SaveContract["operation"]): string {
  if (operation === "create") return "create|add|save";
  if (operation === "update") return "update|edit|save";
  return "delete|remove|archive";
}

function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function pascalCase(value: string): string {
  return splitWords(value)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("");
}

function normalizeWords(value: string): string {
  return splitWords(value).join(" ").toLowerCase();
}

function normalizeFilePath(path: string): string {
  const output: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return output.join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
