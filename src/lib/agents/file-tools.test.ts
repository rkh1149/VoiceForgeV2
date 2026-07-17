import { describe, expect, it } from "vitest";
import {
  deleteAgentFile,
  patchAgentFile,
  readAgentFile,
  renameAgentFile,
  searchAgentCode,
  writeAgentFile,
  type FileOperation,
} from "./file-tools";
import { isAgentWritablePath, type FileMap } from "../build/template";

describe("agent file tool path policy", () => {
  it("allows generated app source and generated browser tests", () => {
    expect(isAgentWritablePath("src/app/page.tsx").ok).toBe(true);
    expect(isAgentWritablePath("src/components/Timer.tsx").ok).toBe(true);
    expect(isAgentWritablePath("src/lib/storage.ts").ok).toBe(true);
    expect(isAgentWritablePath("e2e/generated/acceptance.spec.ts").ok).toBe(true);
  });

  it("rejects protected files, API routes, configs, and unsafe paths", () => {
    expect(isAgentWritablePath("src/app/globals.css").ok).toBe(false);
    expect(isAgentWritablePath("src/lib/template.test.ts").ok).toBe(false);
    expect(isAgentWritablePath("src/lib/platform-data.ts").ok).toBe(false);
    expect(isAgentWritablePath("src/lib/voiceforge-modules.ts").ok).toBe(false);
    expect(isAgentWritablePath("src/components/voiceforge-reusable.tsx").ok).toBe(
      false,
    );
    expect(isAgentWritablePath("src/app/api/data/route.ts").ok).toBe(false);
    expect(isAgentWritablePath("e2e/smoke.spec.ts").ok).toBe(false);
    expect(isAgentWritablePath("src/app/api/custom/route.ts").ok).toBe(false);
    expect(isAgentWritablePath("package.json").ok).toBe(false);
    expect(isAgentWritablePath("../src/app/page.tsx").ok).toBe(false);
  });
});

describe("agent file operations", () => {
  it("writes only approved files and records mutations", () => {
    const files: FileMap = {};
    const log: FileOperation[] = [];

    const ok = writeAgentFile(files, log, "src/lib/types.ts", "export type X = {};");
    const rejected = writeAgentFile(files, log, "package.json", "{}");

    expect(ok.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    expect(files["src/lib/types.ts"]).toContain("type X");
    expect(log).toEqual([{ operation: "write", path: "src/lib/types.ts" }]);
  });

  it("patches exact text and rejects ambiguous replacements", () => {
    const files: FileMap = {
      "src/lib/copy.ts": "export const label = 'Save';\nexport const other = 'Save';\n",
    };
    const log: FileOperation[] = [];

    const ambiguous = patchAgentFile(files, log, {
      path: "src/lib/copy.ts",
      search: "Save",
      replace: "Done",
    });
    const patched = patchAgentFile(files, log, {
      path: "src/lib/copy.ts",
      search: "Save",
      replace: "Done",
      replaceAll: true,
    });

    expect(ambiguous.ok).toBe(false);
    expect(patched.ok).toBe(true);
    expect(files["src/lib/copy.ts"]).toContain("'Done'");
    expect(files["src/lib/copy.ts"]).not.toContain("'Save'");
    expect(log).toEqual([{ operation: "patch", path: "src/lib/copy.ts" }]);
  });

  it("deletes and renames only approved mutable files", () => {
    const files: FileMap = {
      "src/components/Old.tsx": "export function Old() { return null; }",
      "src/components/DeleteMe.tsx": "export function DeleteMe() { return null; }",
    };
    const log: FileOperation[] = [];

    const renamed = renameAgentFile(files, log, {
      fromPath: "src/components/Old.tsx",
      toPath: "src/components/New.tsx",
    });
    const deleted = deleteAgentFile(files, log, "src/components/DeleteMe.tsx");
    const protectedDelete = deleteAgentFile(files, log, "e2e/smoke.spec.ts");

    expect(renamed.ok).toBe(true);
    expect(deleted.ok).toBe(true);
    expect(protectedDelete.ok).toBe(false);
    expect(files["src/components/Old.tsx"]).toBeUndefined();
    expect(files["src/components/New.tsx"]).toContain("Old");
    expect(files["src/components/DeleteMe.tsx"]).toBeUndefined();
    expect(log).toEqual([
      {
        operation: "rename",
        path: "src/components/Old.tsx",
        targetPath: "src/components/New.tsx",
      },
      { operation: "delete", path: "src/components/DeleteMe.tsx" },
    ]);
  });

  it("reads and searches visible files without exposing non-readable paths", () => {
    const files: FileMap = {
      "src/app/page.tsx": "export default function Home() { return <h1>Reading</h1>; }",
      "package.json": "{\"scripts\":{}}",
      ".env.local": "SECRET=value",
    };

    expect(readAgentFile(files, "src/app/page.tsx").ok).toBe(true);
    expect(readAgentFile(files, ".env.local").ok).toBe(false);
    expect(searchAgentCode(files, { query: "Reading" })).toEqual([
      "src/app/page.tsx:1: export default function Home() { return <h1>Reading</h1>; }",
    ]);
    expect(searchAgentCode(files, { query: "SECRET" })).toEqual(["No matches."]);
  });
});
