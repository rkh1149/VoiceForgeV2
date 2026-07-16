import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { FileMap } from "./template";

/**
 * Test runners. Two interchangeable backends:
 * - local: child processes in a temp dir (running `npm run dev` on a Mac)
 * - sandbox: Vercel Sandbox microVMs (hosted VoiceForge on Vercel)
 * Safety in both comes from the template constraints: agents cannot change
 * package.json or configs, and installs run with scripts disabled.
 */

export type StepName =
  | "install"
  | "typecheck"
  | "lint"
  | "test"
  | "build"
  | "e2e";

export type StepResult = {
  step: StepName;
  ok: boolean;
  output: string; // tail of combined stdout+stderr
  durationMs: number;
};

export type Runner = {
  kind: "local" | "sandbox";
  writeFiles(files: FileMap): Promise<void>;
  run(step: StepName): Promise<StepResult>;
  dispose(): Promise<void>;
};

const OUTPUT_TAIL = 8000;

const STEPS: Record<
  StepName,
  { cmd: string; args: string[]; timeoutMs: number }
> = {
  install: {
    cmd: "npm",
    args: ["install", "--no-audit", "--no-fund", "--ignore-scripts"],
    timeoutMs: 5 * 60_000,
  },
  typecheck: { cmd: "npm", args: ["run", "typecheck"], timeoutMs: 3 * 60_000 },
  lint: { cmd: "npm", args: ["run", "lint"], timeoutMs: 3 * 60_000 },
  test: { cmd: "npm", args: ["run", "test"], timeoutMs: 5 * 60_000 },
  build: { cmd: "npm", args: ["run", "build"], timeoutMs: 8 * 60_000 },
  // Installs Chromium on first run (cached in ~/Library/Caches thereafter),
  // starts the production build on port 4321, runs browser + axe checks.
  e2e: { cmd: "npm", args: ["run", "test:e2e"], timeoutMs: 10 * 60_000 },
};

export async function createRunner(buildRunId: string): Promise<Runner> {
  if (process.env.VERCEL) {
    return createSandboxRunner();
  }
  return createLocalRunner(buildRunId);
}

// ---------------------------------------------------------------------------
// Local backend
// ---------------------------------------------------------------------------

async function createLocalRunner(buildRunId: string): Promise<Runner> {
  const base =
    process.env.BUILD_WORKSPACE_DIR ??
    path.join(os.tmpdir(), "voiceforge-v2-builds");
  const dir = path.join(base, buildRunId);

  return {
    kind: "local",
    async writeFiles(files: FileMap) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
      }
    },
    run(step: StepName): Promise<StepResult> {
      const { cmd, args, timeoutMs } = STEPS[step];
      const started = Date.now();

      return new Promise((resolve) => {
        const child = spawn(cmd, args, {
          cwd: dir,
          // Deliberately no NODE_ENV: "development" breaks `next build`
          // with a misleading prerender/<Html> error.
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CI: "true",
            NEXT_TELEMETRY_DISABLED: "1",
          } as unknown as NodeJS.ProcessEnv,
          shell: false,
        });

        let output = "";
        const append = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-OUTPUT_TAIL * 2);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          output += `\n[voiceforge-v2] step "${step}" timed out after ${timeoutMs / 1000}s`;
        }, timeoutMs);

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            step,
            ok: code === 0,
            output: output.slice(-OUTPUT_TAIL),
            durationMs: Date.now() - started,
          });
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({
            step,
            ok: false,
            output: `Failed to start ${cmd}: ${err.message}`,
            durationMs: Date.now() - started,
          });
        });
      });
    },
    async dispose() {
      // Leave the workspace on disk for debugging; OS tmp cleanup handles it.
    },
  };
}

// ---------------------------------------------------------------------------
// Vercel Sandbox backend
// ---------------------------------------------------------------------------

async function createSandboxRunner(): Promise<Runner> {
  // Dynamic import keeps @vercel/sandbox out of local dev bundles.
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.create({
    runtime: "node24",
    timeout: 25 * 60_000, // hard ceiling for the whole build
  });

  return {
    kind: "sandbox",
    async writeFiles(files: FileMap) {
      // Ensure directories exist first.
      const dirs = new Set<string>();
      for (const rel of Object.keys(files)) {
        const dir = path.posix.dirname(rel);
        if (dir && dir !== ".") dirs.add(dir);
      }
      if (dirs.size > 0) {
        await sandbox.runCommand("mkdir", ["-p", ...dirs]);
      }
      await sandbox.writeFiles(
        Object.entries(files).map(([p, content]) => ({
          path: p,
          content: Buffer.from(content, "utf8"),
        })),
      );
    },
    async run(step: StepName): Promise<StepResult> {
      const { cmd, args } = STEPS[step];
      const started = Date.now();
      try {
        const result = await sandbox.runCommand(cmd, [...args]);
        const output = `${await result.stdout()}\n${await result.stderr()}`;
        return {
          step,
          ok: result.exitCode === 0,
          output: output.slice(-OUTPUT_TAIL),
          durationMs: Date.now() - started,
        };
      } catch (err) {
        return {
          step,
          ok: false,
          output: `Sandbox command failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - started,
        };
      }
    },
    async dispose() {
      await sandbox.stop().catch(() => {});
    },
  };
}
