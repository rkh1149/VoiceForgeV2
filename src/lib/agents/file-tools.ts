import path from "path";
import { tool } from "@openai/agents";
import { z } from "zod";
import {
  isAgentReadablePath,
  isAgentWritablePath,
  type FileMap,
} from "../build/template";

const MAX_READ_CHARS = 24_000;
const MAX_SEARCH_RESULTS = 40;
const MAX_APP_MAP_MATCHES = 80;

export type FileOperation = {
  operation: "write" | "patch" | "delete" | "rename";
  path: string;
  targetPath?: string;
};

export type DiagnosticsContext = {
  failedStep?: string;
  errorOutput?: string;
  typeErrors?: string;
  testResults?: string;
  browserFailure?: string;
};

export type AgentFileToolsOptions = {
  mutationLog: FileOperation[];
  diagnostics?: DiagnosticsContext;
  allowMutations?: boolean;
};

type OperationResult = {
  ok: boolean;
  message: string;
  path?: string;
  targetPath?: string;
};

function normalizeAgentPath(p: string): string {
  return path.posix.normalize(p.replaceAll("\\", "/"));
}

function sortedReadablePaths(files: FileMap): string[] {
  return Object.keys(files)
    .map(normalizeAgentPath)
    .filter((p) => isAgentReadablePath(p).ok)
    .sort();
}

export function listAgentFiles(
  files: FileMap,
  input: { prefix?: string } = {},
): string[] {
  const prefix = input.prefix ? normalizeAgentPath(input.prefix) : "";
  return sortedReadablePaths(files).filter((p) => !prefix || p.startsWith(prefix));
}

export function readAgentFile(files: FileMap, filePath: string): OperationResult {
  const normalized = normalizeAgentPath(filePath);
  const readable = isAgentReadablePath(normalized);
  if (!readable.ok) {
    return { ok: false, message: `REJECTED: ${readable.reason}`, path: normalized };
  }
  const content = files[normalized];
  if (content === undefined) {
    return { ok: false, message: `REJECTED: ${normalized} does not exist`, path: normalized };
  }
  return {
    ok: true,
    message:
      content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS)}\n\n[truncated at ${MAX_READ_CHARS} chars]`
        : content,
    path: normalized,
  };
}

export function searchAgentCode(
  files: FileMap,
  input: { query: string; caseSensitive?: boolean; maxResults?: number },
): string[] {
  const query = input.query.trim();
  if (!query) return ["REJECTED: query cannot be empty"];

  const needle = input.caseSensitive ? query : query.toLowerCase();
  const maxResults = Math.min(
    Math.max(input.maxResults ?? 20, 1),
    MAX_SEARCH_RESULTS,
  );
  const results: string[] = [];

  for (const filePath of sortedReadablePaths(files)) {
    const content = files[filePath];
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const haystack = input.caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(needle)) continue;
      results.push(`${filePath}:${index + 1}: ${line.trim()}`);
      if (results.length >= maxResults) return results;
    }
  }

  return results.length > 0 ? results : ["No matches."];
}

export function inspectAgentAppMap(files: FileMap): string {
  const readablePaths = sortedReadablePaths(files);
  const routes = readablePaths.filter(
    (p) =>
      p.startsWith("src/app/") &&
      (p.endsWith("/page.tsx") ||
        p.endsWith("/layout.tsx") ||
        p.endsWith("/error.tsx") ||
        p.endsWith("/not-found.tsx")),
  );
  const components = readablePaths.filter((p) => p.startsWith("src/components/"));
  const libs = readablePaths.filter((p) => p.startsWith("src/lib/"));
  const tests = readablePaths.filter(
    (p) =>
      p.endsWith(".test.ts") ||
      p.endsWith(".test.tsx") ||
      p.endsWith(".spec.ts") ||
      p.endsWith(".spec.tsx"),
  );

  const dataTouchpoints = collectLineMatches(files, readablePaths, [
    "platform-data",
    "listPlatformRecords",
    "createPlatformRecord",
    "updatePlatformRecord",
    "deletePlatformRecord",
    "getPlatformSession",
    "localStorage",
    "storage",
  ]);
  const workflowTouchpoints = collectLineMatches(files, readablePaths, [
    "onSubmit",
    "handleSubmit",
    "submit",
    "Save",
    "save",
    "button",
    "form",
    "create",
    "update",
    "delete",
    "search",
    "filter",
    "sort",
    "drag",
    "drop",
    "export",
    "CSV",
    "comment",
  ]);
  const imports = collectImportEdges(files, readablePaths);

  return [
    "APP SOURCE MAP",
    formatSection("Routes", routes),
    formatSection("Components", components),
    formatSection("Libraries", libs),
    formatSection("Tests", tests),
    formatSection("Data/storage touchpoints", dataTouchpoints),
    formatSection("Workflow/control touchpoints", workflowTouchpoints),
    formatSection("Internal import edges", imports),
  ].join("\n\n");
}

function collectLineMatches(
  files: FileMap,
  paths: string[],
  needles: string[],
): string[] {
  const lowerNeedles = needles.map((needle) => needle.toLowerCase());
  const matches: string[] = [];
  for (const filePath of paths) {
    const content = files[filePath];
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const lower = line.toLowerCase();
      if (!lowerNeedles.some((needle) => lower.includes(needle))) continue;
      matches.push(`${filePath}:${index + 1}: ${line.trim()}`);
      if (matches.length >= MAX_APP_MAP_MATCHES) return matches;
    }
  }
  return matches;
}

function collectImportEdges(files: FileMap, paths: string[]): string[] {
  const imports: string[] = [];
  const importPattern = /from\s+["']([^"']+)["']/g;
  for (const filePath of paths) {
    const content = files[filePath];
    if (content === undefined) continue;
    for (const line of content.split(/\r?\n/)) {
      importPattern.lastIndex = 0;
      const match = importPattern.exec(line);
      const target = match?.[1];
      if (!target || (!target.startsWith("@/") && !target.startsWith("."))) {
        continue;
      }
      imports.push(`${filePath} -> ${target}`);
      if (imports.length >= MAX_APP_MAP_MATCHES) return imports;
    }
  }
  return imports;
}

function formatSection(label: string, values: string[]): string {
  if (values.length === 0) return `${label}:\n- none found`;
  return `${label}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}

