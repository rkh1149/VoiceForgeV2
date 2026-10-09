import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { STAGE15_BROWSER_GOLDEN_FILES } from "./fixtures/stage15-browser-golden";
import { createFallbackArchitecturePlan } from "../architecture";
import {
  canUseSimpleLocalStorageStarter,
  generateSimpleLocalStorageStarterApp,
} from "../agents/simple-local-storage-starter";
import { computeSpecComplexity } from "../spec";
import { GOLDEN_REGRESSION_SPECS } from "./golden-regression-specs";
import { applyDeterministicAcceptanceCompiler } from "./acceptance-compiler";
import { reconcileGeneratedAppDependencies } from "./dependencies";
import { createRunner, type StepName } from "./runner";
import { loadTemplate } from "./template";

const enabled = process.env.RUN_STAGE15_BROWSER_GOLDENS === "1";

describe("Stage 15 executable browser golden", () => {
  it.skipIf(!enabled)(
    "passes the complete generated-app test gauntlet",
    async () => {
      const buildId = `stage15-browser-${Date.now()}`;
      const runner = await createRunner(buildId);
      try {
        const files = await loadTemplate({
          slug: "stage15-browser-golden",
          name: "Stage 15 Planning Board",
          purpose: "Exercise persistent generated-app workflows.",
          capabilities: {
            data: false,
            files: false,
            ai: false,
            notifications: false,
            integrations: false,
            deviceLocation: false,
            reusableComponents: false,
            utilityModules: false,
          },
        });
        const generatedFiles = { ...files, ...STAGE15_BROWSER_GOLDEN_FILES };
        const reconciliation = reconcileGeneratedAppDependencies(generatedFiles);
        expect(reconciliation.problems).toEqual([]);
        await runner.writeFiles(generatedFiles);
        const steps: StepName[] = [
          "install",
          "typecheck",
          "lint",
          "test",
          "build",
          "e2e",
        ];
        for (const step of steps) {
          const result = await runner.run(step);
          expect.soft(result.ok, `${step}: ${result.output}`).toBe(true);
          if (!result.ok) break;
        }
      } finally {
        await runner.dispose();
        await fs.rm(
          path.join(os.tmpdir(), "voiceforge-v2-builds", buildId),
          { recursive: true, force: true },
        );
      }
    },
    30 * 60_000,
  );

  it.skipIf(!enabled)(
    "passes the generated deterministic simple-app blueprint gauntlet",
    async () => {
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
      const generated = generateSimpleLocalStorageStarterApp({
        spec: golden.spec,
        architecture,
      });
      const files = await loadTemplate({
        slug: "stage15-simple-blueprint",
        name: golden.spec.appName,
        purpose: golden.spec.purpose,
        capabilities: {
          data: false,
          files: false,
          ai: false,
          notifications: false,
          integrations: false,
          deviceLocation: false,
          reusableComponents: false,
          utilityModules: false,
        },
      });
      Object.assign(files, generated.files);
      const acceptance = applyDeterministicAcceptanceCompiler({
        spec: golden.spec,
        architecture,
        files,
        generated,
      });
      expect(acceptance.blockingIssues).toEqual([]);
      expect(acceptance.manifest.validationProfile).toBe("simple");
      const reconciliation = reconcileGeneratedAppDependencies(files);
      expect(reconciliation.problems).toEqual([]);

      const buildId = `stage15-simple-blueprint-${Date.now()}`;
      const runner = await createRunner(buildId, {
        env: { VOICEFORGE_FORCE_FULL_E2E: "1" },
      });
      try {
        await runner.writeFiles(files);
        const steps: StepName[] = [
          "install",
          "typecheck",
          "lint",
          "test",
          "build",
          "e2e",
        ];
        for (const step of steps) {
          const result = await runner.run(step);
          expect.soft(result.ok, `${step}: ${result.output}`).toBe(true);
          if (!result.ok) break;
        }
      } finally {
        await runner.dispose();
        await fs.rm(
          path.join(os.tmpdir(), "voiceforge-v2-builds", buildId),
          { recursive: true, force: true },
        );
      }
    },
    30 * 60_000,
  );
});
