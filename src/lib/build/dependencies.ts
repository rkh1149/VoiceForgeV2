import { builtinModules } from "module";
import type { AppSpec } from "@/lib/spec";
import type { FileMap } from "./template";

export const DEPENDENCY_PROFILE_VALUES = [
  "base",
  "localStorage",
  "platformData",
  "ai",
  "futurePlatform",
  "baseUi",
  "dataDisplay",
  "dateScheduling",
  "advancedInterface",
  "fileExport",
] as const;

export type DependencyProfileId = (typeof DEPENDENCY_PROFILE_VALUES)[number];

export type DependencyProfile = {
  id: DependencyProfileId;
  label: string;
  purpose: string;
  packages: string[];
};

export const APPROVED_RUNTIME_DEPENDENCIES: Record<string, string> = {
  "@dnd-kit/core": "6.3.1",
  "@dnd-kit/sortable": "10.0.0",
  "@dnd-kit/utilities": "3.2.2",
  "@radix-ui/react-dialog": "1.1.19",
  "@radix-ui/react-dropdown-menu": "2.1.20",
  "@radix-ui/react-popover": "1.1.19",
  "@radix-ui/react-select": "2.3.3",
  "@radix-ui/react-tabs": "1.1.17",
  "@tanstack/react-table": "8.21.3",
  clsx: "2.1.1",
  "date-fns": "4.4.0",
  jspdf: "4.2.1",
  "lucide-react": "1.24.0",
  next: "15.5.18",
  papaparse: "5.5.4",
  react: "19.2.3",
  "react-day-picker": "10.0.1",
  "react-dom": "19.2.3",
  "react-hook-form": "7.81.0",
  recharts: "3.9.2",
  "tailwind-merge": "3.6.0",
  zod: "4.4.3",
};

export const APPROVED_DEV_DEPENDENCIES: Record<string, string> = {
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
};

export const DEPENDENCY_PROFILES: Record<DependencyProfileId, DependencyProfile> = {
  base: {
    id: "base",
    label: "Base Next.js app",
    purpose: "Next.js, React, TypeScript, Tailwind, tests, and locked routes.",
    packages: ["next", "react", "react-dom"],
  },
  localStorage: {
    id: "localStorage",
    label: "Browser persistence",
    purpose: "Personal apps that persist data in the browser.",
    packages: [],
  },
  platformData: {
    id: "platformData",
    label: "VoiceForge platform data",
    purpose: "Shared records through the locked /api/data proxy.",
    packages: ["zod"],
  },
  ai: {
    id: "ai",
    label: "VoiceForge AI route",
    purpose: "Text and image AI through the locked /api/ai proxy.",
    packages: [],
  },
  futurePlatform: {
    id: "futurePlatform",
    label: "Future platform service",
    purpose: "Marker for blocked or not-yet-available platform services.",
    packages: [],
  },
  baseUi: {
    id: "baseUi",
    label: "Base UI",
    purpose: "Icons, class composition, validation, and form wiring.",
    packages: ["lucide-react", "clsx", "tailwind-merge", "zod", "react-hook-form"],
  },
  dataDisplay: {
    id: "dataDisplay",
    label: "Data display",
    purpose: "Charts, dashboards, sortable tables, and report views.",
    packages: ["recharts", "@tanstack/react-table"],
  },
  dateScheduling: {
    id: "dateScheduling",
    label: "Date and scheduling",
    purpose: "Date formatting, due dates, and calendar controls.",
    packages: ["date-fns", "react-day-picker"],
  },
  advancedInterface: {
    id: "advancedInterface",
    label: "Advanced interface",
    purpose: "Drag and drop, dialogs, menus, tabs, popovers, and selects.",
    packages: [
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-select",
      "@radix-ui/react-tabs",
    ],
  },
  fileExport: {
    id: "fileExport",
    label: "CSV and export",
    purpose: "Browser CSV import/export and simple PDF exports.",
    packages: ["papaparse", "jspdf"],
  },
};

const APPROVED_BARE_IMPORTS = new Set([
  ...Object.keys(APPROVED_RUNTIME_DEPENDENCIES),
  ...Object.keys(APPROVED_DEV_DEPENDENCIES),
]);
const NODE_BUILTIN_IMPORTS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export type DependencyCheckProblem = {
  path: string;
  message: string;
};

export type DependencyCheckResult = {
  ok: boolean;
  problems: DependencyCheckProblem[];
};

export const APPROVED_DEPENDENCY_GUIDANCE = [
  "Approved generated-app dependency profiles:",
  ...DEPENDENCY_PROFILE_VALUES.map((id) => {
    const profile = DEPENDENCY_PROFILES[id];
    const packages =
      profile.packages.length > 0 ? profile.packages.join(", ") : "no package imports";
    return `- ${profile.id}: ${profile.purpose} Packages: ${packages}.`;
  }),
  "Do not import packages outside this catalogue. package.json is locked and cannot be changed.",
].join("\n");

