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

  it("keeps movie picker UI state out of the approved persistent data model", () => {
    const spec = normalizeAppSpec({
      ...personalInput,
      appName: "Family Movie Night Picker",
      purpose: "Collect movie suggestions and randomly choose movie-night picks.",
      screens: [
        { name: "Suggestions", description: "Add and review movie suggestions." },
        { name: "Pick", description: "Pick a movie and choose another result." },
      ],
      features: ["Add a movie suggestion", "Pick a movie", "Choose another"],
      dataToStore: ["movie suggestions", "watched history"],
      testPlan: ["Add a suggestion, pick it, and choose another movie"],
    });
    spec.dataEntities = [
      {
        name: "Movie Suggestion",
        description: "A movie suggested for family movie night.",
        ownership: "per_user",
        fields: [
          {
            name: "title",
            label: "Movie title",
            type: "text",
            required: true,
            validation: "Required",
          },
          {
            name: "watched",
            label: "Watched",
            type: "boolean",
            required: false,
            validation: "",
          },
        ],
        relationships: [],
      },
      {
        name: "Watched History Entry",
        description: "A snapshot of a watched movie.",
        ownership: "per_user",
        fields: [
          {
            name: "movieTitleSnapshot",
            label: "Movie title",
            type: "text",
            required: true,
            validation: "Required",
          },
          {
            name: "watchedDate",
            label: "Watched date",
            type: "date",
            required: true,
            validation: "Required",
          },
        ],
        relationships: [],
      },
    ];
    spec.workflows = [
      {
        name: "Add a movie suggestion",
        actor: "Family member",
        trigger: "The family member opens Suggestions.",
        steps: ["Enter a movie title", "Save movie suggestion"],
        successOutcome: "The movie suggestion appears in the list.",
        failureStates: ["Title is missing"],
      },
      {
        name: "Pick a movie and choose another",
        actor: "Family member",
        trigger: "The family member opens Pick.",
        steps: ["Pick a movie", "Choose another movie without an immediate repeat"],
        successOutcome: "A different current movie pick is visible.",
        failureStates: ["No unwatched suggestions are available"],
      },
    ];
    spec.acceptanceCriteria = [];
    spec.testScenarios = [];

    const supplied: ArchitecturePlan = structuredClone(
      createFallbackArchitecturePlan(spec, computeSpecComplexity(spec)),
    );
    supplied.dataModel[0].fields.push(
      "id:text",
      "createdAt:datetime",
      "updatedAt:datetime",
    );
    supplied.dataModel.push({
      name: "Picker Session",
      storage: "localStorage",
      fields: ["currentPickerMovieId:text", "lastPickedMovieId:text", "updatedAt:datetime"],
      relationships: [],
    });

    const addSuggestion = supplied.workflowContracts.find((contract) =>
      contract.name.startsWith("Add a movie"),
    );
    const pickMovie = supplied.workflowContracts.find((contract) =>
      contract.name.startsWith("Pick a movie"),
    );
    if (!addSuggestion || !pickMovie) {
      throw new Error("Missing movie workflow fixtures");
    }
    const approvedRequiredFields = [
      ...addSuggestion.requiredData[0].requiredFieldKeys,
    ];
    const approvedSaveFields = [...addSuggestion.expectedSaves[0].fieldKeys];
    addSuggestion.requiredData[0]?.requiredFieldKeys.push(
      "id",
      "createdAt",
      "updatedAt",
    );
    addSuggestion.expectedSaves[0]?.fieldKeys.push(
      "id",
      "createdAt",
      "updatedAt",
    );
    pickMovie.requiredData.push({
      entityName: "Picker Session",
      entityKey: "picker_session",
      operations: ["create", "read", "update"],
      requiredFieldKeys: ["currentPickerMovieId", "lastPickedMovieId", "updatedAt"],
    });
    const pickerStep = pickMovie.steps.at(-1)!;
    pickerStep.kind = "save";
    pickerStep.writes.push("picker_session");
    pickMovie.expectedSaves.push({
      stepId: pickerStep.id,
      operation: "update",
      entityName: "Picker Session",
      entityKey: "picker_session",
      fieldKeys: ["currentPickerMovieId", "lastPickedMovieId", "updatedAt"],
      storage: "localStorage",
      producedReference: "picker_session.id",
    });

    const normalized = ensureWorkflowContracts(spec, supplied);
    const normalizedSuggestion = normalized.workflowContracts.find(
      (contract) => contract.id === addSuggestion.id,
    )!;
    const normalizedPicker = normalized.workflowContracts.find(
      (contract) => contract.id === pickMovie.id,
    )!;

    expect(normalized.dataModel.map((entity) => entity.name)).toEqual([
      "Movie Suggestion",
      "Watched History Entry",
    ]);
    expect(normalized.dataModel[0].fields).toEqual([
      "title:text",
      "watched:boolean",
    ]);
    expect(normalizedSuggestion.requiredData[0].requiredFieldKeys).toEqual(
      approvedRequiredFields,
    );
    expect(normalizedSuggestion.expectedSaves[0].fieldKeys).toEqual(
      approvedSaveFields,
    );
    expect(normalizedPicker.requiredData).not.toContainEqual(
      expect.objectContaining({ entityKey: "picker_session" }),
    );
    expect(normalizedPicker.expectedSaves).not.toContainEqual(
      expect.objectContaining({ entityKey: "picker_session" }),
    );
    expect(normalizedPicker.steps.flatMap((step) => step.writes)).not.toContain(
      "picker_session",
    );
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

  it("removes downstream handoffs from deleted records", () => {
    const spec = bikeSpec();
    const supplied = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const producer = supplied.workflowContracts[0];
    const consumer = supplied.workflowContracts[1];
    const save = producer.expectedSaves[0];
    if (!save || !consumer) throw new Error("Missing handoff fixtures");
    save.operation = "delete";
    producer.requiredData[0].operations = ["read", "delete"];
    producer.steps = producer.steps.map((step) => ({
      ...step,
      writes: step.id === save.stepId ? [save.entityKey] : step.writes,
    }));
    producer.handoffs = [
      {
        id: "deleted-route-for-gps",
        fromStepId: save.stepId,
        produces: save.producedReference,
        storage: save.storage,
        consumerWorkflowId: consumer.id,
        consumerRoute: consumer.start.route,
        consumerControlId: consumer.controls[0]?.id ?? "",
        loadRule: "Load the deleted route in GPS.",
      },
    ];

    const normalized = ensureWorkflowContracts(spec, supplied);
    const normalizedProducer = normalized.workflowContracts.find(
      (contract) => contract.id === producer.id,
    );

    expect(normalizedProducer?.handoffs).toEqual([]);
  });

  it("does not treat absent mutation controls as a viewer persistence promise", () => {
    const spec = bikeSpec();
    spec.workflows = [
      {
        name: "View-only route access",
        actor: "Viewer",
        trigger: "A viewer opens the saved routes screen.",
        steps: [
          "Open the route list.",
          "Browse saved routes and check for editing controls.",
        ],
        successOutcome:
          "The viewer sees saved routes but no Add, Save, Edit, or Delete controls.",
        failureStates: [
          "A restricted action is denied and no route data changes.",
        ],
      },
    ];
    spec.acceptanceCriteria = [];
    spec.testScenarios = [];

    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const contract = architecture.workflowContracts[0];
    const validation = validateWorkflowContracts(spec, architecture);

    expect(contract.actor.roles).toEqual(["viewer"]);
    expect(contract.requiredData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operations: ["read"] }),
      ]),
    );
    expect(contract.expectedSaves).toEqual([]);
    expect(validation.blockingIssues).not.toContainEqual(
      expect.stringContaining("defines no persistent record transition"),
    );
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

  it("normalizes automatic game effects behind one concise user command", () => {
    const spec = normalizeAppSpec({
      ...personalInput,
      appName: "Count to 20 Fun",
      purpose: "Help a child practice counting objects from 1 to 20.",
      screens: [
        { name: "Welcome", description: "Start a counting round." },
        {
          name: "Counting Question",
          description: "Answer five picture counting questions.",
        },
        {
          name: "Results",
          description: "Show the score and let the player play again.",
        },
      ],
      features: ["Play a counting round", "Play again"],
      dataToStore: [],
      testPlan: ["Finish a round and play again with a reset score"],
    });
    spec.dataEntities = [];
    spec.workflows = [
      {
        name: "Play again",
        actor: "Player",
        trigger: "The player presses Play again on Results.",
        steps: [
          "The app clears the prior round.",
          "The app creates five new counting questions.",
          "The player begins at question 1.",
        ],
        successOutcome: "Question 1 is visible with a score of 0 out of 5.",
        failureStates: [],
      },
    ];
    spec.acceptanceCriteria = [];
    spec.testScenarios = [];

    const supplied = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const contract = supplied.workflowContracts[0];
    contract.start = {
      route: "/",
      screen: "Welcome",
      preconditions: [],
    };
    const effectDescriptions = [
      "The app clears the prior round.",
      "The app creates five new counting questions.",
      "The app shows the first new group of object pictures.",
      "The player begins at question 1.",
    ];
    contract.controls = effectDescriptions.map((description, index) => ({
      id: `effect-${index + 1}`,
      kind: "button",
      accessibleName: description,
      route: "/results",
      roles: ["owner"],
      action: description,
    }));
    contract.steps = effectDescriptions.map((description, index) => ({
      id: `play-again-step-${index + 1}`,
      description,
      kind: "action",
      route: "/results",
      controlId: `effect-${index + 1}`,
      reads: [],
      writes: [],
      visibleResult:
        index === effectDescriptions.length - 1
          ? "Question 1 is visible with a score of 0 out of 5."
          : "",
    }));
    contract.dependencies.platformServices = ["integrations"];

    const normalized = ensureWorkflowContracts(spec, supplied);
    const playAgain = normalized.workflowContracts[0];

    expect(playAgain.start).toMatchObject({
      route: "/results",
      screen: "Results",
    });
    expect(playAgain.controls).toEqual([
      expect.objectContaining({
        kind: "button",
        accessibleName: "Play again",
        route: "/results",
      }),
    ]);
    expect(playAgain.steps[0]).toMatchObject({
      description: "Play again",
      kind: "action",
      route: "/results",
      controlId: playAgain.controls[0].id,
    });
    expect(playAgain.steps.slice(1).map((step) => step.kind)).toEqual([
      "automatic",
      "automatic",
      "result",
      "automatic",
    ]);
    expect(
      playAgain.steps.slice(1).every((step) => step.controlId === ""),
    ).toBe(true);
    expect(playAgain.dependencies.platformServices).not.toContain(
      "integrations",
    );
  });

  it("treats sequential saves caused by one button press as automatic effects", () => {
    const spec = bikeSpec();
    const supplied = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const workflow = supplied.workflowContracts.find((contract) =>
      contract.name.startsWith("Plan and save"),
    )!;
    workflow.controls.push({
      id: "confirm-route",
      kind: "button",
      accessibleName: "Confirm route",
      route: "/",
      roles: ["owner", "editor"],
      action: "Confirm the route and save its details",
    });
    workflow.steps.push(
      {
        id: "confirm-route",
        description: "Press Confirm route",
        kind: "action",
        route: "/",
        controlId: "confirm-route",
        reads: ["route_option"],
        writes: [],
        visibleResult: "The route is being saved.",
      },
      {
        id: "persist-route-details",
        description: "Set the saved route details.",
        kind: "save",
        route: "/",
        controlId: "confirm-route",
        reads: ["route_option"],
        writes: ["route_option"],
        visibleResult: "The route details are saved.",
      },
      {
        id: "create-route-history",
        description: "Create one route history entry.",
        kind: "save",
        route: "/",
        controlId: "confirm-route",
        reads: ["route_option"],
        writes: ["route_option"],
        visibleResult: "The route history is saved.",
      },
    );

    const normalized = ensureWorkflowContracts(spec, supplied);
    const normalizedWorkflow = normalized.workflowContracts.find(
      (contract) => contract.id === workflow.id,
    )!;
    const effectSteps = normalizedWorkflow.steps.slice(-3);

    expect(effectSteps.map((step) => step.kind)).toEqual([
      "action",
      "automatic",
      "automatic",
    ]);
    expect(effectSteps.map((step) => step.controlId)).toEqual([
      "confirm-route",
      "",
      "",
    ]);
    expect(effectSteps[1].writes).toEqual(["route_option"]);
    expect(effectSteps[2].writes).toEqual(["route_option"]);
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

  it("upgrades a version 1 plan without regenerating its permanent ids", () => {
    const spec = bikeSpec();
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );
    const legacy = structuredClone(architecture) as Omit<
      ArchitecturePlan,
      "workflowContractVersion"
    > & {
      workflowContractVersion: number;
    };
    legacy.workflowContractVersion = 1;
    legacy.workflowContracts[0].id = "permanent-family-route-workflow";
    legacy.workflowContracts[0].controls[0].id =
      "permanent-calculate-route-control";

    const normalized = ensureWorkflowContracts(spec, legacy);

    expect(normalized.workflowContractVersion).toBe(2);
    expect(normalized.workflowContracts[0].id).toBe(
      "permanent-family-route-workflow",
    );
    expect(normalized.workflowContracts[0].controls[0].id).toBe(
      "permanent-calculate-route-control",
    );
  });
});
