import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import {
  computeSpecComplexity,
  normalizeAppSpec,
  type AppSpec,
} from "../spec";
import {
  synthesizeWorkflowAcceptancePlan,
  validateWorkflowAcceptancePlan,
  WORKFLOW_ACCEPTANCE_MAX_STEPS_PER_JOURNEY,
  WORKFLOW_ACCEPTANCE_MAX_WORKFLOWS_PER_JOURNEY,
  WORKFLOW_ACCEPTANCE_PLAN_VERSION,
} from "./workflow-acceptance-plan";

function bikePlan() {
  const base = normalizeAppSpec({
    appName: "Bike Journey Planner",
    purpose: "Save bicycle routes and track selected routes with GPS.",
    targetUsers: "Family bicycle riders",
    screens: [
      { name: "Explore", description: "Calculate and save routes." },
      { name: "GPS", description: "Track a saved route." },
    ],
    features: ["Save a bicycle route", "Track it with GPS"],
    dataToStore: ["route options", "GPS points"],
    needsLogin: true,
    sharingModel: "shared" as const,
    aiFeatures: [],
    testPlan: ["Save a route and use it on GPS"],
    deploymentNotes: "",
  });
  const spec: AppSpec = {
    ...base,
    capabilityTier: "advanced" as const,
    userRoles: [
      {
        name: "Owner",
        description: "Manages trips.",
        permissions: ["Plan and track routes"],
      },
      {
        name: "Editor",
        description: "Plans trips.",
        permissions: ["Plan and track routes"],
      },
      {
        name: "Viewer",
        description: "Views trips.",
        permissions: ["View routes"],
      },
    ],
    dataEntities: [
      {
        name: "Route Option",
        description: "A selected bicycle route.",
        ownership: "shared" as const,
        fields: [
          {
            name: "name",
            label: "Route name",
            type: "text" as const,
            required: true,
            validation: "Required",
          },
          {
            name: "terrain",
            label: "Terrain",
            type: "select" as const,
            required: true,
            validation: "Choose paved or gravel",
          },
        ],
        relationships: [],
      },
      {
        name: "GPS Track Point",
        description: "A GPS point linked to a route.",
        ownership: "shared" as const,
        fields: [
          {
            name: "routeOptionId",
            label: "Route option",
            type: "relation" as const,
            required: true,
            validation: "Required",
          },
          {
            name: "latitude",
            label: "Latitude",
            type: "number" as const,
            required: true,
            validation: "Required",
          },
        ],
        relationships: [
          {
            type: "belongs_to" as const,
            targetEntity: "Route Option",
            description: "The route being tracked.",
          },
        ],
      },
    ],
    workflows: [
      {
        name: "Save a bicycle route",
        actor: "Editor",
        trigger: "The rider opens Explore.",
        steps: [
          "Enter origin and destination",
          "Calculate bicycle routes",
          "Select a route option",
          "Save selected route",
        ],
        successOutcome: "The selected route is saved.",
        failureStates: ["No route found"],
      },
      {
        name: "Track a saved route with GPS",
        actor: "Editor",
        trigger: "The rider opens GPS after saving a route.",
        steps: [
          "Open GPS",
          "Choose the saved route",
          "Start GPS tracking",
          "Save GPS point",
        ],
        successOutcome: "The GPS point is saved for the route.",
        failureStates: ["Location permission denied"],
      },
      {
        name: "Archive old GPS points",
        actor: "System",
        trigger: "Every night on a schedule.",
        steps: ["Archive expired GPS points"],
        successOutcome: "Old points are archived.",
        failureStates: ["Scheduled job fails"],
      },
    ],
    permissionRules: [
      {
        role: "Owner",
        entity: "All route data",
        actions: ["create", "read", "update", "delete"],
        condition: "",
      },
      {
        role: "Editor",
        entity: "All route data",
        actions: ["create", "read", "update"],
        condition: "",
      },
      {
        role: "Viewer",
        entity: "All route data",
        actions: ["read"],
        condition: "",
      },
    ],
    integrations: [
      {
        name: "Google Maps",
        purpose: "Calculate bicycle routes.",
        direction: "import" as const,
        requiredForLaunch: true,
      },
    ],
    acceptanceCriteria: [
      {
        name: "Route reaches GPS",
        scenario: "Use a saved route in GPS.",
        given: "A route is calculated.",
        when: "The rider saves it and opens GPS.",
        then: "The route is selectable and a GPS point can be saved.",
      },
    ],
    testScenarios: [
      {
        name: "Save route then track",
        type: "browser" as const,
        steps: ["Save route", "Reload", "Open GPS", "Save point"],
        expectedResult: "The route remains available to GPS.",
      },
    ],
  };
  const architecture = createFallbackArchitecturePlan(
    spec,
    computeSpecComplexity(spec),
  );
  return { spec, architecture };
}

