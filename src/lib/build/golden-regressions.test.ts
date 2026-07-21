import { describe, expect, it } from "vitest";
import {
  createFallbackArchitecturePlan,
  validateArchitecturePlan,
  type ArchitecturePlan,
} from "../architecture";
import { computeSpecComplexity, normalizeAppSpec, type AppSpec } from "../spec";
import { validateGeneratedAppDependencies } from "./dependencies";
import { GOLDEN_REGRESSION_SPECS } from "./golden-regression-specs";
import { runPlanningSpecialistReviews } from "./planning-specialists";
import { runPostGenerationReviews } from "./post-generation-reviews";
import type { FileMap } from "./template";

function buildArchitecture(spec: AppSpec): ArchitecturePlan {
  return createFallbackArchitecturePlan(spec, computeSpecComplexity(spec));
}

function planningReviews(spec: AppSpec, architecture = buildArchitecture(spec)) {
  return runPlanningSpecialistReviews({
    spec,
    architecture,
    architectureValidation: validateArchitecturePlan(architecture, spec),
  });
}

function postReviews(input: {
  spec: AppSpec;
  architecture?: ArchitecturePlan;
  files: FileMap;
}) {
  return runPostGenerationReviews({
    spec: input.spec,
    architecture: input.architecture ?? buildArchitecture(input.spec),
    allFiles: input.files,
    changedFiles: input.files,
    changedFilePaths: Object.keys(input.files),
    deletedFilePaths: [],
    changeMode: false,
  });
}

function findReview<T extends { agentKey: string }>(
  reviews: T[],
  agentKey: T["agentKey"],
): T {
  const found = reviews.find((review) => review.agentKey === agentKey);
  if (!found) throw new Error(`Missing review ${agentKey}`);
  return found;
}

describe("golden regression specs", () => {
  it("covers the supported golden build categories", () => {
    expect(GOLDEN_REGRESSION_SPECS.map((item) => item.id)).toEqual([
      "simple-local-storage",
      "shared-platform-data",
      "file-export",
      "notification-reminder",
      "integration-search-report",
    ]);
  });

  it("passes architecture and planning gates for all golden specs", () => {
    for (const golden of GOLDEN_REGRESSION_SPECS) {
      const architecture = buildArchitecture(golden.spec);
      const validation = validateArchitecturePlan(architecture, golden.spec);
      const reviews = planningReviews(golden.spec, architecture);

      expect.soft(golden.spec.capabilityTier).toBe(golden.expectedTier);
      expect.soft(validation.blockingIssues, golden.id).toEqual([]);
      expect
        .soft(reviews.flatMap((review) => review.blockingIssues), golden.id)
        .toEqual([]);
      for (const expectedService of golden.expectedServices) {
        expect
          .soft(
            architecture.platformServices.some(
              (service) =>
                service.service === expectedService &&
                service.required &&
                service.availability === "available",
            ),
            `${golden.id} missing ${expectedService}`,
          )
          .toBe(true);
      }
    }
  });

  it("keeps the simple golden app browser-only and the shared golden app on platform data", () => {
    const simple = GOLDEN_REGRESSION_SPECS.find(
      (item) => item.id === "simple-local-storage",
    );
    const shared = GOLDEN_REGRESSION_SPECS.find(
      (item) => item.id === "shared-platform-data",
    );
    if (!simple || !shared) throw new Error("Missing golden specs");

    expect(buildArchitecture(simple.spec).dataModel[0]?.storage).toBe(
      "localStorage",
    );
    expect(buildArchitecture(shared.spec).dataModel[0]?.storage).toBe(
      "platformData",
    );
  });
});

