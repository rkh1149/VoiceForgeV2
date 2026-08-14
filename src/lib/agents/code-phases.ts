export type CodegenAgentKey =
  | "backend_platform_planner"
  | "frontend_builder"
  | "test_agent"
  | "final_integration_agent"
  | "diagnostic_agent"
  | "debug_agent";

export type GenerationPhase = {
  id: string;
  label: string;
  agentKey: CodegenAgentKey;
  specialistRole: string;
  objective: string;
  maxTurns: number;
  allowMutations?: boolean;
};

export const GENERATION_PHASE_CONTINUATION_TURNS = 12;

export const CODE_GENERATION_PHASES: GenerationPhase[] = [
  {
    id: "foundation",
    label: "Data, types, constants, and platform wrappers",
    agentKey: "backend_platform_planner",
    specialistRole:
      "Backend/platform builder: own typed domain models, validation, constants, storage wrappers, and locked platform client usage. Keep UI minimal and leave page composition to the frontend builder.",
    objective:
      "Create typed domain models, constants, validation helpers, storage/platform wrappers, and any AI/platform client helpers needed by later UI phases. For every planned data entity, expose create/update/delete helpers that use the exact platform schema keys when platform data is required. For large advanced apps, prefer compact shared helpers and grouped file writes so this phase finishes the whole foundation without drifting into page UI work.",
    maxTurns: 30,
  },
  {
    id: "components",
    label: "Reusable components",
    agentKey: "frontend_builder",
    specialistRole:
      "Frontend builder: own reusable React components, hooks, accessible controls, responsive layout primitives, and state handoff from the backend/platform foundation.",
    objective:
      "Create every reusable component and hook assigned to this phase by the architecture file plan, including workflow forms, lists, dialogs, session/role helpers, and responsive navigation. Give every contracted interactive control a permanent data-vf-workflow/data-vf-control identity. Shared add/edit components may select among finite literal contract ids, and equivalent workflows may reuse one canonical navigation/filter binding; repeated entity actions also need a data-vf-entity/data-vf-record container. Prefer compact shared components with clear props, group related file reads and writes, and read existing foundation files before importing from them. Do not stop after only the shell or document remaining planned components as later work.",
    maxTurns: 30,
  },
  {
    id: "pages-workflows",
    label: "Pages, navigation, and workflows",
    agentKey: "frontend_builder",
    specialistRole:
      "Frontend builder: own App Router pages, navigation, user-visible workflows, role-aware controls, empty/loading/error states, and safe button behavior.",
    objective:
      "Assemble all App Router pages and wire every planned user-visible workflow end to end. Replace the placeholder home page, create each route in the architecture page map, and expose visible create/edit/action controls for every planned editable entity and workflow. Preserve exact Stage 14G workflow/control attributes while composing components, including loading, disabled, responsive, and repeated-record variants. Advanced apps may use compact screens, but they must not defer planned routes, CRUD/save wiring, platform integrations, file upload/export, GPS, search/report, or workflow controls to later phases. Make every button safe.",
    maxTurns: 36,
  },
  {
    id: "unit-workflow-tests",
    label: "Unit and workflow tests",
    agentKey: "test_agent",
    specialistRole:
      "Test agent: own deterministic Vitest coverage for domain helpers, storage/platform wrappers, components, and acceptance-criterion workflows. Prefer robust behavior assertions over brittle text matching.",
    objective:
      "Add deterministic vitest tests under src/ for domain helpers, storage behavior, components, and acceptance-criterion workflows. For advanced apps, cover every editable entity and planned workflow with assertions that exercise save/update/delete helpers or visible workflow handlers, including platform schema key correctness. For drag/drop workflows tested with fireEvent, mock DataTransfer as a MIME-keyed store, not one shared string.",
    maxTurns: 24,
  },
  {
    id: "browser-acceptance-tests",
    label: "Browser acceptance tests",
    agentKey: "test_agent",
    specialistRole:
      "Test agent: translate every synthesized Stage 14D workflow journey into Playwright acceptance coverage. Keep tests stable, same-origin, and complementary to the locked smoke/accessibility test.",
    objective:
      "Add contract-driven Playwright acceptance tests under e2e/generated/ for every synthesized user-action journey. Locate contracted controls with the locked vfControl/vfRecord helpers using exact workflowId/controlId pairs; use friendly names as accessibility assertions, not identity. Keep bounded journeys as focused tests and place dependent journeys in the same test.describe.serial suite, but remember that every Playwright test receives a fresh browser context: recreate localStorage/sessionStorage prerequisites through visible UI inside each dependent test instead of relying on an earlier test. Capture selected result identity before completion/delete/status actions that clear it, and navigate downstream through a stable visible link rather than assuming a contextual result link remains after mutation. Exercise the ordered workflow steps through visible controls, then prove expected saves after page.reload(), downstream handoffs on their consumer routes, role behavior, downloads, uploads, drag/drop, integration fallbacks, and browser geolocation when required. Use the locked e2e/voiceforge-acceptance.ts trace helpers and never replace a promised journey with a generic page-render test.",
    maxTurns: 28,
  },
  {
    id: "final-integration-review",
    label: "Final integration review",
    agentKey: "final_integration_agent",
    specialistRole:
      "Final integration agent: inspect the generated app across foundation, components, pages, and tests. Patch only small cross-file wiring, import, route, acceptance coverage, accessibility, or platform-contract issues before the gauntlet.",
    objective:
      "Review the generated app end to end for missing routes, broken imports, unrendered workflows, unsafe platform usage, missing sign-in states, stable contract-control bindings, and obvious test gaps. Confirm each user-action contract control has one correctly placed workflowId/controlId pair and every repeated action is record-scoped. For advanced apps, treat missing planned routes, CRUD controls, integration calls, or workflow tests as blocking and patch them when practical instead of documenting them as later work. Make focused corrective patches when needed; otherwise record that no changes were necessary.",
    maxTurns: 18,
  },
];