describe("workflow acceptance plan", () => {
  it("synthesizes one connected browser journey with saves, refreshes, and handoffs", () => {
    const { spec, architecture } = bikePlan();
    const plan = synthesizeWorkflowAcceptancePlan(spec, architecture);
    const journey = plan.journeys[0];
    const routeWorkflow = architecture.workflowContracts.find(
      (contract) => contract.name === "Save a bicycle route",
    )!;
    const gpsWorkflow = architecture.workflowContracts.find(
      (contract) => contract.name === "Track a saved route with GPS",
    )!;

    expect(plan.version).toBe(WORKFLOW_ACCEPTANCE_PLAN_VERSION);
    expect(plan.summary.userActionWorkflows).toBe(2);
    expect(plan.summary.journeys).toBe(1);
    expect(plan.summary.saves).toBeGreaterThanOrEqual(2);
    expect(plan.summary.refreshChecks).toBe(plan.summary.saves);
    expect(plan.summary.handoffs).toBeGreaterThanOrEqual(1);
    expect(plan.summary.geolocationJourneys).toBe(1);
    expect(journey.workflowIds).toEqual([routeWorkflow.id, gpsWorkflow.id]);
    expect(journey.startRoute).toBe("/");
    expect(journey.steps.map((step) => step.contractStepId)).toContain(
      `${gpsWorkflow.id}-step-4`,
    );
    expect(journey.handoffs).toContainEqual(
      expect.objectContaining({
        producerWorkflowId: routeWorkflow.id,
        consumerWorkflowId: gpsWorkflow.id,
        consumerRoute: "/gps",
      }),
    );
    expect(journey.fixtures).toContainEqual(
      expect.objectContaining({
        entityKey: "gps_track_point",
        fieldKey: "route_option_id",
        value: "@route_option.id",
      }),
    );
    expect(validateWorkflowAcceptancePlan(architecture, plan)).toEqual({
      blockingIssues: [],
      warnings: [],
    });
  });

  it("classifies scheduled and system workflows instead of pretending they are browser actions", () => {
    const { spec, architecture } = bikePlan();
    const plan = synthesizeWorkflowAcceptancePlan(spec, architecture);
    const archiveWorkflow = architecture.workflowContracts.find(
      (contract) => contract.name === "Archive old GPS points",
    )!;

    expect(plan.nonBrowserWorkflows).toContainEqual(
      expect.objectContaining({
        workflowId: archiveWorkflow.id,
        trigger: "scheduled",
      }),
    );
    expect(plan.summary.nonBrowserWorkflows).toBe(1);
  });

  it("splits a large connected workflow graph into bounded serial journeys", () => {
    const { spec, architecture } = bikePlan();
    const template = architecture.workflowContracts.find(
      (contract) => contract.trigger === "user_action",
    )!;
    const scheduled = architecture.workflowContracts.filter(
      (contract) => contract.trigger !== "user_action",
    );
    const connected = Array.from({ length: 6 }, (_, index) => ({
      ...template,
      id: `connected-workflow-${index + 1}`,
      name: `Connected workflow ${index + 1}`,
      dependencies: {
        ...template.dependencies,
        workflowIds:
          index === 0 ? [] : [`connected-workflow-${index}`],
      },
      handoffs: [],
    }));
    architecture.workflowContracts = [...connected, ...scheduled];

    const plan = synthesizeWorkflowAcceptancePlan(spec, architecture);

    expect(plan.journeys.length).toBeGreaterThan(1);
    expect(
      plan.journeys.every(
        (journey) =>
          journey.workflowIds.length <=
          WORKFLOW_ACCEPTANCE_MAX_WORKFLOWS_PER_JOURNEY,
      ),
    ).toBe(true);
    expect(
      plan.journeys.every(
        (journey) =>
          journey.steps.length <= WORKFLOW_ACCEPTANCE_MAX_STEPS_PER_JOURNEY,
      ),
    ).toBe(true);
    expect(plan.journeys[1].dependsOnJourneyIds).toEqual([
      plan.journeys[0].id,
    ]);
    expect(validateWorkflowAcceptancePlan(architecture, plan).blockingIssues).toEqual(
      [],
    );
  });

  it("reports a workflow removed from its synthesized journey", () => {
    const { spec, architecture } = bikePlan();
    const plan = synthesizeWorkflowAcceptancePlan(spec, architecture);
    const routeWorkflow = architecture.workflowContracts.find(
      (contract) => contract.name === "Save a bicycle route",
    )!;
    const gpsWorkflow = architecture.workflowContracts.find(
      (contract) => contract.name === "Track a saved route with GPS",
    )!;
    plan.journeys[0].workflowIds = [routeWorkflow.id];

    expect(
      validateWorkflowAcceptancePlan(architecture, plan).blockingIssues,
    ).toContain(
      `acceptance_plan: Workflow ${gpsWorkflow.id} must appear in exactly one browser journey; found 0.`,
    );
  });
});
