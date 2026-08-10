import { describe, expect, it } from "vitest";
import {
  createFallbackArchitecturePlan,
  type ArchitecturePlan,
} from "./architecture";
import { computeSpecComplexity, normalizeAppSpec, type AppSpec } from "./spec";
import {
  ensureWorkflowContracts,
  validateWorkflowContracts,
  WORKFLOW_CONTRACT_VERSION,
  workflowContractStats,
  type WorkflowContract,
} from "./workflow-contract";

const personalInput = {
  appName: "Reading Timer",
  purpose: "Track personal reading sessions.",
  targetUsers: "One reader",
  screens: [
    {
      name: "Reading",
      description: "Start and save a reading session.",
    },
  ],
  features: ["Start a reading session", "Save session notes"],
  dataToStore: ["reading session with title and notes"],
  needsLogin: false,
  sharingModel: "private" as const,
  aiFeatures: [],
  testPlan: ["Start and save a reading session"],
  deploymentNotes: "",
};

function bikeSpec(): AppSpec {
  const base = normalizeAppSpec({
    ...personalInput,
    appName: "Bike Journey Planner",
    purpose: "Plan bicycle routes and track a selected route with GPS.",
    targetUsers: "Family bicycle riders",
    screens: [
      {
        name: "Explore",
        description: "Plan, compare, select, and save bicycle routes.",
      },
      {
        name: "GPS",
        description: "Choose a saved route and record GPS track points.",
      },
    ],
    features: ["Plan and save a bicycle route", "Track a saved route with GPS"],
    dataToStore: ["route options", "GPS track points"],
    needsLogin: true,
    sharingModel: "shared" as const,
    testPlan: [
      "Save a selected route and see it in Route to track on the GPS screen",
    ],
  });

  return {
    ...base,
    capabilityTier: "advanced",
    userRoles: [
      {
        name: "Owner",
        description: "Manages the trip.",
        permissions: ["Plan routes", "Track rides"],
      },
      {
        name: "Editor",
        description: "Helps plan and track rides.",
        permissions: ["Plan routes", "Track rides"],
      },
      {
        name: "Viewer",
        description: "Views routes and tracks.",
        permissions: ["View routes"],
      },
    ],
    dataEntities: [
      {
        name: "Route Option",
        description: "A calculated bicycle route selected for a trip.",
        ownership: "shared",
        fields: [
          {
            name: "name",
            label: "Route name",
            type: "text",
            required: true,
            validation: "Required",
          },
          {
            name: "encodedPolyline",
            label: "Route path",
            type: "long_text",
            required: true,
            validation: "Required",
          },
        ],
        relationships: [],
      },
      {
        name: "GPS Track Point",
        description: "A recorded GPS point for the selected route.",
        ownership: "shared",
        fields: [
          {
            name: "routeOptionId",
            label: "Route option",
            type: "relation",
            required: true,
            validation: "Required",
          },
          {
            name: "latitude",
            label: "Latitude",
            type: "number",
            required: true,
            validation: "Required",
          },
        ],
        relationships: [
          {
            type: "belongs_to",
            targetEntity: "Route Option",
            description: "The route being tracked.",
          },
        ],
      },
    ],
    workflows: [
      {
        name: "Plan and save bicycle route",
        actor: "Editor",
        trigger: "The rider opens Explore.",
        steps: [
          "Open Explore",
          "Enter an origin and destination",
          "Calculate bicycle routes",
          "Select a route option",
          "Save selected route",
        ],
        successOutcome: "The selected route is saved to the trip.",
        failureStates: ["No routes found", "Route save fails"],
      },
      {
        name: "Track a saved route with GPS",
        actor: "Editor",
        trigger: "The rider opens GPS after saving a route.",
        steps: [
          "Open GPS",
          "Choose a saved route in Route to track",
          "Start GPS tracking",
          "Save a GPS track point",
        ],
        successOutcome: "The GPS point is saved against the selected route.",
        failureStates: ["Location permission denied", "No saved route"],
      },
    ],
    permissionRules: [
      {
        role: "Owner",
        entity: "All saved information",
        actions: ["create", "read", "update", "delete"],
        condition: "",
      },
      {
        role: "Editor",
        entity: "All saved information",
        actions: ["create", "read", "update"],
        condition: "",
      },
      {
        role: "Viewer",
        entity: "All saved information",
        actions: ["read"],
        condition: "",
      },
    ],
    integrations: [
      {
        name: "Google Maps",
        purpose: "Calculate bicycle routes.",
        direction: "import",
        requiredForLaunch: true,
      },
    ],
    acceptanceCriteria: [
      {
        name: "Route reaches GPS",
        scenario: "Use a saved route for GPS tracking.",
        given: "A trip is open on Explore.",
        when: "The rider saves a route and opens GPS.",
        then: "The route appears in Route to track and a GPS point can be saved.",
      },
    ],
    testScenarios: [
      {
        name: "Save route then track",
        type: "browser",
        steps: [
          "Calculate a route",
          "Save the route",
          "Open GPS",
          "Select the saved route",
          "Save a GPS point",
        ],
        expectedResult: "The saved route and GPS point remain linked.",
      },
    ],
  };
}

