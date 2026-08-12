import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listTemplateFiles,
  loadTemplate,
  refreshResumedTemplateFiles,
  TEMPLATE_IGNORED_DIRECTORIES,
} from "./template";

describe("template loader", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("excludes dependencies and generated output from template traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "voiceforge-template-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src", "app"), { recursive: true });
    await writeFile(path.join(root, "src", "app", "page.tsx"), "export default 1;");

    for (const ignoredDirectory of TEMPLATE_IGNORED_DIRECTORIES) {
      const ignoredPath = path.join(root, ignoredDirectory);
      await mkdir(ignoredPath, { recursive: true });
      await writeFile(path.join(ignoredPath, "should-not-load.ts"), "ignored");
    }

    await expect(listTemplateFiles(root)).resolves.toEqual(["src/app/page.tsx"]);
  });

  it("refreshes the locked acceptance helper without replacing generated app source", async () => {
    const files = {
      "e2e/smoke.spec.ts": "old smoke test",
      "e2e/voiceforge-acceptance.ts": "old helper",
      "e2e/voiceforge-progress-reporter.ts": "old reporter",
      "playwright.config.ts": "old config",
      "src/app/page.tsx": "generated app source",
    };

    await expect(
      refreshResumedTemplateFiles(files, {
        slug: "lending-tracker",
        name: "Lending Tracker",
        purpose: "Track shared equipment",
      }),
    ).resolves.toEqual([
      "e2e/smoke.spec.ts",
      "e2e/voiceforge-acceptance.ts",
      "e2e/voiceforge-progress-reporter.ts",
      "playwright.config.ts",
    ]);
    expect(files["e2e/voiceforge-acceptance.ts"]).toContain(
      "export function acceptanceRunSuffix",
    );
    expect(files["e2e/voiceforge-progress-reporter.ts"]).toContain(
      "class VoiceForgeProgressReporter",
    );
    expect(files["playwright.config.ts"]).toContain("actionTimeout: 12_000");
    expect(files["e2e/smoke.spec.ts"]).toContain("node.failureSummary");
    expect(files["src/app/page.tsx"]).toBe("generated app source");
  });

  it("keeps actionable axe node details in the locked smoke test", async () => {
    const files = await loadTemplate({
      slug: "accessible-app",
      name: "Accessible App",
      purpose: "Verify accessibility diagnostics",
    });

    expect(files["e2e/smoke.spec.ts"]).toContain(
      "target=${JSON.stringify(node.target)}",
    );
    expect(files["e2e/smoke.spec.ts"]).toContain("html=${node.html.slice");
    expect(files["e2e/smoke.spec.ts"]).toContain("node.failureSummary");
  });
});