export function writeAgentFile(
  files: FileMap,
  mutationLog: FileOperation[],
  filePath: string,
  content: string,
): OperationResult {
  const normalized = normalizeAgentPath(filePath);
  const writable = isAgentWritablePath(normalized);
  if (!writable.ok) {
    return { ok: false, message: `REJECTED: ${writable.reason}`, path: normalized };
  }
  files[normalized] = content;
  mutationLog.push({ operation: "write", path: normalized });
  return {
    ok: true,
    message: `Wrote ${normalized} (${content.length} chars).`,
    path: normalized,
  };
}

export function patchAgentFile(
  files: FileMap,
  mutationLog: FileOperation[],
  input: {
    path: string;
    search: string;
    replace: string;
    replaceAll?: boolean;
  },
): OperationResult {
  const normalized = normalizeAgentPath(input.path);
  const writable = isAgentWritablePath(normalized);
  if (!writable.ok) {
    return { ok: false, message: `REJECTED: ${writable.reason}`, path: normalized };
  }
  const current = files[normalized];
  if (current === undefined) {
    return { ok: false, message: `REJECTED: ${normalized} does not exist`, path: normalized };
  }
  if (!input.search) {
    return { ok: false, message: "REJECTED: search cannot be empty", path: normalized };
  }
  const occurrences = current.split(input.search).length - 1;
  if (occurrences === 0) {
    return {
      ok: false,
      message: `REJECTED: search text was not found in ${normalized}`,
      path: normalized,
    };
  }
  if (occurrences > 1 && !input.replaceAll) {
    return {
      ok: false,
      message: `REJECTED: search text appears ${occurrences} times; set replaceAll=true or use a more specific search`,
      path: normalized,
    };
  }

  files[normalized] = input.replaceAll
    ? current.replaceAll(input.search, input.replace)
    : current.replace(input.search, input.replace);
  mutationLog.push({ operation: "patch", path: normalized });
  return {
    ok: true,
    message: `Patched ${normalized} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`,
    path: normalized,
  };
}

export function deleteAgentFile(
  files: FileMap,
  mutationLog: FileOperation[],
  filePath: string,
): OperationResult {
  const normalized = normalizeAgentPath(filePath);
  const writable = isAgentWritablePath(normalized);
  if (!writable.ok) {
    return { ok: false, message: `REJECTED: ${writable.reason}`, path: normalized };
  }
  if (files[normalized] === undefined) {
    return { ok: false, message: `REJECTED: ${normalized} does not exist`, path: normalized };
  }
  delete files[normalized];
  mutationLog.push({ operation: "delete", path: normalized });
  return { ok: true, message: `Deleted ${normalized}.`, path: normalized };
}

export function renameAgentFile(
  files: FileMap,
  mutationLog: FileOperation[],
  input: { fromPath: string; toPath: string },
): OperationResult {
  const fromPath = normalizeAgentPath(input.fromPath);
  const toPath = normalizeAgentPath(input.toPath);
  const fromWritable = isAgentWritablePath(fromPath);
  if (!fromWritable.ok) {
    return { ok: false, message: `REJECTED: ${fromWritable.reason}`, path: fromPath };
  }
  const toWritable = isAgentWritablePath(toPath);
  if (!toWritable.ok) {
    return { ok: false, message: `REJECTED: ${toWritable.reason}`, path: toPath };
  }
  const current = files[fromPath];
  if (current === undefined) {
    return { ok: false, message: `REJECTED: ${fromPath} does not exist`, path: fromPath };
  }
  if (files[toPath] !== undefined) {
    return { ok: false, message: `REJECTED: ${toPath} already exists`, path: toPath };
  }
  delete files[fromPath];
  files[toPath] = current;
  mutationLog.push({ operation: "rename", path: fromPath, targetPath: toPath });
  return {
    ok: true,
    message: `Renamed ${fromPath} to ${toPath}.`,
    path: fromPath,
    targetPath: toPath,
  };
}

