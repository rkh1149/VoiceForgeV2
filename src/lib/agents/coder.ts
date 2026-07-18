import { Agent, run, user } from "@openai/agents";
import type { AppSpec } from "@/lib/spec";
import type { ArchitecturePlan } from "@/lib/architecture";
import type { FileMap } from "@/lib/build/template";
import {
  createAgentFileTools,
  type DiagnosticsContext,
  type FileOperation,
} from "@/lib/agents/file-tools";
import {
  selectChangeWorkflow,
  type ChangeWorkflow,
} from "@/lib/agents/change-workflow";
import { platformEntityFromSpec } from "@/lib/platform/spec-seeding";
import { APPROVED_DEPENDENCY_GUIDANCE } from "../build/dependencies";

/**
 * Code Agent + Debug Agent.
 *
 * Stage 8C changes generation from one giant pass into explicit phases with
 * file navigation tools. Mutations still go through the same path policy:
 * generated app source/tests only, no configs, no package.json, no API routes.
 */

const CODER_MODEL = process.env.OPENAI_CODER_MODEL ?? "gpt-5.6-terra";

const SHARED_RULES = `Rules for all files you mutate:
- This is a Next.js 15 App Router project with TypeScript (strict) and Tailwind CSS 4. React 19.
- You may ONLY mutate approved generated-app files via write_file, patch_file, delete_file, or rename_file: src/app/, src/components/, src/lib/, and e2e/generated/. package.json, configs, src/app/globals.css, src/lib/template.test.ts, e2e/smoke.spec.ts, and all API routes are locked.
- The app must work through browser code plus locked platform endpoints only: no direct databases, no API keys, no arbitrary external services. If data is personal/browser-only, use localStorage inside client components ("use client") with a typed wrapper in src/lib/storage.ts. If the architecture data model uses storage:"platformData", use the locked src/lib/platform-data.ts client and the locked /api/data endpoint as the source of truth instead of localStorage. If the architecture includes file requirements, use src/lib/platform-files.ts and /api/files for uploads, downloads, metadata, and delete/archive.
- src/app/api/ai/route.ts, src/app/api/data/route.ts, and src/app/api/files/route.ts are LOCKED platform files — never modify, overwrite, or reimplement them, and never create any other file under src/app/api/.
- For platform data, import from src/lib/platform-data.ts. Call listPlatformRecords, createPlatformRecord, updatePlatformRecord, and deletePlatformRecord from client components. For apps that require sign-in or roles, also call getPlatformSession, signInToPlatform, and signOutPlatformSession; show signed-out, no-access, current-user, and read-only viewer states, and hide/disable write controls when session.canWrite is false. In sign-in-required apps, ALWAYS call getPlatformSession first and store the returned session before calling listPlatformRecords/listPlatformFiles; if session.status is "signed_out" or "no_access", do not fetch records/files yet. Render a visible sign-in action on every route while signed out, preferably PlatformSignInGate from src/components/voiceforge-reusable.tsx. Never fetch session and records/files in the same Promise.all for sign-in-required apps because the data call can fail before the app preserves session.loginUrl. Use the exact platform entity keys and field keys from PLATFORM DATA SCHEMA KEYS, not display labels, plural guesses, PascalCase names, or camelCase aliases. Always show loading and error states. NEVER reference VOICEFORGE_APP_TOKEN, VOICEFORGE_PUBLIC_URL, or the VoiceForge platform URL in browser code.
- For platform files, import from src/lib/platform-files.ts. Call listPlatformFiles, uploadPlatformFile, downloadPlatformFile, downloadPlatformFileToBrowser, and deletePlatformFile from client components. Link files to records by passing recordId when an attachment belongs to a saved record. Show file type/size/upload errors, preview images from downloadPlatformFile dataUrl when appropriate, and hide upload/delete controls when session.canWrite is false. Do NOT store uploaded files or images in localStorage for shared/platform apps.
- Prefer the locked PlatformFileUploadInput from src/components/voiceforge-reusable.tsx for attachment uploads. If you write a custom <input type="file"> handler, capture const input = event.currentTarget and const file = input.files?.[0] before any await; after the await, reset input.value in finally. Never read event.currentTarget after an awaited upload because React clears it and tests will fail.
- Stage 10/11 reusable modules are available in the locked template. Prefer importing from src/lib/voiceforge-modules.ts and src/components/voiceforge-reusable.tsx for common CRUD helpers, search/filter/sort, comments, activity history, dashboard charts, CSV import/export, simple PDF export, date/calendar controls, drag/drop lists, platform file upload controls, PlatformSignInGate, and role-aware shells.
- You may import only approved packages from the catalogue below. Never ask to add a package, never edit package.json, and never use CDN/external script URLs.
${APPROVED_DEPENDENCY_GUIDANCE}
- CRITICAL: every page is prerendered on the server at build time, where window/localStorage do not exist. Never touch window or localStorage at module scope, in useState initializers, or during render — ONLY inside useEffect. Initialize state to defaults, then load saved data in a useEffect after mount.
- If a component uses useSearchParams, wrap that component in a React <Suspense> boundary from every page that renders it, with a simple fallback. This prevents Next.js prerender build failures. Keep useSearchParams inside client components only.
- Do not create pages/, src/pages/, 404.tsx, 500.tsx, _document, or _app files — this is App Router only (use not-found.tsx / error.tsx if genuinely needed).
- NEVER reference static asset files (mp3, images, fonts, videos) — you cannot create them, so any such path will 404. And NEVER reference EXTERNAL media URLs either: no stock-photo sites, no Unsplash, no placeholder services (placehold.co etc.), no CDNs, no invented hostnames — the app must be fully self-contained and the browser test fails on ANY external request. For sound, synthesize it with the Web Audio API. For graphics and decoration, use inline SVG, CSS gradients, or emoji. For photos/files the user mentions, build an upload feature; use platform files for shared/platform apps, and use small localStorage data URLs only for personal browser-only apps. For generated pictures, use the AI image mode if this app has AI features.
- Style with Tailwind utility classes only. Mobile-first, readable, generous touch targets. The app is used by non-technical family members.
- Accessibility: semantic HTML, labels on inputs, alt text, keyboard operability.
- Write unit/workflow tests under src/ using vitest + @testing-library/react (both installed; jest-dom matchers like toBeInTheDocument are set up). Tests must not rely on localStorage persisting between tests.
- Write browser acceptance tests only under e2e/generated/*.spec.ts. Never edit e2e/smoke.spec.ts.
- Tests must be deterministic: NEVER use vi.useFakeTimers, real delays, or arbitrary waits. Never use setTimeout/setInterval in components for game or app logic — apply state updates synchronously (skip artificial "thinking" pauses; they break tests and add nothing). In tests use fireEvent from @testing-library/react (@testing-library/user-event is NOT installed) then findBy*/waitFor.
- Write robust test assertions: query by role or aria-label on unique interactive elements, never by text that appears in more than one place or is split across elements (e.g. "0:13 / 0:37" rendered from multiple spans). Prefer getByRole(..., {name}) over getByLabelText when labels may be duplicated by helper text. If a Vitest vi.mock factory references mock functions, define them with vi.hoisted. Fewer, stronger assertions beat many brittle ones. Don't assert on intermediate states that depend on effect timing. For controlled form component tests, pass a complete valid draft or rerender with the changed draft before expecting onSubmit; do not expect a child component to mutate parent props synchronously.
- A locked BROWSER TEST runs against every build: it loads /, presses visible buttons, and fails on any JavaScript error, any 404'd resource, or any serious axe accessibility violation. Therefore: the home page must render standalone with sensible defaults, every button must be safe to press in any order without crashing, and accessibility must be real — labels on all inputs and icon-only buttons (aria-label), alt text, sufficient color contrast (no light gray on white backgrounds usually fails), and one h1 per page. During VoiceForge's local browser tests, /api/data and /api/files use safe local fallbacks so platform data/file workflows can be tested before deployment.
- src/app/layout.tsx already exists with correct metadata; only rewrite it if the app truly needs a different shell, and keep the import of "./globals.css".
- Every page must compile under strict TypeScript and pass eslint (next/core-web-vitals). No unused variables, no explicit any.`;

