import { describe, expect, it } from "vitest";
import {
  createFallbackArchitecturePlan,
  type ArchitecturePlan,
} from "../architecture";
import { computeSpecComplexity, normalizeAppSpec } from "../spec";
import type { WorkflowContract } from "../workflow-contract";
import {
  assessWorkflowRepairCandidate,
  classifyWorkflowRepairFailure,
  createWorkflowRepairPackage,
  restoreWorkflowRepairPackages,
  selectWorkflowRepairIssueCluster,
  validateWorkflowRepairMutationScope,
} from "./workflow-repair";
import type { FileMap } from "./template";

const spec = normalizeAppSpec({
  appName: "Bike Journey Planner",
  purpose: "Calculate, save, and track bicycle routes.",
  targetUsers: "Family riders",
  screens: [
    { name: "Explore", description: "Calculate bicycle routes." },
    { name: "GPS", description: "Track a saved route." },
    { name: "Journal", description: "Record ride notes." },
  ],
  features: ["Calculate routes", "Save routes", "Track saved routes"],
  dataToStore: ["route options", "GPS points"],
  needsLogin: true,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Save a route and open it in GPS"],
  deploymentNotes: "",
});

spec.dataEntities = [
  {
    name: "Route Option",
    description: "A calculated route saved for tracking.",
    ownership: "shared",
    fields: [
      {
        name: "route_name",
        label: "Route name",
        type: "text",
        required: true,
        validation: "Required",
      },
      {
        name: "encoded_polyline",
        label: "Route geometry",
        type: "long_text",
        required: true,
        validation: "Required",
      },
    ],
    relationships: [],
  },
];
spec.workflows = [
  {
    name: "Save calculated route",
    actor: "Editor",
    trigger: "A route is calculated",
    steps: ["Calculate", "Save route"],
    successOutcome: "The route is saved for GPS.",
    failureStates: ["Route service unavailable"],
  },
  {
    name: "Track saved route",
    actor: "Rider",
    trigger: "Rider opens GPS",
    steps: ["Choose a saved route", "Start tracking"],
    successOutcome: "The saved route is visible in GPS.",
    failureStates: ["No saved routes"],
  },
];

const saveRoute: WorkflowContract = {
  id: "save-calculated-route",
  name: "Save calculated route",
  actor: { persona: "Rider", roles: ["owner", "editor"] },
  trigger: "user_action",
  start: { route: "/explore", screen: "Explore", preconditions: [] },
  controls: [
    {
      id: "calculate-routes",
      kind: "button",
      accessibleName: "Calculate bike routes",
      route: "/explore",
      roles: ["owner", "editor"],
      action: "Calculate route options",
    },
    {
      id: "save-route",
      kind: "button",
      accessibleName: "Save route to trip",
      route: "/explore",
      roles: ["owner", "editor"],
      action: "Save the selected route",
    },
  ],
  steps: [
    {
      id: "calculate-route-options",
      description: "Calculate bicycle routes",
      kind: "action",
      route: "/explore",
      controlId: "calculate-routes",
      reads: [],
      writes: [],
      visibleResult: "Route alternatives appear.",
    },
    {
      id: "save-route-record",
      description: "Save selected route",
      kind: "save",
      route: "/explore",
      controlId: "save-route",
      reads: [],
      writes: ["route_option"],
      visibleResult: "Route saved.",
    },
  ],
  requiredData: [
    {
      entityName: "Route Option",
      entityKey: "route_option",
      operations: ["create", "read"],
      requiredFieldKeys: ["route_name", "encoded_polyline"],
    },
  ],
  expectedSaves: [
    {
      stepId: "save-route-record",
      operation: "create",
      entityName: "Route Option",
      entityKey: "route_option",
      fieldKeys: ["route_name", "encoded_polyline"],
      storage: "platformData",
      producedReference: "route_option.id",
    },
  ],
  success: {
    message: "Route saved.",
    visibleResult: "Saved route is available to GPS.",
    route: "/explore",
  },
  failureStates: ["Route service unavailable"],
  handoffs: [
    {
      id: "saved-route-to-gps",
      fromStepId: "save-route-record",
      produces: "route_option.id",
      storage: "platformData",
      consumerWorkflowId: "track-saved-route",
      consumerRoute: "/gps",
      consumerControlId: "route-to-track",
      loadRule: "Load saved route_option records into Route to track.",
    },
  ],
  dependencies: { workflowIds: [], platformServices: ["data", "integrations"] },
  source: {
    workflowName: "Save calculated route",
    acceptanceCriteria: ["A calculated route can be saved and selected in GPS."],
    testScenarios: ["Save a route, open GPS, and select it."],
  },
};