export function inferDependencyProfiles(spec: AppSpec): DependencyProfileId[] {
  const profiles = new Set<DependencyProfileId>(["base", "baseUi"]);
  if (needsServerData(spec)) profiles.add("platformData");
  else profiles.add("localStorage");
  if (spec.aiFeatures.length > 0) profiles.add("ai");

  const text = searchableSpecText(spec);
  if (
    spec.reports.length > 0 ||
    spec.searchRequirements.length > 0 ||
    hasAny(text, ["chart", "dashboard", "metric", "report", "table", "sort"])
  ) {
    profiles.add("dataDisplay");
  }
  if (
    spec.notifications.length > 0 ||
    spec.dataEntities.some((entity) =>
      entity.fields.some((field) => field.type === "date" || field.type === "datetime"),
    ) ||
    hasAny(text, ["calendar", "schedule", "due date", "deadline", "appointment"])
  ) {
    profiles.add("dateScheduling");
  }
  if (
    hasAny(text, [
      "drag",
      "drop",
      "kanban",
      "board",
      "dialog",
      "modal",
      "tabs",
      "menu",
      "popover",
    ])
  ) {
    profiles.add("advancedInterface");
  }
  if (
    spec.reports.some((report) =>
      report.exportFormats.some((format) => format === "csv" || format === "pdf"),
    ) ||
    hasAny(text, ["csv", "pdf", "export", "import"])
  ) {
    profiles.add("fileExport");
  }
  return [...profiles];
}

export function validateGeneratedAppDependencies(files: FileMap): DependencyCheckResult {
  const problems: DependencyCheckProblem[] = [];
  const packageJson = files["package.json"];
  if (!packageJson) {
    problems.push({ path: "package.json", message: "package.json is missing." });
  } else {
    validatePackageJson(packageJson, problems);
  }

  for (const [filePath, content] of Object.entries(files)) {
    if (!shouldScanImports(filePath)) continue;
    for (const specifier of importSpecifiers(content)) {
      const packageName = packageNameFromSpecifier(specifier);
      if (!packageName) continue;
      if (
        !APPROVED_BARE_IMPORTS.has(packageName) &&
        !NODE_BUILTIN_IMPORTS.has(packageName)
      ) {
        problems.push({
          path: filePath,
          message: `Import "${specifier}" uses unapproved package "${packageName}".`,
        });
      }
    }
    validatePdfExports(filePath, content, problems);
  }

  return { ok: problems.length === 0, problems };
}

function validatePdfExports(
  filePath: string,
  content: string,
  problems: DependencyCheckProblem[],
): void {
  if (
    filePath === "src/lib/voiceforge-modules.ts" ||
    !/\bapplication\/pdf\b/.test(content)
  ) {
    return;
  }

  const createsPdfBlob =
    /\bnew\s+Blob\s*\([\s\S]{0,600}\btype\s*:\s*["']application\/pdf["']/.test(
      content,
    );
  if (createsPdfBlob) {
    problems.push({
      path: filePath,
      message:
        "PDF exports must generate real PDF bytes with jsPDF or the locked downloadSimplePdf/downloadRecordsPdf helpers; do not label plain text Blobs as application/pdf.",
    });
  }
}

function validatePackageJson(
  content: string,
  problems: DependencyCheckProblem[],
): void {
  let parsed: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    problems.push({ path: "package.json", message: "package.json is invalid JSON." });
    return;
  }
  compareDependencySection(
    "dependencies",
    parsed.dependencies ?? {},
    APPROVED_RUNTIME_DEPENDENCIES,
    problems,
  );
  compareDependencySection(
    "devDependencies",
    parsed.devDependencies ?? {},
    APPROVED_DEV_DEPENDENCIES,
    problems,
  );
}

function compareDependencySection(
  sectionName: "dependencies" | "devDependencies",
  actual: Record<string, string>,
  expected: Record<string, string>,
  problems: DependencyCheckProblem[],
): void {
  for (const [name, version] of Object.entries(actual)) {
    if (!(name in expected)) {
      problems.push({
        path: "package.json",
        message: `${sectionName}.${name} is not approved.`,
      });
    } else if (expected[name] !== version) {
      problems.push({
        path: "package.json",
        message: `${sectionName}.${name} must be ${expected[name]}, found ${version}.`,
      });
    }
  }
  for (const [name, version] of Object.entries(expected)) {
    if (actual[name] !== version) {
      problems.push({
        path: "package.json",
        message: `${sectionName}.${name} must be present at ${version}.`,
      });
    }
  }
}

function importSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(content);
    while (match) {
      specifiers.push(match[1]);
      match = pattern.exec(content);
    }
  }
  return specifiers;
}

function shouldScanImports(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath);
}

function packageNameFromSpecifier(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("data:")
  ) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0] || null;
}

function needsServerData(spec: AppSpec): boolean {
  return (
    spec.needsLogin ||
    spec.sharingModel !== "private" ||
    spec.dataEntities.some((entity) => entity.ownership !== "per_user")
  );
}

function searchableSpecText(spec: AppSpec): string {
  return JSON.stringify({
    screens: spec.screens,
    features: spec.features,
    dataToStore: spec.dataToStore,
    dataEntities: spec.dataEntities,
    workflows: spec.workflows,
    reports: spec.reports,
    searchRequirements: spec.searchRequirements,
    acceptanceCriteria: spec.acceptanceCriteria,
  }).toLowerCase();
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