type GenerationPhase = {
  id: string;
  label: string;
  objective: string;
  maxTurns: number;
  allowMutations?: boolean;
};

export const CODE_GENERATION_PHASES: GenerationPhase[] = [
  {
    id: "foundation",
    label: "Data, types, constants, and platform wrappers",
    objective:
      "Create typed domain models, constants, validation helpers, localStorage wrappers, and any AI/platform client helpers needed by later UI phases. Keep UI work minimal in this phase.",
    maxTurns: 18,
  },
  {
    id: "components",
    label: "Reusable components",
    objective:
      "Create reusable components, hooks, and focused UI building blocks. Prefer small components with clear props. Read existing foundation files before importing from them.",
    maxTurns: 22,
  },
  {
    id: "pages-workflows",
    label: "Pages, navigation, and workflows",
    objective:
      "Assemble App Router pages and wire the main workflows end to end. Replace the placeholder home page, add routes when the architecture calls for them, and make every button safe.",
    maxTurns: 28,
  },
  {
    id: "unit-workflow-tests",
    label: "Unit and workflow tests",
    objective:
      "Add deterministic vitest tests under src/ for domain helpers, storage behavior, components, and acceptance-criterion workflows.",
    maxTurns: 20,
  },
  {
    id: "browser-acceptance-tests",
    label: "Browser acceptance tests",
    objective:
      "Add Playwright acceptance tests under e2e/generated/ for core user-visible workflows that can be tested reliably. Keep them robust and avoid duplicating the locked smoke test.",
    maxTurns: 16,
  },
];

