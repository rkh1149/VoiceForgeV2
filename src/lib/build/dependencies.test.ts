import { describe, expect, it } from "vitest";
import {
  APPROVED_RUNTIME_DEPENDENCIES,
  inferDependencyProfiles,
  validateGeneratedAppDependencies,
} from "./dependencies";
import { computeSpecComplexity, normalizeAppSpec } from "../spec";
import { createFallbackArchitecturePlan } from "../architecture";

const basePackageJson = JSON.stringify({
  dependencies: APPROVED_RUNTIME_DEPENDENCIES,
  devDependencies: {
    "@axe-core/playwright": "4.12.1",
    "@eslint/eslintrc": "3.3.1",
    "@playwright/test": "1.61.1",
    "@tailwindcss/postcss": "4.3.0",
    "@testing-library/jest-dom": "6.9.1",
    "@testing-library/react": "16.3.2",
    "@types/node": "22.19.1",
    "@types/papaparse": "5.5.2",
    "@types/react": "19.2.9",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.3",
    eslint: "9.39.2",
    "eslint-config-next": "15.5.18",
    jsdom: "26.1.0",
    tailwindcss: "4.3.0",
    typescript: "5.9.2",
    vitest: "4.1.8",
  },
});

const specInput = {
  appName: "Family Schedule Dashboard",
  purpose: "Track appointments, charts, CSV exports, and drag/drop planning.",
  targetUsers: "Family",
  screens: [{ name: "Dashboard", description: "Calendar and charts." }],
  features: ["Calendar", "Chart dashboard", "CSV export", "Drag/drop board"],
  dataToStore: ["appointments with due date and status"],
  needsLogin: false,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Add appointment"],
  deploymentNotes: "",
};

describe("generated dependency catalogue", () => {
  it("accepts only the locked approved package set and imports", () => {
    const result = validateGeneratedAppDependencies({
      "package.json": basePackageJson,
      "src/app/page.tsx": `import { Calendar } from "lucide-react";
import { z } from "zod";
import { listPlatformRecords } from "@/lib/platform-data";
export default function Page() { return <Calendar aria-label="Calendar" />; }`,
      "e2e/generated/workflow.spec.ts": `import { test } from "@playwright/test";`,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects package drift and arbitrary imports", () => {
    const result = validateGeneratedAppDependencies({
      "package.json": JSON.stringify({
        dependencies: { ...APPROVED_RUNTIME_DEPENDENCIES, axios: "1.0.0" },
        devDependencies: {},
      }),
      "src/app/page.tsx": `import axios from "axios";`,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.message)).toContain(
      "dependencies.axios is not approved.",
    );
    expect(
      result.problems.some((problem) =>
        problem.message.includes('Import "axios" uses unapproved package "axios"'),
      ),
    ).toBe(true);
  });

  it("rejects fake PDF exports that download plain text as application/pdf", () => {
    const result = validateGeneratedAppDependencies({
      "package.json": basePackageJson,
      "src/components/exports.tsx": `export function Exports() {
  function pdf() {
    const text = "Report";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "application/pdf" }));
    link.download = "report.pdf";
    link.click();
  }
  return <button onClick={pdf}>PDF</button>;
}`,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.message)).toContain(
      "PDF exports must generate real PDF bytes with jsPDF or the locked downloadSimplePdf/downloadRecordsPdf helpers; do not label plain text Blobs as application/pdf.",
    );
  });

  it("infers richer Stage 10 profiles from complex specs", () => {
    const spec = normalizeAppSpec(specInput);
    const profiles = inferDependencyProfiles(spec);
    const architecture = createFallbackArchitecturePlan(
      spec,
      computeSpecComplexity(spec),
    );

    expect(profiles).toEqual(
      expect.arrayContaining([
        "baseUi",
        "platformData",
        "dataDisplay",
        "dateScheduling",
        "advancedInterface",
        "fileExport",
      ]),
    );
    expect(architecture.dependencyProfile).toEqual(expect.arrayContaining(profiles));
  });
});