export const CHANGE_GENERATION_PHASES: GenerationPhase[] = [
  {
    id: "inspect-change",
    label: "Inspect current app for change impact",
    agentKey: "diagnostic_agent",
    specialistRole:
      "Diagnostic agent: inspect the existing app, identify the affected workflow and files, and produce a focused change map before any mutation.",
    objective:
      "Inspect only the files likely to be affected by the requested change. Use list_files, read_file, and search_code. Do not mutate files in this phase.",
    maxTurns: 10,
    allowMutations: false,
  },
  {
    id: "apply-change",
    label: "Apply targeted source changes",
    agentKey: "frontend_builder",
    specialistRole:
      "Change builder: patch the smallest source surface needed for the approved change while preserving existing routes, style, storage shapes, and platform contracts.",
    objective:
      "Patch or rewrite only files that need to change. Preserve unrelated look, behavior, routes, localStorage data shapes, and existing data-vf workflow/control identities. Add Stage 14G bindings to newly introduced or directly modified contract controls without forcing a whole-app identity rewrite for a legacy app.",
    maxTurns: 24,
  },
  {
    id: "change-tests",
    label: "Update tests for change",
    agentKey: "test_agent",
    specialistRole:
      "Test agent: add or update deterministic tests that prove the requested change and guard against the reported regression.",
    objective:
      "Add or update unit/workflow/browser acceptance tests that cover the requested change without making brittle assertions.",
    maxTurns: 18,
  },
  {
    id: "change-integration-review",
    label: "Final change integration review",
    agentKey: "final_integration_agent",
    specialistRole:
      "Final integration agent: inspect the changed app for cross-file breakage, stale navigation, missing imports, unsafe platform usage, or acceptance/test gaps introduced by the change.",
    objective:
      "Review the changed app end to end and make only small corrective patches needed to keep the approved change integrated with existing behavior.",
    maxTurns: 12,
  },
];

