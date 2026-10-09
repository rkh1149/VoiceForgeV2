import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import { GOLDEN_REGRESSION_SPECS } from "../build/golden-regression-specs";
import { computeSpecComplexity } from "../spec";
import {
  canUseSimpleLocalStorageStarter,
  generateSimpleLocalStorageStarterApp,
} from "./simple-local-storage-starter";

describe("deterministic simple localStorage starter", () => {
  it("generates the canonical one-screen CRUD app without AI structure", () => {
    const golden = GOLDEN_REGRESSION_SPECS.find(
      (candidate) => candidate.id === "simple-local-storage",
    );
    if (!golden) throw new Error("Missing simple localStorage golden spec");
    const architecture = createFallbackArchitecturePlan(
      golden.spec,
      computeSpecComplexity(golden.spec),
    );

    expect(
      canUseSimpleLocalStorageStarter({ spec: golden.spec, architecture }),
    ).toBe(true);
    const result = generateSimpleLocalStorageStarterApp({
      spec: golden.spec,
      architecture,
    });

    expect(result.phases[0]?.turnLimit).toBe(0);
    expect(result.files["src/lib/simple-app-storage.ts"]).toContain(
      "window.localStorage",
    );
    expect(result.files["src/components/SimpleLocalApp.tsx"]).toContain(
      "data-vf-control",
    );
    expect(result.files["src/components/SimpleLocalApp.test.tsx"]).toContain(
      "validates, adds, edits, completes, filters, deletes, and restores records",
    );
  });

  it("leaves multi-screen or server-backed apps on the normal generator path", () => {
    const golden = GOLDEN_REGRESSION_SPECS.find(
      (candidate) => candidate.id === "shared-platform-data",
    );
    if (!golden) throw new Error("Missing shared platform-data golden spec");
    const architecture = createFallbackArchitecturePlan(
      golden.spec,
      computeSpecComplexity(golden.spec),
    );

    expect(
      canUseSimpleLocalStorageStarter({ spec: golden.spec, architecture }),
    ).toBe(false);
  });
});
