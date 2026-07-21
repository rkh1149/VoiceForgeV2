import { describe, expect, it } from "vitest";
import { normalizeAppSpec } from "../spec";
import {
  classifyDebugFailure,
  createPhaseAwareDebugPlan,
  extractMentionedFilePaths,
  inferResponsiblePhase,
} from "./phase-aware-debug";
import type { FileMap } from "./template";

const spec = normalizeAppSpec({
  appName: "Family Task Hub",
  purpose: "Track shared household tasks.",
  targetUsers: "A family",
  screens: [
    { name: "Dashboard", description: "Review tasks." },
    { name: "Tasks", description: "Manage tasks." },
  ],
  features: ["Add tasks", "Save tasks", "Search tasks"],
  dataToStore: ["tasks"],
  needsLogin: true,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Save a task"],
  deploymentNotes: "",
});

const phases = [
  {
    id: "foundation",
    label: "Data, types, constants, and platform wrappers",
    agentKey: "backend_platform_planner",
    filesWritten: ["src/lib/tasks.ts"],
    filesDeleted: [],
  },
  {
    id: "components",
    label: "Reusable components",
    agentKey: "frontend_builder",
    filesWritten: ["src/components/TaskForm.tsx"],
    filesDeleted: [],
  },
  {
    id: "pages-workflows",
    label: "Pages, navigation, and workflows",
    agentKey: "frontend_builder",
    filesWritten: ["src/app/page.tsx", "src/app/tasks/page.tsx"],
    filesDeleted: [],
  },
  {
    id: "unit-workflow-tests",
    label: "Unit and workflow tests",
    agentKey: "test_agent",
    filesWritten: ["src/components/task-form.test.tsx"],
    filesDeleted: [],
  },
  {
    id: "browser-acceptance-tests",
    label: "Browser acceptance tests",
    agentKey: "test_agent",
    filesWritten: ["e2e/generated/tasks.spec.ts"],
    filesDeleted: [],
  },
  {
    id: "final-integration-review",
    label: "Final integration review",
    agentKey: "final_integration_agent",
    filesWritten: [],
    filesDeleted: [],
  },
];

const files: FileMap = {
  "package.json": "{}",
  "tsconfig.json": "{}",
  "next.config.ts": "export default {};",
  "vitest.config.ts": "export default {};",
  "vitest.setup.ts": "",
  "playwright.config.ts": "export default {};",
  "src/app/page.tsx": 'import { TaskForm } from "@/components/TaskForm"; export default function Page() { return <TaskForm />; }',
  "src/app/tasks/page.tsx": "export default function Tasks() { return <h1>Tasks</h1>; }",
  "src/components/TaskForm.tsx":
    'import { saveTask } from "@/lib/tasks"; export function TaskForm() { return <form onSubmit={() => saveTask({ title: "Paint" })}><button>Save</button></form>; }',
  "src/components/OtherPanel.tsx": "export function OtherPanel() { return <section>Other</section>; }",
  "src/lib/tasks.ts":
    'import { createPlatformRecord } from "@/lib/platform-data"; export function saveTask(input: { title: string }) { return createPlatformRecord("task", input); }',
  "src/lib/unrelated.ts": "export const unrelated = true;",
  "src/lib/platform-data.ts": "export async function createPlatformRecord() {}",
  "src/components/voiceforge-reusable.tsx": "export function PlatformSignInGate() { return null; }",
  "src/components/task-form.test.tsx":
    'import { TaskForm } from "./TaskForm"; import { describe, it } from "vitest"; describe("TaskForm", () => { it("saves", () => TaskForm); });',
  "e2e/generated/tasks.spec.ts": "import { test } from '@playwright/test'; test('tasks', async () => {});",
};