const CHANGE_GENERATION_PHASES: GenerationPhase[] = [
  {
    id: "inspect-change",
    label: "Inspect current app for change impact",
    objective:
      "Inspect only the files likely to be affected by the requested change. Use list_files, read_file, and search_code. Do not mutate files in this phase.",
    maxTurns: 10,
    allowMutations: false,
  },
  {
    id: "apply-change",
    label: "Apply targeted source changes",
    objective:
      "Patch or rewrite only files that need to change. Preserve unrelated look, behavior, routes, and localStorage data shapes.",
    maxTurns: 24,
  },
  {
    id: "change-tests",
    label: "Update tests for change",
    objective:
      "Add or update unit/workflow/browser acceptance tests that cover the requested change without making brittle assertions.",
    maxTurns: 18,
  },
];

const DEEP_DIAGNOSTIC_CHANGE_PHASES: GenerationPhase[] = [
  {
    id: "classify-change",
    label: "Classify change and acceptance criteria",
    objective:
      "Step 1: classify whether the request is a bug fix or feature change, restate the exact user-visible failure/change, and define concrete acceptance criteria before touching code.",
    maxTurns: 8,
    allowMutations: false,
  },
  {
    id: "map-current-app",
    label: "Map current app codebase",
    objective:
      "Step 2: use inspect_app_map, list_files, search_code, and selective reads to map routes, components, domain libraries, tests, storage/platform-data calls, and workflow entry points. Broad source mapping is allowed in this diagnostic phase, but keep the notes focused.",
    maxTurns: 16,
    allowMutations: false,
  },
  {
    id: "trace-workflow",
    label: "Trace broken workflow end to end",
    objective:
      "Step 3: trace the requested workflow end to end through page, component, form/control handler, validation, data payload, platform-data or localStorage wrapper, state refresh, rendering, and persistence. Identify the likely root cause and the exact files to change.",
    maxTurns: 18,
    allowMutations: false,
  },
  {
    id: "write-reproduction-tests",
    label: "Write reproduction tests first",
    objective:
      "Step 4: add or update deterministic unit/workflow tests that reproduce the requested bug or prove the requested behavior before making the source fix. For Save-style issues, test fill fields, click Save, visible result, and persistence/refresh when practical.",
    maxTurns: 20,
  },
  {
    id: "apply-root-cause-fix",
    label: "Apply root-cause fix",
    objective:
      "Step 5: patch the actual root cause identified by the workflow trace. Fix the workflow rather than only loosening tests. Preserve unrelated routes, styling, data shapes, and existing behavior.",
    maxTurns: 30,
  },
  {
    id: "browser-regression-tests",
    label: "Add browser regression coverage",
    objective:
      "Step 6: add or update Playwright tests under e2e/generated/ for the user-visible workflow when it can be tested reliably. Cover the real browser path and avoid brittle selectors, duplicate smoke coverage, external requests, or arbitrary waits.",
    maxTurns: 18,
  },
  {
    id: "stabilize-escalation",
    label: "Stabilize repeated-change fix",
    objective:
      "Step 7: when this mode was triggered by prior failed changes or bug-like wording, review the previous notes and tests, make final small corrections, and confirm the fix changed strategy from symptom-patching to root-cause repair.",
    maxTurns: 14,
  },
];