export function createAgentFileTools(
  files: FileMap,
  options: AgentFileToolsOptions,
) {
  const mutationLog = options.mutationLog;
  const mutationsAllowed = options.allowMutations ?? true;
  const rejectMutation = () =>
    "REJECTED: this phase is inspect-only; use list_files, read_file, or search_code.";

  const readOnlyTools = [
    tool({
      name: "list_files",
      description:
        "List files currently visible in the generated app workspace, optionally under a prefix.",
      parameters: z.object({
        prefix: z.string().optional().describe("Optional path prefix such as src/lib"),
      }),
      execute: async ({ prefix }) => listAgentFiles(files, { prefix }).join("\n"),
    }),
    tool({
      name: "read_file",
      description: "Read one visible generated-app file by repo-relative path.",
      parameters: z.object({
        path: z.string().describe("Repo-relative path to read"),
      }),
      execute: async ({ path: p }) => readAgentFile(files, p).message,
    }),
    tool({
      name: "search_code",
      description:
        "Search visible generated-app files for text and return path:line matches.",
      parameters: z.object({
        query: z.string().describe("Text to search for"),
        caseSensitive: z.boolean().optional(),
        maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
      }),
      execute: async (input) => searchAgentCode(files, input).join("\n"),
    }),
    tool({
      name: "inspect_app_map",
      description:
        "Summarize visible generated-app routes, components, libraries, tests, data/storage touchpoints, workflow touchpoints, and internal imports before a deep diagnostic change.",
      parameters: z.object({}),
      execute: async () => inspectAgentAppMap(files),
    }),
    tool({
      name: "inspect_test_results",
      description: "Inspect the latest test/lint/build output when debugging.",
      parameters: z.object({}),
      execute: async () =>
        options.diagnostics?.testResults ??
        options.diagnostics?.errorOutput ??
        "No test diagnostics are available yet.",
    }),
    tool({
      name: "inspect_type_errors",
      description: "Inspect the latest TypeScript output when debugging.",
      parameters: z.object({}),
      execute: async () =>
        options.diagnostics?.typeErrors ??
        (options.diagnostics?.failedStep === "typecheck"
          ? options.diagnostics.errorOutput
          : undefined) ??
        "No TypeScript diagnostics are available yet.",
    }),
    tool({
      name: "inspect_browser_failure",
      description: "Inspect the latest browser/accessibility failure output.",
      parameters: z.object({}),
      execute: async () =>
        options.diagnostics?.browserFailure ??
        (options.diagnostics?.failedStep === "e2e"
          ? options.diagnostics.errorOutput
          : undefined) ??
        "No browser diagnostics are available yet.",
    }),
  ];

  const mutationTools = [
    tool({
      name: "write_file",
      description:
        "Create or overwrite one approved generated-app file with complete file content.",
      parameters: z.object({
        path: z.string().describe("Repo-relative path, e.g. src/app/page.tsx"),
        content: z.string().describe("Complete file content"),
      }),
      execute: async ({ path: p, content }) =>
        mutationsAllowed
          ? writeAgentFile(files, mutationLog, p, content).message
          : rejectMutation(),
    }),
    tool({
      name: "patch_file",
      description:
        "Patch one approved generated-app file by replacing exact text. Use write_file for large rewrites.",
      parameters: z.object({
        path: z.string().describe("Repo-relative file path"),
        search: z.string().describe("Exact text to replace"),
        replace: z.string().describe("Replacement text"),
        replaceAll: z.boolean().optional(),
      }),
      execute: async (input) =>
        mutationsAllowed
          ? patchAgentFile(files, mutationLog, input).message
          : rejectMutation(),
    }),
    tool({
      name: "delete_file",
      description: "Delete one approved generated-app file.",
      parameters: z.object({
        path: z.string().describe("Repo-relative file path to delete"),
      }),
      execute: async ({ path: p }) =>
        mutationsAllowed
          ? deleteAgentFile(files, mutationLog, p).message
          : rejectMutation(),
    }),
    tool({
      name: "rename_file",
      description: "Rename one approved generated-app file to another approved path.",
      parameters: z.object({
        fromPath: z.string().describe("Current repo-relative file path"),
        toPath: z.string().describe("New repo-relative file path"),
      }),
      execute: async (input) =>
        mutationsAllowed
          ? renameAgentFile(files, mutationLog, input).message
          : rejectMutation(),
    }),
  ];

  return [...readOnlyTools, ...mutationTools];
}