const trackRoute: WorkflowContract = {
  id: "track-saved-route",
  name: "Track saved route",
  actor: { persona: "Rider", roles: ["owner", "editor"] },
  trigger: "user_action",
  start: {
    route: "/gps",
    screen: "GPS",
    preconditions: ["A route has been saved"],
  },
  controls: [
    {
      id: "route-to-track",
      kind: "combobox",
      accessibleName: "Route to track",
      route: "/gps",
      roles: ["owner", "editor"],
      action: "Choose a saved route",
    },
    {
      id: "start-tracking",
      kind: "button",
      accessibleName: "Start GPS tracking",
      route: "/gps",
      roles: ["owner", "editor"],
      action: "Start tracking",
    },
  ],
  steps: [
    {
      id: "load-saved-routes",
      description: "Load saved routes",
      kind: "automatic",
      route: "/gps",
      controlId: "",
      reads: ["route_option"],
      writes: [],
      visibleResult: "Saved routes appear in Route to track.",
    },
    {
      id: "choose-route",
      description: "Choose route",
      kind: "input",
      route: "/gps",
      controlId: "route-to-track",
      reads: ["route_option"],
      writes: [],
      visibleResult: "Selected route appears.",
    },
  ],
  requiredData: [
    {
      entityName: "Route Option",
      entityKey: "route_option",
      operations: ["read"],
      requiredFieldKeys: ["route_name", "encoded_polyline"],
    },
  ],
  expectedSaves: [],
  success: {
    message: "Tracking started.",
    visibleResult: "Selected route appears in GPS.",
    route: "/gps",
  },
  failureStates: ["No routes saved"],
  handoffs: [],
  dependencies: {
    workflowIds: ["save-calculated-route"],
    platformServices: ["data", "device_location"],
  },
  source: {
    workflowName: "Track saved route",
    acceptanceCriteria: ["Saved routes appear in GPS."],
    testScenarios: ["Choose a saved route."],
  },
};

const architecture: ArchitecturePlan = {
  ...createFallbackArchitecturePlan(spec, computeSpecComplexity(spec)),
  pageMap: [
    {
      route: "/explore",
      name: "Explore",
      purpose: "Calculate routes",
      primaryComponents: ["ExplorePage"],
      workflows: ["Save calculated route"],
    },
    {
      route: "/gps",
      name: "GPS",
      purpose: "Track routes",
      primaryComponents: ["GpsPage"],
      workflows: ["Track saved route"],
    },
  ],
  workflowContracts: [saveRoute, trackRoute],
};

const files: FileMap = {
  "src/app/explore/page.tsx":
    'import { saveRoute } from "@/lib/routes"; export default function Explore(){ return <button onClick={saveRoute}>Save route to trip</button>; }',
  "src/app/gps/page.tsx":
    'import { loadRoutes } from "@/lib/routes"; export default function Gps(){ const routes = loadRoutes(); return <select aria-label="Route to track">{routes.map(route => <option key={route.id}>{route.route_name}</option>)}</select>; }',
  "src/app/journal/page.tsx":
    "export default function Journal(){ return <h1>Journal</h1>; }",
  "src/components/MapStyling.tsx":
    "export function MapStyling(){ return <div>Decorative map</div>; }",
  "src/lib/routes.ts":
    'export const saveRoute = () => createPlatformRecord("route_option", { route_name: "Lake", encoded_polyline: "abc" }); export const loadRoutes = () => listPlatformRecords("route_option");',
  "src/lib/routes.test.ts":
    'describe("save route handoff", () => { it("saves and loads", () => expect(true).toBe(true)); });',
  "src/lib/platform-data.ts": "export const platform = true;",
  "e2e/generated/bike.spec.ts": `test(workflowJourneyTitle("journey-save-calculated-route-to-track-saved-route", "Save calculated route -> Track saved route"), async ({ page }) => {
    await test.step(workflowHandoffTitle("saved-route-to-gps"), async () => { await page.goto("/gps"); });
  });`,
  "e2e/smoke.spec.ts": "test('smoke', async () => {});",
};