export type GenerationPhaseResult = {
  id: string;
  label: string;
  filesWritten: string[];
  filesDeleted: string[];
  notes: string;
};

export type CodegenResult = {
  files: FileMap; // newly written or changed files only
  deletedFiles: string[];
  notes: string;
  filesWritten: string[];
  phases: GenerationPhaseResult[];
  operations: FileOperation[];
};

export type DebugResult = CodegenResult;

/** Extra guidance injected only when the spec includes AI features. */
export function aiUsageNote(spec: AppSpec): string {
  if (spec.aiFeatures.length === 0) return "";
  return `

THIS APP HAS AI FEATURES. Use the locked platform endpoint for ALL of them:
- TEXT: POST /api/ai with JSON {prompt: string, system?: string} → responds {text: string}, or {error: string} with status 400/429/502/503.
- IMAGES: POST /api/ai with JSON {mode: "image", prompt: string} → responds {imageBase64: string} — a REAL PNG. Render it as <img src={\`data:image/png;base64,\${imageBase64}\`} alt="…" />. Image generation takes 5–20 seconds: show a clear loading state. Images have a SMALLER daily limit than text.
- NEVER ask the text mode to produce an image, base64, SVG-as-text, or any binary data — language models cannot generate valid images; always use mode:"image" for pictures.
- Do NOT store generated images in localStorage (a few images exceed the 5 MB quota and break the app) — keep at most the latest image in component state, and offer a download link (anchor with the data URL and a download attribute) if the user should keep it.
- Call the endpoint with fetch from client components; always show a loading state while waiting.
- If the response is not ok, display the error message to the user politely (daily limits exist — 429 means "come back tomorrow").
- Keep prompts under 4000 characters. Craft a good "system" string so text answers fit this app's purpose and audience.
- NEVER call OpenAI or any external AI service directly, never reference API keys, and never modify src/app/api/ai/route.ts.
- In tests, mock global.fetch for /api/ai calls — never let tests hit the network.`;
}

export function architectureNote(architecture?: ArchitecturePlan): string {
  if (!architecture) return "";
  return `

ARCHITECTURE PLAN TO FOLLOW:
${JSON.stringify(architecture, null, 2)}

Use the architecture plan as the source of implementation structure: routes, components, data model, file plan, workflow coverage, and tests. Do not implement services marked unavailable or future-platform. If a detail conflicts with the shared rules, the shared rules win.`;
}

export function platformDataSchemaNote(spec: AppSpec): string {
  if (spec.dataEntities.length === 0) return "";
  const entities = spec.dataEntities.map((entity) =>
    platformEntityFromSpec(entity, spec),
  );
  return `

PLATFORM DATA SCHEMA KEYS:
${JSON.stringify(entities, null, 2)}

When using platform data, every list/create/update/delete call must use entity.key exactly, and every record payload must contain only field.key properties exactly. UI labels may be friendly, but persisted data must use these keys. Add tests around save workflows that assert createPlatformRecord receives these exact schema keys; local browser tests validate against this schema.`;
}

