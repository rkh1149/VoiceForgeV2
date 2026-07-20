import { describe, expect, it } from "vitest";
import {
  createFallbackArchitecturePlan,
  validateArchitecturePlan,
  type ArchitecturePlan,
} from "../architecture";
import { computeSpecComplexity, normalizeAppSpec, type AppSpec } from "../spec";
import { runPlanningSpecialistReviews } from "./planning-specialists";

const sharedSpecInput = {
  appName: "Family Project Hub",
  purpose: "Help a family manage shared projects and tasks.",
  targetUsers: "A family of five",
  screens: [
    {
      name: "Dashboard",
      description: "Review project status and upcoming tasks.",
    },
  ],
  features: ["Add projects", "Assign tasks", "Search tasks"],
  dataToStore: ["projects and tasks with owners, due dates, and status"],
  needsLogin: true,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Create and complete a task"],
  deploymentNotes: "",
};

function buildPlan(spec: AppSpec): ArchitecturePlan {
  return createFallbackArchitecturePlan(spec, computeSpecComplexity(spec));
}

function review(spec: AppSpec, architecture = buildPlan(spec)) {
  return runPlanningSpecialistReviews({
    spec,
    architecture,
    architectureValidation: validateArchitecturePlan(architecture, spec),
  });
}

function findReview(
  reviews: ReturnType<typeof review>,
  agentKey: ReturnType<typeof review>[number]["agentKey"],
) {
  const found = reviews.find((item) => item.agentKey === agentKey);
  if (!found) throw new Error(`Missing review ${agentKey}`);
  return found;
}

describe("planning specialist reviews", () => {
  it("records passing reviews for a normal shared platform-data app", () => {
    const spec = normalizeAppSpec(sharedSpecInput);
    const reviews = review(spec);

    expect(reviews.map((item) => item.agentKey)).toEqual([
      "data_modeler",
      "backend_platform_planner",
      "permission_reviewer",
    ]);
    expect(reviews.every((item) => item.status === "passed")).toBe(true);
  });

  it("blocks when the architecture omits approved data entities", () => {
    const spec = normalizeAppSpec(sharedSpecInput);
    const architecture = { ...buildPlan(spec), dataModel: [] };
    const dataReview = findReview(review(spec, architecture), "data_modeler");

    expect(dataReview.status).toBe("failed");
    expect(dataReview.blockingIssues).toContain(
      "data_model: The architecture omitted the approved data model.",
    );
  });

  it("blocks when the platform plan omits a required service", () => {
    const spec = normalizeAppSpec(sharedSpecInput);
    const architecture = {
      ...buildPlan(spec),
      platformServices: buildPlan(spec).platformServices.filter(
        (service) => service.service !== "data",
      ),
    };
    const platformReview = findReview(
      review(spec, architecture),
      "backend_platform_planner",
    );

    expect(platformReview.status).toBe("failed");
    expect(platformReview.blockingIssues).toContain(
      "platform_plan: The architecture omitted required platform services: data.",
    );
  });

  it("blocks mutating public permissions before code generation", () => {
    const base = normalizeAppSpec(sharedSpecInput);
    const spec: AppSpec = {
      ...base,
      needsLogin: false,
      sharingModel: "public",
      permissionRules: [
        {
          role: "Visitor",
          entity: "Task",
          actions: ["create"],
          condition: "",
        },
      ],
    };
    const permissionReview = findReview(review(spec), "permission_reviewer");

    expect(permissionReview.status).toBe("failed");
    expect(permissionReview.blockingIssues).toContain(
      "permissions: Public apps are read-only in VoiceForge V2; use shared access for collaborative editing.",
    );
  });

  it("warns when generated app requirements imply real member access management", () => {
    const base = normalizeAppSpec(sharedSpecInput);
    const spec: AppSpec = {
      ...base,
      features: [...base.features, "Invite helpers and remove member access"],
      workflows: [
        ...base.workflows,
        {
          name: "Invite helper",
          actor: "Owner",
          trigger: "Owner adds a helper",
          steps: ["Enter helper details", "Invite the helper"],
          successOutcome: "The helper can see the project.",
          failureStates: ["Invite cannot be sent"],
        },
      ],
      permissionRules: [
        ...base.permissionRules,
        {
          role: "Owner",
          entity: "Members",
          actions: ["invite", "admin"],
          condition: "Owner only.",
        },
      ],
    };
    const permissionReview = findReview(review(spec), "permission_reviewer");

    expect(permissionReview.status).toBe("warning");
    expect(permissionReview.warnings).toContain(
      "permissions: Generated apps can enforce owner/editor/viewer roles, but real invite/remove access is managed from the VoiceForge dashboard.",
    );
  });
});