describe("workflow-aware repairs", () => {
  it("builds a producer-consumer package for a broken GPS handoff", () => {
    const repair = createWorkflowRepairPackage({
      spec,
      architecture,
      files,
      failedStep: "review_gate",
      repairDomain: "persistence",
      errorOutput:
        'persistence_handoff:handoff Workflow "Track saved route" does not load saved route_option records on /gps. Handoff saved-route-to-gps needs repair.',
      blockingIssues: [
        'persistence_handoff:handoff Workflow "Track saved route" does not load saved route_option records on /gps.',
      ],
    });

    expect(repair.classification.category).toBe("broken_workflow_handoff");
    expect(repair.id).toBe(
      "workflow-repair-journey-journey-save-calculated-route-to-track-saved-route",
    );
    expect(repair.data.producerWorkflowIds).toContain("save-calculated-route");
    expect(repair.data.consumerWorkflowIds).toContain("track-saved-route");
    expect(repair.scope.mutationPaths).toEqual(
      expect.arrayContaining([
        "src/app/explore/page.tsx",
        "src/app/gps/page.tsx",
        "src/lib/routes.ts",
        "e2e/generated/bike.spec.ts",
      ]),
    );
    expect(repair.scope.mutationPaths).not.toContain(
      "src/app/journal/page.tsx",
    );
    expect(repair.scope.mutationPaths).not.toContain(
      "src/components/MapStyling.tsx",
    );
    expect(repair.focusedValidation.expectedConsumerRoute).toBe("/gps");
    expect(repair.focusedValidation.expectedConsumerControl).toBe(
      "Route to track",
    );
    expect(repair.focusedValidation.journeyId).toBe(
      "journey-save-calculated-route-to-track-saved-route",
    );
    expect(repair.rollback).toBeNull();
  });

  it("classifies a Movie Night locator failure as a generated-test defect", () => {
    const repair = createWorkflowRepairPackage({
      spec,
      architecture,
      files,
      failedStep: "e2e",
      errorOutput: [
        "e2e/generated/bike.spec.ts > [voiceforge-journey:journey-save-calculated-route-to-track-saved-route] Save calculated route -> Track saved route",
        "Error: expect(locator).toBeVisible() failed",
        "Locator: getByRole('link', { name: 'Watched History' })",
        "Each test has a fresh browser context and localStorage was empty.",
      ].join("\n"),
      reviews: [
        { agentKey: "ui_affordance_reviewer", blockingIssues: [] },
        { agentKey: "persistence_handoff_reviewer", blockingIssues: [] },
      ],
    });

    expect(repair.classification).toMatchObject({
      category: "generated_test_defect",
      subtype: "test_isolation",
      targetSurface: "generated_test",
      confidence: "high",
    });
    expect(repair.scope.mutationPaths).toEqual([
      "e2e/generated/bike.spec.ts",
    ]);
    expect(repair.scope.protectedPaths).toContain("src/app/gps/page.tsx");
  });

  it("does not mistake unrelated viewer test output for a permission defect", () => {
    const classification = classifyWorkflowRepairFailure({
      failedStep: "e2e",
      hasGeneratedJourney: true,
      errorOutput: [
        "e2e/generated/family-errand-relay.spec.ts > [voiceforge-journey:journey-create-errand] Create errand",
        "Error: locator.fill: strict mode violation: getByRole('textbox', { name: 'Title' }) resolved to 2 elements",
        "Passed e2e/generated/family-errand-relay.spec.ts > viewer has read-only controls",
      ].join("\n"),
      reviews: [
        { agentKey: "ui_affordance_reviewer", blockingIssues: [] },
        { agentKey: "persistence_handoff_reviewer", blockingIssues: [] },
      ],
    });

    expect(classification).toMatchObject({
      category: "generated_test_defect",
      subtype: "locator_or_assertion_defect",
      targetSurface: "generated_test",
      confidence: "high",
    });
  });

  it("targets the failed journey instead of an earlier passing journey in E2E output", () => {
    const reviewOverview: WorkflowContract = {
      ...trackRoute,
      id: "review-overview",
      name: "Review overview",
      start: { route: "/overview", screen: "Overview", preconditions: [] },
      controls: [],
      steps: [
        {
          id: "show-overview",
          description: "Show overview",
          kind: "automatic",
          route: "/overview",
          controlId: "",
          reads: ["route_option"],
          writes: [],
          visibleResult: "Overview is visible.",
        },
      ],
      expectedSaves: [],
      handoffs: [],
      dependencies: { workflowIds: [], platformServices: ["data"] },
      source: {
        workflowName: "Review overview",
        acceptanceCriteria: ["Overview is visible."],
        testScenarios: ["Open overview."],
      },
    };
    const expandedArchitecture: ArchitecturePlan = {
      ...architecture,
      workflowContracts: [saveRoute, trackRoute, reviewOverview],
      pageMap: [
        ...architecture.pageMap,
        {
          route: "/overview",
          name: "Overview",
          purpose: "Review saved routes",
          primaryComponents: ["OverviewPage"],
          workflows: ["Review overview"],
        },
      ],
    };
    const failedTest =
      "e2e/generated/bike.spec.ts > [voiceforge-journey:journey-review-overview] Review overview";
    const repair = createWorkflowRepairPackage({
      spec,
      architecture: expandedArchitecture,
      files,
      failedStep: "e2e",
      errorOutput: [
        "Passed [voiceforge-journey:journey-save-calculated-route-to-track-saved-route] Save calculated route",
        `Failed ${failedTest}`,
        "Error: expect(locator).toBeVisible() failed",
      ].join("\n"),
      failureFingerprint: {
        version: 1,
        step: "e2e",
        failedTests: [failedTest],
        sourceLocations: ["e2e/generated/bike.spec.ts:90:5"],
        errorKinds: ["Error"],
        cases: [{ id: failedTest, signature: "overview missing" }],
        stableKeys: [failedTest],
        summary: `1 structured failure key: ${failedTest}`,
      },
      reviews: [{ agentKey: "ui_affordance_reviewer", blockingIssues: [] }],
    });

    expect(repair.target.journeyId).toBe("journey-review-overview");
    expect(repair.target.workflowId).toBe("review-overview");
  });

  it("does not edit source for external Google Maps failures", () => {
    const classification = classifyWorkflowRepairFailure({
      failedStep: "e2e",
      errorOutput:
        "[voiceforge-journey:journey-save-calculated-route-to-track-saved-route] Google Maps returned HTTP 429 quota exceeded",
      hasGeneratedJourney: true,
    });

    expect(classification.category).toBe("external_service_failure");
    expect(classification.targetSurface).toBe("external_environment");
  });

  it("classifies exact platform key validation failures", () => {
    const classification = classifyWorkflowRepairFailure({
      failedStep: "e2e",
      errorOutput:
        "Record data failed validation because the save used unknown field routeName instead of exact field key route_name.",
    });

    expect(classification.category).toBe("wrong_platform_field_keys");
    expect(classification.targetSurface).toBe("application_source");
  });

  it("classifies deterministic acceptance findings as generated-test defects", () => {
    const classification = classifyWorkflowRepairFailure({
      failedStep: "review_gate",
      errorOutput:
        "acceptance_test:handoff Journey journey-save-calculated-route-to-track-saved-route does not reach /gps and assert the saved route.",
    });

    expect(classification).toMatchObject({
      category: "generated_test_defect",
      subtype: "missing_handoff_trace",
      targetSurface: "generated_test",
      confidence: "high",
    });
  });

  it("classifies the selected finding instead of an unrelated review blocker", () => {
    const repair = createWorkflowRepairPackage({
      spec,
      architecture,
      files,
      failedStep: "review_gate",
      errorOutput:
        'ui_affordance: Workflow "Track saved route" requires a visible control.',
      blockingIssues: [
        'ui_affordance: Workflow "Track saved route" requires a visible control.',
      ],
      reviews: [
        {
          agentKey: "persistence_handoff_reviewer",
          blockingIssues: [
            'persistence_handoff:schema Workflow "Save calculated route" uses an unknown field.',
          ],
        },
      ],
    });

    expect(repair.classification.category).toBe("missing_control");
    expect(repair.baselineBlockingIssues).toHaveLength(2);
  });

  it("enforces the mutation allowlist even after diagnosis", () => {
    const repair = createWorkflowRepairPackage({
      spec,
      architecture,
      files,
      failedStep: "e2e",
      errorOutput:
        "e2e/generated/bike.spec.ts > [voiceforge-journey:journey-save-calculated-route-to-track-saved-route] Error: expect(locator).toBeVisible() failed",
      reviews: [{ agentKey: "ui_affordance_reviewer", blockingIssues: [] }],
    });

    expect(
      validateWorkflowRepairMutationScope({
        repair,
        filesWritten: ["src/app/journal/page.tsx"],
      }),
    ).toMatchObject({ ok: false, outOfScopePaths: ["src/app/journal/page.tsx"] });
  });

  it("rolls back a candidate that adds unrelated workflow findings", () => {
    const repair = createWorkflowRepairPackage({
      spec,
      architecture,
      files,
      failedStep: "review_gate",
      errorOutput:
        'ui_affordance: Workflow "Track saved route" (track-saved-route) requires a visible control.',
      blockingIssues: [
        'ui_affordance: Workflow "Track saved route" (track-saved-route) requires a visible control.',
      ],
    });

    const assessment = assessWorkflowRepairCandidate({
      repair,
      currentBlockingIssues: [
        "persistence_handoff:save Workflow \"Save calculated route\" no longer writes route_option.",
      ],
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.improved).toBe(false);
    expect(assessment.targetResolved).toBe(true);
    expect(assessment.unrelatedFindingsAdded).toHaveLength(1);
  });

  it("keeps a candidate that reduces findings inside the same journey", () => {
    const initialIssues = [
      "acceptance_test:step Journey journey-save-calculated-route-to-track-saved-route is missing navigation.",
      "acceptance_test:save Journey journey-save-calculated-route-to-track-saved-route is missing refresh proof.",
      "acceptance_test:handoff Journey journey-save-calculated-route-to-track-saved-route is missing GPS proof.",
    ];
    const repair = createWorkflowRepairPackage({
      spec,
      architecture,
      files,
      failedStep: "review_gate",
      repairDomain: "acceptance",
      errorOutput: initialIssues.join("\n"),
      blockingIssues: initialIssues,
    });
    const assessment = assessWorkflowRepairCandidate({
      repair,
      currentBlockingIssues: [
        initialIssues[2],
        "acceptance_test:save Journey journey-save-calculated-route-to-track-saved-route needs a unique route fixture.",
      ],
    });

    expect(assessment).toMatchObject({
      accepted: false,
      improved: true,
      targetResolved: false,
    });
    expect(assessment.targetIssuesRemaining).toHaveLength(2);
    expect(assessment.unrelatedFindingsAdded).toEqual([]);
  });

  it("groups findings for one workflow and restores durable packages", () => {
    expect(
      selectWorkflowRepairIssueCluster([
        'persistence_handoff:save Workflow "Save calculated route" has no write.',
        'persistence_handoff:test Workflow "Save calculated route" has no test.',
        'ui_affordance: Workflow "Track saved route" has no control.',
      ]),
    ).toHaveLength(2);

    const repair = createWorkflowRepairPackage({
      spec,
      architecture,
      files,
      failedStep: "review_gate",
      errorOutput:
        'ui_affordance: Workflow "Track saved route" has no control.',
      blockingIssues: [
        'ui_affordance: Workflow "Track saved route" has no control.',
      ],
    });
    expect(restoreWorkflowRepairPackages([repair, { invalid: true }])).toEqual([
      repair,
    ]);
  });
});