export async function runCodeAgent(input: {
  spec: AppSpec;
  architecture?: ArchitecturePlan;
  baseFiles?: FileMap;
}): Promise<CodegenResult> {
  const workspaceFiles: FileMap = { ...(input.baseFiles ?? {}) };
  const operations: FileOperation[] = [];
  const phaseResults: GenerationPhaseResult[] = [];

  for (const phase of CODE_GENERATION_PHASES) {
    const phaseResult = await runGenerationPhase({
      mode: "new",
      phase,
      spec: input.spec,
      architecture: input.architecture,
      workspaceFiles,
      operations,
      previousPhases: phaseResults,
    });
    phaseResults.push(phaseResult);
  }

  return collectCodegenResult(workspaceFiles, operations, phaseResults);
}

/** Change mode: modify an existing app's source instead of regenerating. */
export async function runChangeCodeAgent(input: {
  spec: AppSpec; // the UPDATED spec
  changeSummary: string;
  currentFiles: FileMap; // current generated-app files from the live app
  architecture?: ArchitecturePlan;
  forceDeepDiagnostic?: boolean;
  previousFailedChangeCount?: number;
}): Promise<CodegenResult> {
  const workspaceFiles: FileMap = { ...input.currentFiles };
  const operations: FileOperation[] = [];
  const phaseResults: GenerationPhaseResult[] = [];
  const changeWorkflow = selectChangeWorkflow({
    changeSummary: input.changeSummary,
    forceDeepDiagnostic: input.forceDeepDiagnostic,
    previousFailedChangeCount: input.previousFailedChangeCount,
  });
  const phases =
    changeWorkflow.mode === "deep-diagnostic"
      ? DEEP_DIAGNOSTIC_CHANGE_PHASES
      : CHANGE_GENERATION_PHASES;

  for (const phase of phases) {
    const phaseResult = await runGenerationPhase({
      mode: "change",
      phase,
      spec: input.spec,
      architecture: input.architecture,
      workspaceFiles,
      operations,
      previousPhases: phaseResults,
      changeSummary: input.changeSummary,
      changeWorkflow,
    });
    phaseResults.push(phaseResult);
  }

  return collectCodegenResult(workspaceFiles, operations, phaseResults);
}

export async function runDebugAgent(input: {
  spec: AppSpec;
  currentFiles: FileMap; // generated-app files only
  failedStep: string;
  errorOutput: string;
  previousAttempts: string[]; // notes from earlier debug rounds this build
}): Promise<DebugResult> {
  const workspaceFiles: FileMap = { ...input.currentFiles };
  const operations: FileOperation[] = [];
  const diagnostics: DiagnosticsContext = {
    failedStep: input.failedStep,
    errorOutput: input.errorOutput,
    typeErrors: input.failedStep === "typecheck" ? input.errorOutput : undefined,
    testResults: ["lint", "test", "build"].includes(input.failedStep)
      ? input.errorOutput
      : undefined,
    browserFailure: input.failedStep === "e2e" ? input.errorOutput : undefined,
  };

  const agent = new Agent({
    name: "VoiceForge Debug Agent",
    model: CODER_MODEL,
    instructions: `You are an expert Next.js developer fixing a broken generated app. Use list_files, read_file, search_code, and the inspect_* diagnostic tools to identify the root cause. Rewrite or patch ONLY the files that need to change. Keep changes minimal. When finished, reply with one short paragraph explaining the cause and fix.

Known failure signatures:
- "next build" failing while prerendering /404, /500, or /_error with "<Html> should not be imported outside of pages/_document": a component threw during server prerendering — almost always window or localStorage accessed at module scope, in a useState initializer, or during render. Find that component and move the access into useEffect. Do NOT create 404.tsx/500.tsx/_document/_error files; they are not valid in the App Router and will not fix this.
- "useSearchParams() should be wrapped in a suspense boundary": find every page that renders the client component using useSearchParams and wrap that component in <Suspense fallback={...}> from React. Prefer a small page-level wrapper over forcing the page dynamic.
- "Cannot set properties of null (setting 'value')" from a file input handler: the code read event.currentTarget after an awaited upload. Capture const input = event.currentTarget before await, capture the File before await, and reset input.value in finally.
- "Please sign in" renders with no working sign-in button/link or disabled sign-in forever: load getPlatformSession first, store session.loginUrl, stop fetching records/files while signed_out/no_access, and render PlatformSignInGate or a visible button that calls signInToPlatform(session) from every route.
- The "e2e" step failing: this is the locked browser test plus generated acceptance tests. Its failure messages name the exact problem: JavaScript errors, missing files, external URLs, accessibility violations, or brittle generated acceptance assertions. Prefer fixing the component. If a generated acceptance test is brittle, simplify it under e2e/generated/; never edit e2e/smoke.spec.ts.
- If an earlier attempt already rewrote the SAME test for the same failure, change strategy: fix the component or simplify the test.

${SHARED_RULES}`,
    tools: createAgentFileTools(workspaceFiles, {
      mutationLog: operations,
      diagnostics,
    }),
  });

  const previousSection =
    input.previousAttempts.length > 0
      ? `\nEARLIER FIX ATTEMPTS THIS BUILD (they did NOT resolve the failure):\n${input.previousAttempts
          .map((n, i) => `Attempt ${i + 1}: ${n}`)
          .join("\n")}\n`
      : "";

  const message = `The step "${input.failedStep}" failed.
${previousSection}
Use inspect_test_results, inspect_type_errors, or inspect_browser_failure as appropriate.

APP SPECIFICATION:
${JSON.stringify(input.spec, null, 2)}
${platformDataSchemaNote(input.spec)}

ERROR OUTPUT TAIL:
${input.errorOutput}

Current files are available through list_files/read_file/search_code. Fix the problem.${aiUsageNote(input.spec)}`;

  const result = await run(agent, [user(message)], { maxTurns: 25 });
  const phaseResult = makePhaseResult({
    phase: {
      id: "debug",
      label: `Debug ${input.failedStep}`,
      objective: "Fix the failing build step.",
      maxTurns: 25,
    },
    operations,
    operationStart: 0,
    workspaceFiles,
    notes: extractText(result.output),
  });

  return collectCodegenResult(workspaceFiles, operations, [phaseResult]);
}

