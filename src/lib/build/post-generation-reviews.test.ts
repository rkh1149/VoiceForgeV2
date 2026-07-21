import { describe, expect, it } from "vitest";
import {
  createFallbackArchitecturePlan,
  validateArchitecturePlan,
  type ArchitecturePlan,
} from "../architecture";
import { computeSpecComplexity, normalizeAppSpec, type AppSpec } from "../spec";
import {
  getPostGenerationBlockingIssues,
  runPostGenerationReviews,
} from "./post-generation-reviews";
import type { FileMap } from "./template";

const sharedSpecInput = {
  appName: "Family Follow Up Hub",
  purpose: "Help a family track shared follow ups.",
  targetUsers: "A family of five",
  screens: [
    {
      name: "Dashboard",
      description: "Review and add follow ups.",
    },
  ],
  features: ["Add follow ups", "Track owners", "Search records"],
  dataToStore: ["follow ups with title, owner, due date, and status"],
  needsLogin: true,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Create a follow up and see it in the list"],
  deploymentNotes: "",
};

const personalSpecInput = {
  appName: "Packing Helper",
  purpose: "Track a personal packing list.",
  targetUsers: "One person",
  screens: [
    {
      name: "Dashboard",
      description: "Manage packing items.",
    },
  ],
  features: ["Add items", "Mark packed"],
  dataToStore: ["items"],
  needsLogin: false,
  sharingModel: "private" as const,
  aiFeatures: [],
  testPlan: ["Add an item"],
  deploymentNotes: "",
};

function buildArchitecture(spec: AppSpec): ArchitecturePlan {
  const architecture = createFallbackArchitecturePlan(
    spec,
    computeSpecComplexity(spec),
  );
  const validation = validateArchitecturePlan(architecture, spec);
  return {
    ...architecture,
    capabilityValidation: {
      ...architecture.capabilityValidation,
      canBuildNow: validation.canBuildNow,
      blockingIssues: validation.blockingIssues,
      warnings: validation.warnings,
    },
  };
}

function review(input: {
  spec?: AppSpec;
  architecture?: ArchitecturePlan;
  allFiles: FileMap;
  changedFiles?: FileMap;
  changeMode?: boolean;
}) {
  const spec = input.spec ?? normalizeAppSpec(sharedSpecInput);
  const architecture = input.architecture ?? buildArchitecture(spec);
  const changedFiles = input.changedFiles ?? input.allFiles;
  return runPostGenerationReviews({
    spec,
    architecture,
    allFiles: input.allFiles,
    changedFiles,
    changedFilePaths: Object.keys(changedFiles),
    deletedFilePaths: [],
    changeMode: input.changeMode ?? false,
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

describe("post-generation reviews", () => {
  it("records passing gates for a shared app with platform clients and generated tests", () => {
    const spec = normalizeAppSpec(sharedSpecInput);
    const files: FileMap = {
      "src/app/page.tsx": `"use client";
import { PlatformSignInGate, usePlatformSessionState } from "@/components/voiceforge-reusable";
import { createPlatformRecord, listPlatformRecords, searchPlatformRecords } from "@/lib/platform-data";

export default function Page() {
  usePlatformSessionState();
  void PlatformSignInGate;
  void createPlatformRecord;
  void listPlatformRecords;
  void searchPlatformRecords;
  return <main><h1>Family Follow Up Hub</h1><label htmlFor="title">Title</label><input id="title" /></main>;
}`,
      "src/lib/follow-ups.test.ts": `import { describe, expect, it } from "vitest";
describe("follow ups", () => { it("works", () => expect(1).toBe(1)); });`,
      "e2e/generated/follow-ups.spec.ts": `import { test, expect } from "@playwright/test";
test("loads", async ({ page }) => { await page.goto("/"); await expect(page.getByRole("heading")).toBeVisible(); });`,
    };

    const reviews = review({ spec, architecture: buildArchitecture(spec), allFiles: files });

    expect(reviews.map((item) => item.agentKey)).toEqual([
      "code_reviewer",
      "test_reviewer",
      "security_reviewer",
      "ux_accessibility_reviewer",
    ]);
    expect(reviews.every((item) => item.status === "passed")).toBe(true);
    expect(getPostGenerationBlockingIssues(reviews)).toEqual([]);
  });

  it("blocks direct credentials, external URLs, API routes, and unsafe HTML", () => {
    const spec = normalizeAppSpec(personalSpecInput);
    const files: FileMap = {
      "src/app/page.tsx": `"use client";
export default function Page() {
  const key = process.env.OPENAI_API_KEY;
  void fetch("https://example.com/api");
  navigator.geolocation.watchPosition(() => {});
  return <main dangerouslySetInnerHTML={{ __html: String(key) }} />;
}`,
      "src/app/api/custom/route.ts": `export async function POST() { return Response.json({ ok: true }); }`,
    };

    const reviews = review({
      spec,
      architecture: buildArchitecture(spec),
      allFiles: files,
    });
    const securityReview = findReview(reviews, "security_reviewer");

    expect(securityReview.status).toBe("failed");
    expect(securityReview.blockingIssues.join(" ")).toContain(
      "references platform credentials",
    );
    expect(securityReview.blockingIssues.join(" ")).toContain(
      "external URLs",
    );
    expect(securityReview.blockingIssues.join(" ")).toContain(
      "locked API route",
    );
    expect(securityReview.blockingIssues.join(" ")).toContain(
      "unsafe dynamic HTML",
    );
    expect(securityReview.blockingIssues.join(" ")).toContain(
      "navigator.geolocation",
    );
  });

  it("blocks shared apps that omit platform-data and session wiring", () => {
    const spec = normalizeAppSpec(sharedSpecInput);
    const files: FileMap = {
      "src/app/page.tsx": `export default function Page() { return <main><h1>Family Follow Up Hub</h1></main>; }`,
      "src/lib/follow-ups.test.ts": `import { expect, it } from "vitest";
it("works", () => expect(true).toBe(true));`,
    };

    const codeReview = findReview(
      review({ spec, architecture: buildArchitecture(spec), allFiles: files }),
      "code_reviewer",
    );

    expect(codeReview.status).toBe("failed");
    expect(codeReview.blockingIssues).toContain(
      "code_review: Shared/platform-data app did not use the locked platform-data client.",
    );
    expect(codeReview.blockingIssues).toContain(
      "code_review: Sign-in or role-aware app did not provide a usable locked platform sign-in action.",
    );
  });

  it("warns about missing generated tests and basic accessibility gaps", () => {
    const spec = normalizeAppSpec(personalSpecInput);
    const files: FileMap = {
      "src/app/page.tsx": `"use client";
export default function Page() { return <main><input id="item" /><img src="/missing.png" /></main>; }`,
    };
    const reviews = review({
      spec,
      architecture: buildArchitecture(spec),
      allFiles: files,
    });
    const testReview = findReview(reviews, "test_reviewer");
    const uxReview = findReview(reviews, "ux_accessibility_reviewer");

    expect(testReview.status).toBe("warning");
    expect(testReview.warnings).toContain(
      "tests_review: No generated unit/workflow tests were found under src/.",
    );
    expect(uxReview.status).toBe("warning");
    expect(uxReview.warnings.join(" ")).toContain("without an h1");
    expect(uxReview.warnings.join(" ")).toContain("Images without alt text");
    expect(uxReview.warnings.join(" ")).toContain("Form controls need labels");
  });
});