export const DEEP_DIAGNOSTIC_CHANGE_PHASES: GenerationPhase[] = [
  {
    id: "classify-change",
    label: "Classify change and acceptance criteria",
    agentKey: "diagnostic_agent",
    specialistRole:
      "Diagnostic agent: classify the request, define user-visible acceptance criteria, and avoid mutation until the failure/change is clear.",
    objective:
      "Step 1: classify whether the request is a bug fix or feature change, restate the exact user-visible failure/change, and define concrete acceptance criteria before touching code.",
    maxTurns: 8,
    allowMutations: false,
  },
  {
    id: "map-current-app",
    label: "Map current app codebase",
    agentKey: "diagnostic_agent",
    specialistRole:
      "Diagnostic agent: map routes, components, domain libraries, tests, and platform/local persistence calls so the fix starts from system understanding.",
    objective:
      "Step 2: use inspect_app_map, list_files, search_code, and selective reads to map routes, components, domain libraries, tests, storage/platform-data calls, and workflow entry points. Broad source mapping is allowed in this diagnostic phase, but keep the notes focused.",
    maxTurns: 16,
    allowMutations: false,
  },
  {
    id: "trace-workflow",
    label: "Trace broken workflow end to end",
    agentKey: "diagnostic_agent",
    specialistRole:
      "Diagnostic agent: trace the workflow from UI event through validation, persistence, state refresh, rendering, and tests before choosing files to modify.",
    objective:
      "Step 3: trace the requested workflow end to end through page, component, form/control handler, validation, data payload, platform-data or localStorage wrapper, state refresh, rendering, and persistence. Identify the likely root cause and the exact files to change.",
    maxTurns: 18,
    allowMutations: false,
  },
  {
    id: "write-reproduction-tests",
    label: "Write reproduction tests first",
    agentKey: "test_agent",
    specialistRole:
      "Test agent: write a deterministic failing/proving test for the bug or requested behavior before the root-cause source fix.",
    objective:
      "Step 4: add or update deterministic unit/workflow tests that reproduce the requested bug or prove the requested behavior before making the source fix. For Save-style issues, test fill fields, click Save, visible result, and persistence/refresh when practical. For drag/drop bugs, use a MIME-keyed DataTransfer mock so custom JSON payloads and text/plain fallbacks do not overwrite each other.",
    maxTurns: 20,
  },
  {
    id: "apply-root-cause-fix",
    label: "Apply root-cause fix",
    agentKey: "frontend_builder",
    specialistRole:
      "Root-cause fixer: repair the source workflow identified by diagnostics, including domain/platform helper changes when necessary, without symptom-only test edits.",
    objective:
      "Step 5: patch the actual root cause identified by the workflow trace. Fix the workflow rather than only loosening tests. Preserve unrelated routes, styling, data shapes, and existing behavior.",
    maxTurns: 30,
  },
  {
    id: "browser-regression-tests",
    label: "Add browser regression coverage",
    agentKey: "test_agent",
    specialistRole:
      "Test agent: add or update Playwright coverage for the real browser path when the workflow can be tested reliably.",
    objective:
      "Step 6: add or update Playwright tests under e2e/generated/ for the user-visible workflow when it can be tested reliably. Cover the real browser path and avoid brittle selectors, duplicate smoke coverage, external requests, or arbitrary waits.",
    maxTurns: 18,
  },
  {
    id: "stabilize-escalation",
    label: "Stabilize repeated-change fix",
    agentKey: "final_integration_agent",
    specialistRole:
      "Final integration agent: review prior failed strategies, verify the fix is root-cause based, and make small integration corrections before the gauntlet.",
    objective:
      "Step 7: when this mode was triggered by prior failed changes or bug-like wording, review the previous notes and tests, make final small corrections, and confirm the fix changed strategy from symptom-patching to root-cause repair.",
    maxTurns: 14,
  },
];
