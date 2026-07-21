import type { AppSpec } from "../spec";
import type { FileMap } from "./template";

export type DebugFailureDomain =
  | "dependency_security"
  | "typecheck"
  | "lint"
  | "unit_test"
  | "build_prerender"
  | "browser_accessibility"
  | "integration_review_gate";

export type DebugFocus =
  | "dependencies"
  | "type_errors"
  | "lint_rules"
  | "data_save"
  | "test_assertion"
  | "prerender"
  | "browser_runtime"
  | "accessibility"
  | "review_policy"
  | "general";

export type DebugFailureClassification = {
  failedStep: string;
  domain: DebugFailureDomain;
  domainLabel: string;
  focus: DebugFocus;
  reasons: string[];
};

export type DebugGenerationPhase = {
  id: string;
  label: string;
  agentKey: string;
  filesWritten: string[];
  filesDeleted?: string[];
};

export type DebugResponsiblePhase = {
  id: string;
  label: string;
  agentKey: string;
  matchedFiles: string[];
  reason: string;
};

export type DebugFileScope = {
  label: string;
  reason: string;
  limited: boolean;
  fullFileCount: number;
  visibleFileCount: number;
  visibleFilePaths: string[];
  preferredInspectionPaths: string[];
  scopedFiles: FileMap;
};

export type PhaseAwareDebugContext = {
  failedDomain: DebugFailureDomain;
  domainLabel: string;
  focus: DebugFocus;
  responsiblePhase: DebugResponsiblePhase;
  scopeLabel: string;
  scopeReason: string;
  limitedScope: boolean;
  fullFileCount: number;
  visibleFileCount: number;
  visibleFilePaths: string[];
  preferredInspectionPaths: string[];
  instructions: string[];
};

export type PhaseAwareDebugPlan = {
  classification: DebugFailureClassification;
  responsiblePhase: DebugResponsiblePhase;
  scope: DebugFileScope;
  context: PhaseAwareDebugContext;
};

const DOMAIN_LABELS: Record<DebugFailureDomain, string> = {
  dependency_security: "dependency/security",
  typecheck: "typecheck",
  lint: "lint",
  unit_test: "unit test",
  build_prerender: "build/prerender",
  browser_accessibility: "browser/accessibility",
  integration_review_gate: "integration/review gate",
};

const CONFIG_FILES = [
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "playwright.config.ts",
  "vitest.config.ts",
  "vitest.setup.ts",
];

const LOCKED_PLATFORM_HELPERS = [
  "src/lib/platform-data.ts",
  "src/lib/platform-files.ts",
  "src/lib/platform-notifications.ts",
  "src/lib/platform-integrations.ts",
  "src/lib/device-location.ts",
  "src/lib/voiceforge-modules.ts",
  "src/components/voiceforge-reusable.tsx",
];

