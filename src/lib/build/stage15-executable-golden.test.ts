import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { STAGE15_BROWSER_GOLDEN_FILES } from "./fixtures/stage15-browser-golden";
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
});