async function runGenerationPhase(input: {
  mode: "new" | "change";
  phase: GenerationPhase;
  spec: AppSpec;
  architecture?: ArchitecturePlan;
  workspaceFiles: FileMap;
  operations: FileOperation[];
  previousPhases: GenerationPhaseResult[];
  changeSummary?: string;
  changeWorkflow?: ChangeWorkflow;
}): Promise<GenerationPhaseResult> {
  const operationStart = input.operations.length;
  const agent = new Agent({
    name: `VoiceForge ${input.mode === "new" ? "Code" : "Change"} Agent - ${input.phase.label}`,
    model: CODER_MODEL,
    instructions: `${input.mode === "new" ? "You are building a new generated app" : "You are modifying an existing generated app"} in a controlled multi-phase pipeline. Complete only the current phase. Use list_files, read_file, and search_code to understand existing files before importing from or patching them. Reply with a concise phase summary and any limitations.

Current phase: ${input.phase.label}
Objective: ${input.phase.objective}
${changeWorkflowInstruction(input.changeWorkflow)}

${SHARED_RULES}`,
    tools: createAgentFileTools(input.workspaceFiles, {
      mutationLog: input.operations,
      allowMutations: input.phase.allowMutations,
    }),
  });

  const previous =
    input.previousPhases.length > 0
      ? `\nPREVIOUS PHASE NOTES:\n${input.previousPhases
          .map(
            (phase) =>
              `- ${phase.label}: ${phase.notes || "no notes"} (${phase.filesWritten.length} changed, ${phase.filesDeleted.length} deleted)`,
          )
          .join("\n")}\n`
      : "";
  const change =
    input.mode === "change"
      ? `\nREQUESTED CHANGE:\n${input.changeSummary ?? "Apply the approved specification update."}\n${changeWorkflowMessage(input.changeWorkflow)}`
      : "";

  const message = `${input.mode === "new" ? "Build" : "Update"} this app through the current phase only.
${change}${previous}
APP SPECIFICATION:
${JSON.stringify(input.spec, null, 2)}
${architectureNote(input.architecture)}
${platformDataSchemaNote(input.spec)}

Use the file tools instead of assuming file contents. ${
    input.mode === "change"
      ? input.changeWorkflow?.mode === "deep-diagnostic"
        ? "Deep diagnostic mode is active: start with inspect_app_map when mapping or tracing, then read every file that participates in the requested workflow. You may inspect broadly to understand cross-file behavior, but keep edits scoped to the root cause."
        : "Standard change mode is active: search and inspect the files likely impacted by the targeted change."
      : "List files first if you need to know what earlier phases created."
  }
${aiUsageNote(input.spec)}`;

  const result = await run(agent, [user(message)], {
    maxTurns: input.phase.maxTurns,
  });

  return makePhaseResult({
    phase: input.phase,
    operations: input.operations,
    operationStart,
    workspaceFiles: input.workspaceFiles,
    notes: extractText(result.output),
  });
}