const FILE_PATH_PATTERN =
  /(?:^|[\s('"`])((?:\.\/)?(?:src|e2e)\/[A-Za-z0-9_./@-]+\.(?:tsx?|jsx?|json|css))/g;

export function createPhaseAwareDebugPlan(input: {
  spec: AppSpec;
  files: FileMap;
  failedStep: string;
  errorOutput: string;
  generatedPhases: readonly DebugGenerationPhase[];
  changedFilePaths?: readonly string[];
}): PhaseAwareDebugPlan {
  const classification = classifyDebugFailure({
    failedStep: input.failedStep,
    errorOutput: input.errorOutput,
  });
  const responsiblePhase = inferResponsiblePhase({
    classification,
    errorOutput: input.errorOutput,
    generatedPhases: input.generatedPhases,
  });
  const scope = selectDebugFileScope({
    spec: input.spec,
    files: input.files,
    classification,
    responsiblePhase,
    errorOutput: input.errorOutput,
    generatedPhases: input.generatedPhases,
    changedFilePaths: input.changedFilePaths ?? [],
  });

  return {
    classification,
    responsiblePhase,
    scope,
    context: {
      failedDomain: classification.domain,
      domainLabel: classification.domainLabel,
      focus: classification.focus,
      responsiblePhase,
      scopeLabel: scope.label,
      scopeReason: scope.reason,
      limitedScope: scope.limited,
      fullFileCount: scope.fullFileCount,
      visibleFileCount: scope.visibleFileCount,
      visibleFilePaths: scope.visibleFilePaths,
      preferredInspectionPaths: scope.preferredInspectionPaths,
      instructions: instructionsFor(classification, responsiblePhase),
    },
  };
}

export function classifyDebugFailure(input: {
  failedStep: string;
  errorOutput: string;
}): DebugFailureClassification {
  const step = input.failedStep.toLowerCase();
  const output = input.errorOutput.toLowerCase();
  const reasons: string[] = [`failed step: ${input.failedStep}`];
  let domain: DebugFailureDomain;

  if (step === "install" || step === "dependencies") {
    domain = "dependency_security";
  } else if (step === "typecheck") {
    domain = "typecheck";
  } else if (step === "lint") {
    domain = "lint";
  } else if (step === "test") {
    domain = "unit_test";
  } else if (step === "build") {
    domain = "build_prerender";
  } else if (step === "e2e") {
    domain = "browser_accessibility";
  } else if (step === "review_gate" || output.includes("review failed")) {
    domain = "integration_review_gate";
  } else {
    domain = "build_prerender";
    reasons.push("unknown step treated as build/prerender");
  }

  const focus = focusFromOutput(domain, output);
  if (focus !== "general") reasons.push(`failure focus: ${focus}`);

  return {
    failedStep: input.failedStep,
    domain,
    domainLabel: DOMAIN_LABELS[domain],
    focus,
    reasons,
  };
}

export function inferResponsiblePhase(input: {
  classification: DebugFailureClassification;
  errorOutput: string;
  generatedPhases: readonly DebugGenerationPhase[];
}): DebugResponsiblePhase {
  const mentionedPaths = extractMentionedFilePaths(input.errorOutput);
  const reviewGateHint = phaseHintForReviewGate({
    classification: input.classification,
    errorOutput: input.errorOutput,
    generatedPhases: input.generatedPhases,
    mentionedPaths,
  });
  if (reviewGateHint) return reviewGateHint;

  const scored = input.generatedPhases.map((phase) => {
    const phasePaths = new Set([
      ...phase.filesWritten,
      ...(phase.filesDeleted ?? []),
    ]);
    const matchedFiles = mentionedPaths.filter((filePath) =>
      phasePaths.has(filePath),
    );
    let score = matchedFiles.length * 5;
    score += defaultPhaseScore(input.classification, phase);
    return { phase, matchedFiles, score };
  });
  const best = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  if (best) {
    return {
      id: best.phase.id,
      label: best.phase.label,
      agentKey: best.phase.agentKey,
      matchedFiles: best.matchedFiles,
      reason:
        best.matchedFiles.length > 0
          ? `Failure output mentioned file(s) from this phase: ${best.matchedFiles.join(", ")}.`
          : `This phase owns the default surface for ${input.classification.domainLabel} failures.`,
    };
  }

  const fallback = fallbackPhaseFor(input.classification);
  return {
    ...fallback,
    matchedFiles: mentionedPaths,
    reason:
      mentionedPaths.length > 0
        ? `No generated phase exactly matched mentioned file(s): ${mentionedPaths.join(", ")}.`
        : `No file paths were found in the failure output; using the default ${input.classification.domainLabel} owner.`,
  };
}

export function selectDebugFileScope(input: {
  spec: AppSpec;
  files: FileMap;
  classification: DebugFailureClassification;
  responsiblePhase: DebugResponsiblePhase;
  errorOutput: string;
  generatedPhases: readonly DebugGenerationPhase[];
  changedFilePaths: readonly string[];
}): DebugFileScope {
  const allPaths = Object.keys(input.files).sort();
  const selected = new Set<string>();
  const preferred = new Set<string>();
  const mentionedPaths = extractMentionedFilePaths(input.errorOutput).filter(
    (filePath) => input.files[filePath] !== undefined,
  );

  addExisting(selected, input.files, CONFIG_FILES);
  addExisting(selected, input.files, mentionedPaths);
  addExisting(preferred, input.files, mentionedPaths);
  addResponsiblePhaseFiles(selected, preferred, input.files, input);

  switch (input.classification.domain) {
    case "dependency_security":
      addAllVisibleSource(selected, input.files);
      addPreferredByPattern(preferred, input.files, (path, content) =>
        /from\s+["'][^"']+["']/.test(content) || path === "package.json",
      );
      break;
    case "typecheck":
    case "lint":
      addRelatedImportNeighbors(selected, input.files);
      addPreferredByPattern(preferred, input.files, (path) =>
        mentionedPaths.includes(path),
      );
      if (mentionedPaths.length === 0) {
        addAllVisibleSource(selected, input.files);
      }
      break;
    case "unit_test":
      addByPattern(selected, input.files, (path) => isGeneratedTest(path));
      if (input.classification.focus === "data_save") {
        addDataSaveSurface(selected, preferred, input.files);
      }
      addRelatedImportNeighbors(selected, input.files);
      addPreferredByPattern(preferred, input.files, (path) =>
        isGeneratedTest(path) || mentionedPaths.includes(path),
      );
      break;
    case "build_prerender":
      addFrontendSurface(selected, input.files);
      addByPattern(selected, input.files, (path, content) =>
        path.startsWith("src/lib/") &&
        /\b(window|localStorage|useSearchParams|platform-data|storage)\b/.test(
          content,
        ),
      );
      addRelatedImportNeighbors(selected, input.files);
      addPreferredByPattern(preferred, input.files, (path, content) =>
        mentionedPaths.includes(path) ||
        (path.startsWith("src/app/") &&
          /\b(window|localStorage|useSearchParams)\b/.test(content)),
      );
      break;
    case "browser_accessibility":
      addFrontendSurface(selected, input.files);
      addByPattern(selected, input.files, (path) =>
        path.startsWith("e2e/generated/"),
      );
      addRelatedImportNeighbors(selected, input.files);
      addPreferredByPattern(preferred, input.files, (path) =>
        mentionedPaths.includes(path) ||
        path.startsWith("src/app/") ||
        path.startsWith("src/components/"),
      );
      break;
    case "integration_review_gate":
      addExisting(selected, input.files, input.changedFilePaths);
      addByPattern(selected, input.files, (path) => isGeneratedAppSource(path));
      addPreferredByPattern(preferred, input.files, (path) =>
        input.changedFilePaths.includes(path) || mentionedPaths.includes(path),
      );
      break;
  }

  if (input.classification.focus === "data_save") {
    addDataSaveSurface(selected, preferred, input.files);
  }

  addExisting(selected, input.files, LOCKED_PLATFORM_HELPERS);
  addRelatedImportNeighbors(selected, input.files);

  const scopedPaths = [...selected]
    .filter((path) => input.files[path] !== undefined)
    .sort();
  const visibleFilePaths =
    scopedPaths.length === 0 ? allPaths : scopedPaths;
  const scopedFiles = Object.fromEntries(
    visibleFilePaths.map((path) => [path, input.files[path]]),
  );
  const preferredInspectionPaths = [...preferred]
    .filter((path) => scopedFiles[path] !== undefined)
    .sort();
  const limited = visibleFilePaths.length < allPaths.length;

  return {
    label: limited ? "focused debug scope" : "full generated-app scope",
    reason: scopeReason(input.classification, limited),
    limited,
    fullFileCount: allPaths.length,
    visibleFileCount: visibleFilePaths.length,
    visibleFilePaths,
    preferredInspectionPaths:
      preferredInspectionPaths.length > 0
        ? preferredInspectionPaths
        : visibleFilePaths.slice(0, 12),
    scopedFiles,
  };
}

export function extractMentionedFilePaths(output: string): string[] {
  const paths: string[] = [];
  FILE_PATH_PATTERN.lastIndex = 0;
  for (const match of output.matchAll(FILE_PATH_PATTERN)) {
    const filePath = normalizePath(match[1]);
    if (filePath) paths.push(filePath);
  }
  return uniqueStrings(paths);
}

function focusFromOutput(
  domain: DebugFailureDomain,
  lowerOutput: string,
): DebugFocus {
  if (
    /record data failed validation|createplatformrecord|updateplatformrecord|save|submit|payload|schema key|validation/.test(
      lowerOutput,
    )
  ) {
    return "data_save";
  }
  if (/axe|accessibility|aria-|aria |label|contrast|violations?/.test(lowerOutput)) {
    return "accessibility";
  }
  if (/window is not defined|localstorage|prerender|usesearchparams|suspense/.test(lowerOutput)) {
    return "prerender";
  }
  if (/testinglibraryelementerror|unable to find|expect\(|assertion|vitest/.test(lowerOutput)) {
    return "test_assertion";
  }
  if (/eslint|no-unused-vars|react-hooks|next\/core-web-vitals/.test(lowerOutput)) {
    return "lint_rules";
  }
  if (/ts\d{4}|type '.*' is not assignable|typescript/.test(lowerOutput)) {
    return "type_errors";
  }
  if (/external urls?|api key|credential|locked api route|review failed/.test(lowerOutput)) {
    return "review_policy";
  }
  if (domain === "dependency_security") return "dependencies";
  if (domain === "browser_accessibility") return "browser_runtime";
  return "general";
}

function phaseHintForReviewGate(input: {
  classification: DebugFailureClassification;
  errorOutput: string;
  generatedPhases: readonly DebugGenerationPhase[];
  mentionedPaths: readonly string[];
}): DebugResponsiblePhase | null {
  if (input.classification.domain !== "integration_review_gate") return null;

  const lowerOutput = input.errorOutput.toLowerCase();
  let phaseId: string | null = null;
  let reason: string | null = null;

  if (
    /architecture planned route files|advanced workflow coverage|planned workflows without visible action controls|visible create\/edit controls|app router page|sign-in|route-stable|google maps|interactive google map|platform-files|platform-notifications|platform-integrations|device gps|device-location|search\/report/.test(
      lowerOutput,
    )
  ) {
    phaseId = "pages-workflows";
    reason =
      "The review-gate failure is about missing routes, workflow controls, or runtime platform integration wiring, so the pages/workflows phase owns the repair.";
  } else if (
    /tests_review:|generated tests|test coverage|missing generated tests|unit\/workflow tests/.test(
      lowerOutput,
    )
  ) {
    phaseId = "unit-workflow-tests";
    reason =
      "The review-gate failure is about generated test coverage, so the unit/workflow test phase owns the repair.";
  } else if (/browser-level acceptance|e2e\/generated|playwright/.test(lowerOutput)) {
    phaseId = "browser-acceptance-tests";
    reason =
      "The review-gate failure is about generated browser acceptance coverage, so the browser acceptance test phase owns the repair.";
  } else if (
    input.classification.focus === "data_save" ||
    /platform schema|schema key|unknown platform entity key|save fields not in/.test(
      lowerOutput,
    )
  ) {
    phaseId = "foundation";
    reason =
      "The review-gate failure is about platform schema keys or data-save helpers, so the foundation phase owns the first repair pass.";
  }

  if (!phaseId || !reason) return null;
  const phase = input.generatedPhases.find((candidate) => candidate.id === phaseId);
  if (!phase) return null;

  const phasePaths = new Set([
    ...phase.filesWritten,
    ...(phase.filesDeleted ?? []),
  ]);
  return {
    id: phase.id,
    label: phase.label,
    agentKey: phase.agentKey,
    matchedFiles: input.mentionedPaths.filter((path) => phasePaths.has(path)),
    reason,
  };
}

function defaultPhaseScore(
  classification: DebugFailureClassification,
  phase: DebugGenerationPhase,
): number {
  const id = phase.id;
  if (classification.domain === "dependency_security" && id === "foundation") {
    return 2;
  }
  if (classification.domain === "unit_test" && id === "unit-workflow-tests") {
    return 3;
  }
  if (
    classification.domain === "browser_accessibility" &&
    id === "pages-workflows"
  ) {
    return 3;
  }
  if (
    classification.domain === "build_prerender" &&
    id === "pages-workflows"
  ) {
    return 3;
  }
  if (
    classification.domain === "integration_review_gate" &&
    id === "pages-workflows"
  ) {
    return 3;
  }
  if (
    classification.domain === "integration_review_gate" &&
    id === "final-integration-review"
  ) {
    return 1;
  }
  if (
    (classification.domain === "typecheck" || classification.domain === "lint") &&
    id === "final-integration-review"
  ) {
    return 1;
  }
  return 0;
}

function fallbackPhaseFor(
  classification: DebugFailureClassification,
): Omit<DebugResponsiblePhase, "matchedFiles" | "reason"> {
  switch (classification.domain) {
    case "dependency_security":
      return {
        id: "foundation",
        label: "Data, types, constants, and platform wrappers",
        agentKey: "backend_platform_planner",
      };
    case "unit_test":
      return {
        id: "unit-workflow-tests",
        label: "Unit and workflow tests",
        agentKey: "test_agent",
      };
    case "browser_accessibility":
    case "build_prerender":
      return {
        id: "pages-workflows",
        label: "Pages, navigation, and workflows",
        agentKey: "frontend_builder",
      };
    case "integration_review_gate":
      return {
        id: "pages-workflows",
        label: "Pages, navigation, and workflows",
        agentKey: "frontend_builder",
      };
    case "typecheck":
    case "lint":
      return {
        id: "final-integration-review",
        label: "Final integration review",
        agentKey: "final_integration_agent",
      };
  }
}

function addResponsiblePhaseFiles(
  selected: Set<string>,
  preferred: Set<string>,
  files: FileMap,
  input: {
    responsiblePhase: DebugResponsiblePhase;
    generatedPhases: readonly DebugGenerationPhase[];
  },
): void {
  const phase = input.generatedPhases.find(
    (candidate) => candidate.id === input.responsiblePhase.id,
  );
  const paths = phase?.filesWritten ?? [];
  addExisting(selected, files, paths);
  addExisting(preferred, files, input.responsiblePhase.matchedFiles);
}

function addAllVisibleSource(selected: Set<string>, files: FileMap): void {
  addByPattern(selected, files, (path) => isVisibleDebugFile(path));
}

function addFrontendSurface(selected: Set<string>, files: FileMap): void {
  addByPattern(
    selected,
    files,
    (path) =>
      path.startsWith("src/app/") ||
      path.startsWith("src/components/") ||
      path === "src/lib/device-location.ts" ||
      path === "src/lib/voiceforge-modules.ts" ||
      path === "src/components/voiceforge-reusable.tsx",
  );
}

function addDataSaveSurface(
  selected: Set<string>,
  preferred: Set<string>,
  files: FileMap,
): void {
  addByPattern(selected, files, (path, content) => {
    if (path === "src/lib/platform-data.ts") return true;
    if (path === "src/components/voiceforge-reusable.tsx") return true;
    if (path.startsWith("src/lib/")) {
      return /\b(platform-data|createPlatformRecord|updatePlatformRecord|deletePlatformRecord|payload|draft|schema|zod|validate|validation)\b/i.test(
        content,
      );
    }
    if (path.startsWith("src/components/") || path.startsWith("src/app/")) {
      return /\b(<form|onSubmit|handleSubmit|Save|submit|createPlatformRecord|updatePlatformRecord|payload|validation)\b/i.test(
        content,
      );
    }
    return false;
  });
  addPreferredByPattern(preferred, files, (path, content) =>
    /\b(<form|onSubmit|handleSubmit|Save|createPlatformRecord|updatePlatformRecord|payload|schema|validation)\b/i.test(
      `${path}\n${content}`,
    ),
  );
}

function addRelatedImportNeighbors(selected: Set<string>, files: FileMap): void {
  const before = new Set(selected);
  for (const path of before) {
    const content = files[path];
    if (!content) continue;
    for (const imported of collectInternalImports(path, content, files)) {
      selected.add(imported);
    }
  }

  const selectedModuleNames = [...selected].map(moduleNameForPath);
  addByPattern(selected, files, (path, content) =>
    selectedModuleNames.some(
      (moduleName) =>
        moduleName.length > 0 &&
        content.includes(moduleName) &&
        (path.startsWith("src/app/") ||
          path.startsWith("src/components/") ||
          path.startsWith("src/lib/")),
    ),
  );
}

function addExisting(
  selected: Set<string>,
  files: FileMap,
  paths: readonly string[],
): void {
  for (const path of paths) {
    if (files[path] !== undefined) selected.add(path);
  }
}

function addByPattern(
  selected: Set<string>,
  files: FileMap,
  predicate: (path: string, content: string) => boolean,
): void {
  for (const [path, content] of Object.entries(files)) {
    if (predicate(path, content)) selected.add(path);
  }
}

function addPreferredByPattern(
  selected: Set<string>,
  files: FileMap,
  predicate: (path: string, content: string) => boolean,
): void {
  for (const [path, content] of Object.entries(files)) {
    if (predicate(path, content)) selected.add(path);
  }
}

function isGeneratedTest(path: string): boolean {
  return (
    (/^src\/.+\.(test|spec)\.tsx?$/.test(path) ||
      /^e2e\/generated\/.+\.spec\.tsx?$/.test(path)) &&
    path !== "src/lib/template.test.ts"
  );
}

function isGeneratedAppSource(path: string): boolean {
  return (
    (path.startsWith("src/app/") ||
      path.startsWith("src/components/") ||
      path.startsWith("src/lib/") ||
      path.startsWith("e2e/generated/")) &&
    !path.startsWith("src/app/api/")
  );
}

function isVisibleDebugFile(path: string): boolean {
  return (
    isGeneratedAppSource(path) ||
    CONFIG_FILES.includes(path) ||
    path.startsWith("e2e/")
  );
}

function collectInternalImports(
  sourcePath: string,
  content: string,
  files: FileMap,
): string[] {
  const imports: string[] = [];
  const importPattern = /from\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(importPattern)) {
    const target = resolveInternalImport(sourcePath, match[1], files);
    if (target) imports.push(target);
  }
  return imports;
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
    base = normalizePath(`${sourceDir}/${specifier}`);
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

function moduleNameForPath(path: string): string {
  const withoutExtension = path.replace(/\.(test|spec)?\.?tsx?$/, "");
  const parts = withoutExtension.split("/");
  return parts.at(-1) ?? "";
}

function instructionsFor(
  classification: DebugFailureClassification,
  responsiblePhase: DebugResponsiblePhase,
): string[] {
  const common = [
    `Treat this as a ${classification.domainLabel} failure, not a general rewrite.`,
    "Start with the preferred inspection files and diagnostics before editing.",
    "Keep changes in the responsible phase's surface unless the diagnostics prove the root cause crosses boundaries.",
  ];
  if (classification.focus === "data_save") {
    common.push(
      "For save/data validation failures, trace form state, payload helpers, schema keys, platform-data/localStorage calls, and post-save state refresh.",
    );
  }
  if (classification.domain === "browser_accessibility") {
    common.push(
      "For browser/accessibility failures, inspect pages and components first; edit generated e2e tests only when the test assertion is brittle.",
    );
  }
  if (classification.domain === "unit_test") {
    common.push(
      "For unit/workflow failures, inspect the failing test and source together; avoid only weakening assertions when user-visible behavior is broken.",
    );
  }
  if (classification.domain === "integration_review_gate") {
    common.push(
      "For review-gate failures, fix the generated platform/security/accessibility contract directly before the sandbox gauntlet runs.",
    );
    if (responsiblePhase.id === "pages-workflows") {
      common.push(
        "When advanced workflow coverage fails, add compact but real route/control surfaces and wire save/update/delete or runtime integration calls for the named missing entities/workflows; do not satisfy the gate with placeholders or dead buttons.",
      );
    }
    if (
      responsiblePhase.id === "unit-workflow-tests" ||
      responsiblePhase.id === "browser-acceptance-tests"
    ) {
      common.push(
        "When generated test coverage fails, add tests that exercise the named missing entities/workflows rather than only asserting that labels exist.",
      );
    }
  }
  return common;
}

function scopeReason(
  classification: DebugFailureClassification,
  limited: boolean,
): string {
  if (!limited) {
    return `The ${classification.domainLabel} failure did not have a safe narrow scope, so the debug agent can inspect the full generated app.`;
  }
  if (classification.focus === "data_save") {
    return "The failure looks like a save/data path issue, so the visible scope starts with forms, payload/domain helpers, and platform storage wrappers.";
  }
  if (classification.domain === "browser_accessibility") {
    return "Browser/accessibility failures are scoped to routes, components, and generated browser tests first.";
  }
  if (classification.domain === "unit_test") {
    return "Unit/workflow failures are scoped to generated tests, mentioned source files, and nearby imports.";
  }
  return `The visible files are focused around the ${classification.domainLabel} failure and responsible generation phase.`;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replaceAll("\\", "/").replace(/\/+/g, "/");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