describe("workflow contract layer", () => {
  it("creates one strict contract for every promised personal workflow", () => {
    const spec = normalizeAppSpec(personalInput);
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const validation = validateWorkflowContracts(spec, architecture);

    expect(architecture.workflowContractVersion).toBe(
      WORKFLOW_CONTRACT_VERSION,
    );
    expect(architecture.workflowContracts).toHaveLength(spec.workflows.length);
    expect(
      architecture.workflowContracts.every(
        (contract) =>
          contract.start.route === "/" &&
          contract.actor.roles.includes("owner") &&
          contract.controls.length > 0,
      ),
    ).toBe(true);
    expect(validation.blockingIssues).toEqual([]);
  });

  it("records the route-to-GPS persistence handoff for Bike Journey Planner", () => {
    const spec = bikeSpec();
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const routeWorkflow = architecture.workflowContracts.find((contract) =>
      contract.name.startsWith("Plan and save"),
    );
    const gpsWorkflow = architecture.workflowContracts.find((contract) =>
      contract.name.startsWith("Track a saved"),
    );

    expect(routeWorkflow?.start.route).toBe("/");
    expect(gpsWorkflow?.start.route).toBe("/gps");
    expect(routeWorkflow?.expectedSaves).toContainEqual(
      expect.objectContaining({
        entityKey: "route_option",
        storage: "platformData",
        producedReference: "route_option.id",
      }),
    );
    expect(routeWorkflow?.handoffs).toContainEqual(
      expect.objectContaining({
        produces: "route_option.id",
        consumerWorkflowId: gpsWorkflow?.id,
        consumerRoute: "/gps",
      }),
    );
    expect(gpsWorkflow?.dependencies.workflowIds).toContain(routeWorkflow?.id);
    expect(validateWorkflowContracts(spec, architecture).blockingIssues).toEqual(
      [],
    );
  });

  it("maps every acceptance criterion and test scenario to a workflow", () => {
    const spec = bikeSpec();
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const source = architecture.workflowContracts.flatMap((contract) => [
      ...contract.source.acceptanceCriteria,
      ...contract.source.testScenarios,
    ]);

    expect(source).toContain("Route reaches GPS");
    expect(source).toContain("Save route then track");
  });

  it("normalizes architect field aliases and saved-record references", () => {
    const spec = bikeSpec();
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const supplied: ArchitecturePlan = structuredClone(architecture);
    const routeWorkflow = supplied.workflowContracts.find((contract) =>
      contract.name.startsWith("Plan and save"),
    );
    const gpsWorkflow = supplied.workflowContracts.find((contract) =>
      contract.name.startsWith("Track a saved"),
    );
    if (!routeWorkflow || !gpsWorkflow) {
      throw new Error("Missing bike workflow fixtures");
    }
    const save = routeWorkflow.expectedSaves[0];
    const saveStep = routeWorkflow.steps.find((step) => step.id === save.stepId);
    if (!saveStep) throw new Error("Missing route save step fixture");
    saveStep.writes = ["route_option_name", "route_option_polyline"];
    save.producedReference = "saved-route-option";
    routeWorkflow.handoffs = [
      {
        ...routeWorkflow.handoffs[0],
        id: "saved-route-for-gps",
        produces: "saved-route-option",
      },
      {
        ...routeWorkflow.handoffs[0],
        id: "duplicate-saved-route-for-gps",
        produces: "saved-route-option",
      },
    ];
    gpsWorkflow.steps[0].reads = ["saved_route_option_name"];

    const normalized = ensureWorkflowContracts(spec, supplied);
    const normalizedRoute = normalized.workflowContracts.find(
      (contract) => contract.id === routeWorkflow.id,
    );

    expect(normalizedRoute?.expectedSaves[0].producedReference).toBe(
      "route_option.id",
    );
    expect(
      normalizedRoute?.steps.find((step) => step.id === save.stepId)?.writes,
    ).toEqual(["route_option"]);
    expect(normalizedRoute?.handoffs).toHaveLength(1);
    expect(validateWorkflowContracts(spec, normalized).blockingIssues).toEqual(
      [],
    );
  });

  it("does not add generic handoffs after an architect maps a saved reference", () => {
    const spec = bikeSpec();
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const supplied: ArchitecturePlan = structuredClone(architecture);
    const routeWorkflow = supplied.workflowContracts.find((contract) =>
      contract.name.startsWith("Plan and save"),
    )!;
    const gpsWorkflow = supplied.workflowContracts.find((contract) =>
      contract.name.startsWith("Track a saved"),
    )!;
    const overviewWorkflow: WorkflowContract = {
      ...structuredClone(gpsWorkflow),
      id: "review-overview",
      name: "Review overview",
      start: { route: "/", screen: "Overview", preconditions: [] },
      controls: [
        {
          id: "overview-link",
          kind: "link",
          accessibleName: "Overview",
          route: "/",
          roles: ["owner", "editor", "viewer"],
          action: "Open aggregate route counts",
        },
      ],
      steps: [
        {
          id: "show-route-count",
          description: "Calculate the number of saved routes",
          kind: "automatic",
          route: "/",
          controlId: "",
          reads: ["route_option"],
          writes: [],
          visibleResult: "Saved route count is visible.",
        },
      ],
      expectedSaves: [],
      handoffs: [],
      dependencies: { workflowIds: [], platformServices: ["data"] },
    };
    supplied.workflowContracts.push(overviewWorkflow);
    routeWorkflow.handoffs[0] = {
      ...routeWorkflow.handoffs[0],
      id: "saved-route-for-gps-tracking",
    };
    routeWorkflow.handoffs.push({
      ...routeWorkflow.handoffs[0],
      id: `${routeWorkflow.id}-to-${overviewWorkflow.id}-route_option`,
      consumerWorkflowId: overviewWorkflow.id,
      consumerRoute: "/",
      consumerControlId: "overview-link",
      loadRule: "Load the saved Route Option record and make it available on Overview.",
    });

    const normalized = ensureWorkflowContracts(spec, supplied);
    const normalizedRoute = normalized.workflowContracts.find(
      (contract) => contract.id === routeWorkflow.id,
    )!;
    const normalizedOverview = normalized.workflowContracts.find(
      (contract) => contract.id === overviewWorkflow.id,
    )!;

    expect(normalizedRoute.handoffs).toHaveLength(1);
    expect(normalizedRoute.handoffs).not.toContainEqual(
      expect.objectContaining({ consumerWorkflowId: overviewWorkflow.id }),
    );
    expect(normalizedOverview.dependencies.workflowIds).not.toContain(
      routeWorkflow.id,
    );
  });

  it("keeps read-only workflows read-only and removes impossible producer handoffs", () => {
    const spec = bikeSpec();
    spec.dataEntities = [spec.dataEntities[0]];
    spec.workflows = [
      {
        name: "View route options",
        actor: "Any signed-in member",
        trigger: "The member opens saved routes.",
        steps: [
          "Load and display saved route options.",
          "Owners and editors can choose to mark a route complete.",
        ],
        successOutcome: "All saved routes remain visible after refresh.",
        failureStates: ["No routes have been saved"],
      },
      {
        name: "Mark route complete",
        actor: "Owner or Editor",
        trigger: "The member selects a saved route.",
        steps: ["Mark the selected route complete", "Update the saved route"],
        successOutcome: "The route remains complete after refresh.",
        failureStates: ["The update fails"],
      },
    ];
    spec.acceptanceCriteria = [];
    spec.testScenarios = [];

    const supplied = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const viewWorkflow = supplied.workflowContracts.find(
      (contract) => contract.name === "View route options",
    );
    const markWorkflow = supplied.workflowContracts.find(
      (contract) => contract.name === "Mark route complete",
    );
    if (!viewWorkflow || !markWorkflow) {
      throw new Error("Missing read/update workflow fixtures");
    }
    viewWorkflow.expectedSaves = [];
    viewWorkflow.controls = [];
    viewWorkflow.requiredData = viewWorkflow.requiredData.map((data) => ({
      ...data,
      operations: ["read"],
    }));
    viewWorkflow.steps = viewWorkflow.steps.map((step, index) => ({
      ...step,
      kind: index === 0 ? "automatic" : "result",
      writes: [],
    }));
    viewWorkflow.handoffs = [
      {
        id: "loaded-route-to-mark-complete",
        fromStepId: viewWorkflow.steps[0].id,
        produces: "route_option.id",
        storage: "platformData",
        consumerWorkflowId: markWorkflow.id,
        consumerRoute: markWorkflow.start.route,
        consumerControlId: markWorkflow.controls[0]?.id ?? "",
        loadRule: "Use the already loaded route row for the mark action.",
      },
    ];
    markWorkflow.dependencies.workflowIds.push(viewWorkflow.id);

    const normalized = ensureWorkflowContracts(spec, supplied);
    const normalizedView = normalized.workflowContracts.find(
      (contract) => contract.name === "View route options",
    );
    const normalizedMark = normalized.workflowContracts.find(
      (contract) => contract.name === "Mark route complete",
    );
    const validation = validateWorkflowContracts(spec, normalized);

    expect(normalizedView?.expectedSaves).toEqual([]);
    expect(normalizedView?.controls).toEqual([
      expect.objectContaining({
        kind: "link",
        accessibleName: "View route options",
        route: normalizedView?.start.route,
      }),
    ]);
    expect(
      normalizedView?.steps.every((step) => step.controlId === ""),
    ).toBe(true);
    expect(normalizedView?.handoffs).toEqual([]);
    expect(normalizedMark?.dependencies.workflowIds).toContain(
      normalizedView?.id,
    );
    expect(validation.blockingIssues).toEqual([]);
  });

  it("blocks unknown routes, fields, and downstream workflows", () => {
    const spec = bikeSpec();
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const broken: ArchitecturePlan = structuredClone(architecture);
    broken.workflowContracts[0].start.route = "/hidden-route";
    broken.workflowContracts[0].requiredData[0].requiredFieldKeys.push(
      "invented_field",
    );
    broken.workflowContracts[0].handoffs[0].consumerWorkflowId =
      "missing-workflow";
    broken.workflowContracts[0].controls[0].accessibleName = "Submit";
    for (const contract of broken.workflowContracts) {
      contract.source.testScenarios = [];
    }

    const validation = validateWorkflowContracts(spec, broken);
    expect(validation.blockingIssues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unknown route /hidden-route"),
        expect.stringContaining("invented_field"),
        expect.stringContaining("missing-workflow"),
        expect.stringContaining("vague control label"),
        expect.stringContaining("Test scenarios are not mapped"),
      ]),
    );
  });

  it("blocks a promised save that has no persistent record transition", () => {
    const spec = bikeSpec();
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const broken: ArchitecturePlan = structuredClone(architecture);
    const routeWorkflow = broken.workflowContracts.find((contract) =>
      contract.name.startsWith("Plan and save"),
    );
    if (!routeWorkflow) throw new Error("Missing route workflow fixture");
    routeWorkflow.expectedSaves = [];
    routeWorkflow.handoffs = [];

    expect(validateWorkflowContracts(spec, broken).blockingIssues).toContainEqual(
      expect.stringContaining("defines no persistent record transition"),
    );
  });

  it("reconstructs contracts when resuming an older architecture record", () => {
    const spec = bikeSpec();
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const legacy = {
      ...architecture,
      workflowContractVersion: undefined,
      workflowContracts: undefined,
    };
    const normalized = ensureWorkflowContracts(spec, legacy);

    expect(normalized.workflowContractVersion).toBe(WORKFLOW_CONTRACT_VERSION);
    expect(normalized.workflowContracts).toHaveLength(spec.workflows.length);
    expect(workflowContractStats(normalized.workflowContracts).handoffs).toBeGreaterThan(
      0,
    );
  });
});