describe("golden regression review gates", () => {
  const shared = GOLDEN_REGRESSION_SPECS.find(
    (item) => item.id === "shared-platform-data",
  );
  if (!shared) throw new Error("Missing shared golden spec");

  it("code review blocks save workflows that use wrong platform field keys", () => {
    const reviews = postReviews({
      spec: shared.spec,
      files: {
        "src/app/page.tsx": `"use client";
import { PlatformSignInGate, usePlatformSessionState } from "@/components/voiceforge-reusable";
import { createPlatformRecord, listPlatformRecords } from "@/lib/platform-data";
export default function Page() {
  usePlatformSessionState();
  void PlatformSignInGate;
  void listPlatformRecords;
  void createPlatformRecord("chore", { title: "Dishes", status: "open" });
  return <main><h1>Chores</h1></main>;
}`,
        "src/lib/chore.test.ts": `import { expect, it } from "vitest"; it("works", () => expect(true).toBe(true));`,
        "e2e/generated/chore.spec.ts": `import { test } from "@playwright/test"; test("works", async () => {});`,
      },
    });
    const codeReview = findReview(reviews, "code_reviewer");

    expect(codeReview.status).toBe("failed");
    expect(codeReview.blockingIssues.join(" ")).toContain(
      "fields not in the Chore platform schema",
    );
  });

  it("code review blocks missing usable sign-in actions and flags flash-prone session wiring", () => {
    const reviews = postReviews({
      spec: shared.spec,
      files: {
        "src/app/page.tsx": `"use client";
import { getPlatformSession, listPlatformRecords } from "@/lib/platform-data";
export default function Page() {
  void getPlatformSession;
  void listPlatformRecords;
  return <main><h1>Chores</h1><p>Please sign in</p></main>;
}`,
        "src/lib/chore.test.ts": `import { expect, it } from "vitest"; it("works", () => expect(true).toBe(true));`,
        "e2e/generated/chore.spec.ts": `import { test } from "@playwright/test"; test("works", async () => {});`,
      },
    });
    const codeReview = findReview(reviews, "code_reviewer");

    expect(codeReview.status).toBe("failed");
    expect(codeReview.blockingIssues).toContain(
      "code_review: Sign-in or role-aware app did not provide a usable locked platform sign-in action.",
    );
    expect(codeReview.warnings.join(" ")).toContain("will not flash");
  });

  it("code review blocks fake invite/remove access controls", () => {
    const simple = GOLDEN_REGRESSION_SPECS[0].spec;
    const reviews = postReviews({
      spec: simple,
      files: {
        "src/app/page.tsx": `export default function Page() {
  return <main><h1>Members</h1><button>Invite member</button><button>Remove access</button></main>;
}`,
        "src/lib/member.test.ts": `import { expect, it } from "vitest"; it("works", () => expect(true).toBe(true));`,
      },
    });
    const codeReview = findReview(reviews, "code_reviewer");

    expect(codeReview.status).toBe("failed");
    expect(codeReview.blockingIssues.join(" ")).toContain(
      "real access is managed from the VoiceForge dashboard",
    );
  });

  it("security review blocks damaged PDF exports", () => {
    const simple = GOLDEN_REGRESSION_SPECS[0].spec;
    const files: FileMap = {
      "src/app/page.tsx": `"use client";
export default function Page() {
  function exportPdf() {
    const text = "Summary";
    URL.createObjectURL(new Blob([text], { type: "application/pdf" }));
  }
  return <main><h1>Exports</h1><button onClick={exportPdf}>PDF</button></main>;
}`,
      "src/lib/export.test.ts": `import { expect, it } from "vitest"; it("works", () => expect(true).toBe(true));`,
    };
    const securityReview = findReview(
      postReviews({ spec: simple, files }),
      "security_reviewer",
    );
    const dependencyCheck = validateGeneratedAppDependencies({
      "package.json": JSON.stringify({ dependencies: {}, devDependencies: {} }),
      ...files,
    });

    expect(securityReview.status).toBe("failed");
    expect(securityReview.blockingIssues.join(" ")).toContain("fake PDF");
    expect(dependencyCheck.ok).toBe(false);
  });

  it("test review warns when generated workflow tests are missing", () => {
    const simple = GOLDEN_REGRESSION_SPECS[0].spec;
    const testReview = findReview(
      postReviews({
        spec: simple,
        files: {
          "src/app/page.tsx": `export default function Page() { return <main><h1>Packing</h1></main>; }`,
        },
      }),
      "test_reviewer",
    );

    expect(testReview.status).toBe("warning");
    expect(testReview.warnings).toContain(
      "tests_review: No generated unit/workflow tests were found under src/.",
    );
  });

  it("ux review warns about unlabeled form controls", () => {
    const simple = GOLDEN_REGRESSION_SPECS[0].spec;
    const uxReview = findReview(
      postReviews({
        spec: simple,
        files: {
          "src/app/page.tsx": `export default function Page() { return <main><h1>Packing</h1><input /></main>; }`,
          "src/lib/packing.test.ts": `import { expect, it } from "vitest"; it("works", () => expect(true).toBe(true));`,
        },
      }),
      "ux_accessibility_reviewer",
    );

    expect(uxReview.status).toBe("warning");
    expect(uxReview.warnings.join(" ")).toContain("Form controls need labels");
  });

  it("planning review warns instead of pretending generated apps can manage real member access", () => {
    const spec = normalizeAppSpec({
      ...shared.spec,
      features: [...shared.spec.features, "Invite member and remove access"],
      workflows: [
        ...shared.spec.workflows,
        {
          name: "Invite member",
          actor: "Owner",
          trigger: "A helper needs access",
          steps: ["Invite member", "Remove access when done"],
          successOutcome: "The helper can access the app.",
          failureStates: ["Invite fails"],
        },
      ],
    });
    const permissionReview = findReview(planningReviews(spec), "permission_reviewer");

    expect(permissionReview.status).toBe("warning");
    expect(permissionReview.warnings).toContain(
      "permissions: Generated apps can enforce owner/editor/viewer roles, but real invite/remove access is managed from the VoiceForge dashboard.",
    );
  });

  it("planning review blocks unsupported required integrations", () => {
    const base = GOLDEN_REGRESSION_SPECS.find(
      (item) => item.id === "integration-search-report",
    )?.spec;
    if (!base) throw new Error("Missing integration golden spec");
    const spec = normalizeAppSpec({
      ...base,
      integrations: [
        {
          name: "Twilio SMS",
          purpose: "Send SMS messages to family members.",
          direction: "export",
          requiredForLaunch: true,
        },
      ],
    });
    const platformReview = findReview(
      planningReviews(spec),
      "backend_platform_planner",
    );

    expect(platformReview.status).toBe("failed");
    expect(platformReview.blockingIssues.join(" ")).toContain(
      "not in the approved catalogue",
    );
  });
});