describe("phase-aware debug", () => {
  it("classifies failed steps into explicit debug domains", () => {
    expect(
      classifyDebugFailure({
        failedStep: "dependencies",
        errorOutput: "Dependency import blocked",
      }).domain,
    ).toBe("dependency_security");
    expect(
      classifyDebugFailure({ failedStep: "typecheck", errorOutput: "TS2322" })
        .domain,
    ).toBe("typecheck");
    expect(
      classifyDebugFailure({ failedStep: "lint", errorOutput: "eslint" }).domain,
    ).toBe("lint");
    expect(
      classifyDebugFailure({ failedStep: "test", errorOutput: "Vitest failed" })
        .domain,
    ).toBe("unit_test");
    expect(
      classifyDebugFailure({ failedStep: "build", errorOutput: "prerender" })
        .domain,
    ).toBe("build_prerender");
    expect(
      classifyDebugFailure({ failedStep: "e2e", errorOutput: "axe violation" })
        .domain,
    ).toBe("browser_accessibility");
    expect(
      classifyDebugFailure({
        failedStep: "review_gate",
        errorOutput: "Generated app review failed",
      }).domain,
    ).toBe("integration_review_gate");
  });

  it("extracts mentioned paths and infers the responsible generation phase", () => {
    const errorOutput =
      "Error in ./src/app/tasks/page.tsx:12 and src/components/TaskForm.tsx:7";
    expect(extractMentionedFilePaths(errorOutput)).toEqual([
      "src/app/tasks/page.tsx",
      "src/components/TaskForm.tsx",
    ]);

    const responsible = inferResponsiblePhase({
      classification: classifyDebugFailure({
        failedStep: "build",
        errorOutput,
      }),
      errorOutput,
      generatedPhases: phases,
    });

    expect(responsible.id).toBe("pages-workflows");
    expect(responsible.matchedFiles).toContain("src/app/tasks/page.tsx");
  });

  it("focuses browser/accessibility failures on routes and components first", () => {
    const plan = createPhaseAwareDebugPlan({
      spec,
      files,
      failedStep: "e2e",
      errorOutput: "Serious accessibility violation in src/app/page.tsx",
      generatedPhases: phases,
    });

    expect(plan.classification.domain).toBe("browser_accessibility");
    expect(plan.scope.limited).toBe(true);
    expect(plan.scope.visibleFilePaths).toContain("src/app/page.tsx");
    expect(plan.scope.visibleFilePaths).toContain("src/components/TaskForm.tsx");
    expect(plan.scope.visibleFilePaths).not.toContain("src/lib/unrelated.ts");
  });

  it("focuses data save failures on forms, payload helpers, and platform data", () => {
    const plan = createPhaseAwareDebugPlan({
      spec,
      files,
      failedStep: "test",
      errorOutput: "Save Task failed: Record data failed validation",
      generatedPhases: phases,
    });

    expect(plan.classification.focus).toBe("data_save");
    expect(plan.scope.visibleFilePaths).toContain("src/components/TaskForm.tsx");
    expect(plan.scope.visibleFilePaths).toContain("src/lib/tasks.ts");
    expect(plan.scope.visibleFilePaths).toContain("src/lib/platform-data.ts");
    expect(plan.scope.preferredInspectionPaths).toContain(
      "src/components/TaskForm.tsx",
    );
  });

  it("keeps unit test failures near tests and related source instead of the whole app", () => {
    const plan = createPhaseAwareDebugPlan({
      spec,
      files,
      failedStep: "test",
      errorOutput: "FAIL src/components/task-form.test.tsx",
      generatedPhases: phases,
    });

    expect(plan.scope.visibleFilePaths).toContain(
      "src/components/task-form.test.tsx",
    );
    expect(plan.scope.visibleFilePaths).toContain("src/components/TaskForm.tsx");
    expect(plan.scope.visibleFilePaths).not.toContain("src/lib/unrelated.ts");
  });

  it("routes review-gate workflow coverage failures back to pages and workflows", () => {
    const plan = createPhaseAwareDebugPlan({
      spec,
      files,
      failedStep: "review_gate",
      errorOutput: [
        "code_review: Architecture planned route files that were not generated: src/app/reports/page.tsx.",
        "code_review: Advanced workflow coverage is incomplete; editable entities without complete visible controls/save wiring: Stop (visible create/edit controls).",
        "tests_review: Advanced workflow test coverage is incomplete; missing generated tests for editable entities: Stop.",
      ].join("\n"),
      generatedPhases: phases,
    });

    expect(plan.responsiblePhase.id).toBe("pages-workflows");
    expect(plan.responsiblePhase.agentKey).toBe("frontend_builder");
    expect(plan.context.instructions.join(" ")).toContain(
      "compact but real route/control surfaces",
    );
  });

  it("routes review-gate test-only failures to the unit workflow test phase", () => {
    const plan = createPhaseAwareDebugPlan({
      spec,
      files,
      failedStep: "review_gate",
      errorOutput:
        "tests_review: Advanced workflow test coverage is incomplete; missing generated tests for editable entities: Photo.",
      generatedPhases: phases,
    });

    expect(plan.responsiblePhase.id).toBe("unit-workflow-tests");
    expect(plan.responsiblePhase.agentKey).toBe("test_agent");
  });
});