function changeWorkflowInstruction(workflow?: ChangeWorkflow): string {
  if (!workflow || workflow.mode !== "deep-diagnostic") return "";
  return `

DEEP DIAGNOSTIC CHANGE MODE:
- Trigger reasons: ${workflow.reasons.join("; ")}.
- Follow the seven-step workflow across the phases: classify, map, trace, reproduce with tests, fix root cause, add browser coverage, and stabilize repeated-change fixes.
- Treat Save/Submit bugs as cross-cutting until proven otherwise: trace form state, validation, payload shape, platform-data/localStorage calls, state refresh, rendering, and persistence.
- Do not only rewrite tests to pass. A reproduction test may be updated for robustness, but the source workflow must be repaired when behavior is broken.
- If this mode was triggered after failed changes, change strategy and explicitly avoid repeating a symptom-only patch.`;
}

function changeWorkflowMessage(workflow?: ChangeWorkflow): string {
  if (!workflow) return "";
  const focus = workflow.acceptanceFocus
    .map((item) => `- ${item}`)
    .join("\n");
  return `
CHANGE WORKFLOW MODE: ${workflow.mode}
MODE REASONS: ${workflow.reasons.join("; ")}
ACCEPTANCE FOCUS:
${focus}
`;
}

function makePhaseResult(input: {
  phase: GenerationPhase;
  operations: FileOperation[];
  operationStart: number;
  workspaceFiles: FileMap;
  notes: string;
}): GenerationPhaseResult {
  const phaseOperations = input.operations.slice(input.operationStart);
  const filesWritten = pathsWithContent(input.workspaceFiles, phaseOperations);
  const filesDeleted = deletedPaths(phaseOperations);
  return {
    id: input.phase.id,
    label: input.phase.label,
    filesWritten,
    filesDeleted,
    notes: input.notes,
  };
}

function collectCodegenResult(
  workspaceFiles: FileMap,
  operations: FileOperation[],
  phases: GenerationPhaseResult[],
): CodegenResult {
  const filesWritten = pathsWithContent(workspaceFiles, operations);
  const deletedFiles = deletedPaths(operations);
  const files: FileMap = {};
  for (const filePath of filesWritten) {
    const content = workspaceFiles[filePath];
    if (content !== undefined) files[filePath] = content;
  }
  const notes = phases
    .map((phase) => `${phase.label}: ${phase.notes || "No notes."}`)
    .join("\n");

  return {
    files,
    deletedFiles,
    notes,
    filesWritten,
    phases,
    operations,
  };
}

function pathsWithContent(
  workspaceFiles: FileMap,
  operations: FileOperation[],
): string[] {
  const paths = new Set<string>();
  for (const operation of operations) {
    const filePath =
      operation.operation === "rename" ? operation.targetPath : operation.path;
    if (filePath && workspaceFiles[filePath] !== undefined) {
      paths.add(filePath);
    }
  }
  return [...paths].sort();
}

function deletedPaths(operations: FileOperation[]): string[] {
  const paths = new Set<string>();
  for (const operation of operations) {
    if (operation.operation === "delete" || operation.operation === "rename") {
      paths.add(operation.path);
    }
  }
  return [...paths].sort();
}

/** Collect non-empty assistant text (same reasoning-model quirk as planner). */
function extractText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    const msg = item as {
      type?: string;
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (msg.type === "message" && msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === "output_text" && c.text?.trim()) parts.push(c.text.trim());
      }
    }
  }
  return parts.join("\n\n");
}
