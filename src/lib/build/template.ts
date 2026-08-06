import { promises as fs } from "fs";
import path from "path";

/** Repo-relative path -> file content. */
export type FileMap = Record<string, string>;

const TEMPLATE_DIR = path.join(process.cwd(), "templates", "nextjs-base");

export const TEMPLATE_MAX_FILE_COUNT = 500;
export const TEMPLATE_MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export const TEMPLATE_IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  "playwright-report",
  "test-results",
]);

/** Paths the Code/Debug agents are allowed to create or overwrite. */
const WRITABLE_PREFIXES = [
  "src/app/",
  "src/components/",
  "src/lib/",
  "e2e/generated/",
];

/** Readable generated-app files exposed through code navigation tools. */
const READABLE_PREFIXES = ["src/", "e2e/"];
const READABLE_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "playwright.config.ts",
  "vitest.config.ts",
  "vitest.setup.ts",
]);

/** Files agents must never touch (template integrity). */
const PROTECTED_FILES = new Set([
  "src/app/globals.css",
  "src/lib/template.test.ts",
  "src/lib/platform-data.ts", // locked platform data browser client (Stage 9B)
  "src/lib/platform-files.ts", // locked platform files browser client (Stage 11A)
  "src/lib/platform-notifications.ts", // locked platform notification client (Stage 11B)
  "src/lib/platform-integrations.ts", // locked platform integration client (Stage 12A/12C)
  "src/lib/device-location.ts", // locked browser device GPS/location helpers
  "src/lib/voiceforge-modules.ts", // locked reusable helpers (Stage 10)
  "src/components/voiceforge-reusable.tsx", // locked reusable UI components (Stage 10)
  "src/components/voiceforge-google-map.tsx", // locked Google Maps UI component (Stage 12C)
  "src/app/api/ai/route.ts", // locked AI endpoint (Stage 7)
  "src/app/api/data/route.ts", // locked platform data endpoint (Stage 9B)
  "src/app/api/files/route.ts", // locked platform files endpoint (Stage 11A)
  "src/app/api/notifications/route.ts", // locked platform notification endpoint (Stage 11B)
  "src/app/api/integrations/route.ts", // locked platform integration endpoint (Stage 12A/12C)
  "e2e/smoke.spec.ts", // locked browser/accessibility smoke test
]);

const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx"]);

export function isAgentWritablePath(p: string): {
  ok: boolean;
  reason?: string;
} {
  const normalized = path.posix.normalize(p.replaceAll("\\", "/"));
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return { ok: false, reason: "Path must be relative, without '..'" };
  }
  if (PROTECTED_FILES.has(normalized)) {
    return { ok: false, reason: `${normalized} is protected` };
  }
  if (normalized.startsWith("src/app/api/")) {
    return { ok: false, reason: "Generated apps cannot create API routes" };
  }
  if (!WRITABLE_PREFIXES.some((pre) => normalized.startsWith(pre))) {
    return {
      ok: false,
      reason: `Files may only be written under: ${WRITABLE_PREFIXES.join(", ")}`,
    };
  }
  if (!ALLOWED_EXTENSIONS.has(path.posix.extname(normalized))) {
    return { ok: false, reason: "Only .ts and .tsx files are allowed" };
  }
  return { ok: true };
}

export function isAgentReadablePath(p: string): {
  ok: boolean;
  reason?: string;
} {
  const normalized = path.posix.normalize(p.replaceAll("\\", "/"));
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return { ok: false, reason: "Path must be relative, without '..'" };
  }
  if (
    !READABLE_FILES.has(normalized) &&
    !READABLE_PREFIXES.some((pre) => normalized.startsWith(pre))
  ) {
    return {
      ok: false,
      reason: "Only generated app source, tests, and locked project config may be read",
    };
  }
  return { ok: true };
}

/** Escape a value for safe substitution into template string literals. */
function sanitize(value: string): string {
  return value.replace(/[\\"`]/g, "'").replace(/\s+/g, " ").trim();
}

async function walk(
  dir: string,
  base: string,
  files: string[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!TEMPLATE_IGNORED_DIRECTORIES.has(entry.name)) {
        await walk(path.join(dir, entry.name), rel, files);
      }
    } else {
      files.push(rel);
      if (files.length > TEMPLATE_MAX_FILE_COUNT) {
        throw new Error(
          `App template contains more than ${TEMPLATE_MAX_FILE_COUNT} source files. ` +
            "Remove dependency, build-output, coverage, and test-report directories from the template.",
        );
      }
    }
  }
}

/** List source-controlled template files while excluding local/generated output. */
export async function listTemplateFiles(dir = TEMPLATE_DIR): Promise<string[]> {
  const files: string[] = [];
  await walk(dir, "", files);
  return files.sort();
}

/** Load the base template with app name/slug/purpose substituted in. */
export async function loadTemplate(vars: {
  slug: string;
  name: string;
  purpose: string;
}): Promise<FileMap> {
  const paths = await listTemplateFiles();
  const map: FileMap = {};
  let sourceBytes = 0;
  for (const rel of paths) {
    const raw = await fs.readFile(path.join(TEMPLATE_DIR, rel), "utf8");
    sourceBytes += Buffer.byteLength(rel, "utf8") + Buffer.byteLength(raw, "utf8");
    if (sourceBytes > TEMPLATE_MAX_SOURCE_BYTES) {
      throw new Error(
        `App template source exceeds ${formatMegabytes(TEMPLATE_MAX_SOURCE_BYTES)}. ` +
          "Remove dependency, build-output, coverage, and test-report files from the template.",
      );
    }
    map[rel] = raw
      .replaceAll("__APP_SLUG__", sanitize(vars.slug))
      .replaceAll("__APP_NAME__", sanitize(vars.name))
      .replaceAll("__APP_PURPOSE__", sanitize(vars.purpose));
  }
  return map;
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
