import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { Writable } from "stream";
import {
  createFailureFingerprint,
  type FailureFingerprint,
} from "./debug-progress";
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
  failureFingerprint?: FailureFingerprint;
};

export type StepProgress = {
  step: StepName;
  elapsedMs: number;
  message: string;
};

export type RunStepOptions = {
  onProgress?: (progress: StepProgress) => void | Promise<void>;
};

export type FocusedRun =
  | { kind: "unit"; testFiles: string[] }
  | { kind: "e2e"; grep: string };

export function focusedRunCommand(focus: FocusedRun): {
  step: StepName;
  cmd: string;
  args: string[];
} {
  return focus.kind === "unit"
    ? {
        step: "test",
        cmd: "npx",
        args: ["vitest", "run", ...focus.testFiles],
      }
    : {
        step: "e2e",
        cmd: "npx",
        args: ["playwright", "test", "--grep", focus.grep],
      };
}

export type Runner = {
  kind: "local" | "sandbox";
  writeFiles(files: FileMap): Promise<void>;
  deleteFiles(paths: string[]): Promise<void>;
  run(step: StepName, options?: RunStepOptions): Promise<StepResult>;
  runFocused(
    focus: FocusedRun,
    options?: RunStepOptions,
  ): Promise<StepResult>;
  dispose(): Promise<void>;
};

type RunnerOptions = {
  env?: Record<string, string>;
};

const OUTPUT_TAIL = 8000;
const DIAGNOSTIC_CAPTURE_LIMIT = 1024 * 1024;
export const E2E_PROGRESS_HEARTBEAT_MS = 15_000;
const E2E_PROGRESS_PREFIX = "[voiceforge-e2e]";

type StepProgressTracker = {
  observe(chunk: string): void;
  note(message: string): void;
  stop(): Promise<void>;
};

function createStepProgressTracker(input: {
  step: StepName;
  startedAt: number;
  onProgress?: RunStepOptions["onProgress"];
}): StepProgressTracker {
  let partialLine = "";
  let latestActivity = "Browser tests are active.";
  let pending = Promise.resolve();
  const emit = (message: string) => {
    if (!input.onProgress) return;
    const progress: StepProgress = {
      step: input.step,
      elapsedMs: Date.now() - input.startedAt,
      message,
    };
    pending = pending
      .then(() => input.onProgress?.(progress))
      .then(() => undefined)
      .catch(() => undefined);
  };
  const processLine = (line: string) => {
    const marker = line.indexOf(E2E_PROGRESS_PREFIX);
    if (marker < 0) return;
    latestActivity = line.slice(marker + E2E_PROGRESS_PREFIX.length).trim();
    if (latestActivity) emit(`E2E progress: ${latestActivity}`);
  };
  const heartbeat =
    input.step === "e2e" && input.onProgress
      ? setInterval(() => {
          const seconds = Math.max(
            1,
            Math.round((Date.now() - input.startedAt) / 1_000),
          );
          emit(`E2E still running (${seconds}s): ${latestActivity}`);
        }, E2E_PROGRESS_HEARTBEAT_MS)
      : null;
  heartbeat?.unref();

  return {
    observe(chunk: string) {
      if (input.step !== "e2e") return;
      const lines = `${partialLine}${chunk}`.split(/\r?\n/);
      partialLine = lines.pop() ?? "";
      lines.forEach(processLine);
    },
    note(message: string) {
      latestActivity = message;
      emit(`E2E progress: ${message}`);
    },
    async stop() {
      if (heartbeat) clearInterval(heartbeat);
      if (partialLine) processLine(partialLine);
      await pending;
    },
  };
}

export const SANDBOX_BROWSER_PACKAGES = [
  "alsa-lib",
  "atk",
  "at-spi2-atk",
  "at-spi2-core",
  "cups-libs",
  "libdrm",
  "libX11",
  "libXcomposite",
  "libXdamage",
  "libXext",
  "libXfixes",
  "libXrandr",
  "libxcb",
  "libxkbcommon",
  "mesa-libgbm",
  "nspr",
  "nss",
  "pango",
  "cairo",
  "gtk3",
] as const;

export function sandboxBrowserSetupPlan(): Array<{
  label: string;
  cmd: string;
  args: string[];
}> {
  return [
    {
      label: "Linux browser libraries",
      cmd: "sudo",
      args: ["dnf", "install", "-y", ...SANDBOX_BROWSER_PACKAGES],
    },
    {
      label: "Chromium",
      cmd: "npx",
      args: ["playwright", "install", "chromium"],
    },
  ];
}

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
  e2e: { cmd: "npm", args: ["run", "test:e2e"], timeoutMs: 18 * 60_000 },
};

export async function createRunner(
  buildRunId: string,
  options: RunnerOptions = {},
): Promise<Runner> {
  if (process.env.VERCEL) {
    return createSandboxRunner(options);
  }
  return createLocalRunner(buildRunId, options);
}

// ---------------------------------------------------------------------------
// Local backend
// ---------------------------------------------------------------------------

async function createLocalRunner(
  buildRunId: string,
  options: RunnerOptions,
): Promise<Runner> {
  const base =
    process.env.BUILD_WORKSPACE_DIR ??
    path.join(os.tmpdir(), "voiceforge-v2-builds");
  const dir = path.join(base, buildRunId);

  const runCommand = (
    step: StepName,
    cmd: string,
    args: string[],
    timeoutMs: number,
    runOptions: RunStepOptions = {},
  ): Promise<StepResult> => {
    const started = Date.now();
    const progress = createStepProgressTracker({
      step,
      startedAt: started,
      onProgress: runOptions.onProgress,
    });
    if (step === "e2e") progress.note("Preparing the browser test runtime.");

    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CI: "true",
          NEXT_TELEMETRY_DISABLED: "1",
          VOICEFORGE_DATA_LOCAL_FALLBACK: "1",
          ...options.env,
        } as unknown as NodeJS.ProcessEnv,
        shell: false,
      });

      let output = "";
      const append = (chunk: Buffer) => {
        const text = chunk.toString();
        output = (output + text).slice(-DIAGNOSTIC_CAPTURE_LIMIT);
        progress.observe(text);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        output += `\n[voiceforge-v2] step "${step}" timed out after ${timeoutMs / 1000}s`;
      }, timeoutMs);

      child.on("close", async (code) => {
        clearTimeout(timer);
        await progress.stop();
        const ok = code === 0;
        resolve({
          step,
          ok,
          output: output.slice(-OUTPUT_TAIL),
          durationMs: Date.now() - started,
          failureFingerprint: ok
            ? undefined
            : createFailureFingerprint(step, output),
        });
      });
      child.on("error", async (err) => {
        clearTimeout(timer);
        await progress.stop();
        const output = `Failed to start ${cmd}: ${err.message}`;
        resolve({
          step,
          ok: false,
          output,
          durationMs: Date.now() - started,
          failureFingerprint: createFailureFingerprint(step, output),
        });
      });
    });
  };

  return {
    kind: "local",
    async writeFiles(files: FileMap) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
      }
    },
    async deleteFiles(paths: string[]) {
      for (const rel of paths) {
        await fs.rm(path.join(dir, rel), { force: true });
      }
    },
    run(step: StepName, runOptions: RunStepOptions = {}): Promise<StepResult> {
      const { cmd, args, timeoutMs } = STEPS[step];
      return runCommand(step, cmd, args, timeoutMs, runOptions);
    },
    async runFocused(
      focus: FocusedRun,
      runOptions: RunStepOptions = {},
    ): Promise<StepResult> {
      if (focus.kind === "unit") {
        const command = focusedRunCommand(focus);
        return runCommand(
          command.step,
          command.cmd,
          command.args,
          STEPS.test.timeoutMs,
          runOptions,
        );
      }
      const browserInstall = await runCommand(
        "e2e",
        "npx",
        ["playwright", "install", "chromium"],
        5 * 60_000,
      );
      if (!browserInstall.ok) return browserInstall;
      const command = focusedRunCommand(focus);
      return runCommand(
        command.step,
        command.cmd,
        command.args,
        STEPS.e2e.timeoutMs,
        runOptions,
      );
    },
    async dispose() {
      // Leave the workspace on disk for debugging; OS tmp cleanup handles it.
    },
  };
}

// ---------------------------------------------------------------------------
// Vercel Sandbox backend
// ---------------------------------------------------------------------------

async function createSandboxRunner(options: RunnerOptions): Promise<Runner> {
  // Dynamic import keeps @vercel/sandbox out of local dev bundles.
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.create({
    runtime: "node24",
    timeout: 25 * 60_000, // hard ceiling for the whole build
  });
  let browserReady = false;

  const prepareBrowser = async (): Promise<{
    ok: boolean;
    output: string;
  }> => {
    if (browserReady) {
      return { ok: true, output: "Hosted browser runtime already prepared." };
    }

    const completed: string[] = [];
    for (const command of sandboxBrowserSetupPlan()) {
      let failureOutput = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await sandbox.runCommand(command.cmd, command.args);
        const stdout = await result.stdout();
        const stderr = await result.stderr();
        if (result.exitCode === 0) {
          failureOutput = "";
          break;
        }
        failureOutput = [
          `Hosted browser setup failed while installing ${command.label} (attempt ${attempt}/2).`,
          stdout,
          stderr,
        ]
          .join("\n")
          .slice(-DIAGNOSTIC_CAPTURE_LIMIT);
      }
      if (failureOutput) {
        return { ok: false, output: failureOutput };
      }
      completed.push(command.label);
    }

    browserReady = true;
    return {
      ok: true,
      output: `Hosted browser runtime prepared: ${completed.join(", ")}.`,
    };
  };

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
    async deleteFiles(paths: string[]) {
      if (paths.length > 0) {
        await sandbox.runCommand("rm", ["-f", ...paths]);
      }
    },
    async run(
      step: StepName,
      runOptions: RunStepOptions = {},
    ): Promise<StepResult> {
      const { cmd, args, timeoutMs } = STEPS[step];
      const started = Date.now();
      const progress = createStepProgressTracker({
        step,
        startedAt: started,
        onProgress: runOptions.onProgress,
      });
      if (step === "e2e") {
        progress.note("Preparing the hosted browser test runtime.");
      }
      try {
        const browserSetup =
          step === "e2e"
            ? await prepareBrowser()
            : { ok: true, output: "" };
        if (!browserSetup.ok) {
          await progress.stop();
          return {
            step,
            ok: false,
            output: browserSetup.output.slice(-OUTPUT_TAIL),
            durationMs: Date.now() - started,
            failureFingerprint: createFailureFingerprint(
              step,
              browserSetup.output,
            ),
          };
        }

        if (step === "e2e") {
          progress.note("Browser runtime is ready; starting Playwright.");
        }

        let streamedOutput = "";
        const appendOutput = (chunk: Buffer | string) => {
          const text = chunk.toString();
          streamedOutput = (streamedOutput + text).slice(
            -DIAGNOSTIC_CAPTURE_LIMIT,
          );
          progress.observe(text);
        };
        const outputStream = () =>
          new Writable({
            write(chunk, _encoding, callback) {
              appendOutput(chunk as Buffer);
              callback();
            },
          });
        const result = await sandbox.runCommand({
          cmd: "env",
          args: [
            "CI=true",
            "NEXT_TELEMETRY_DISABLED=1",
            "VOICEFORGE_DATA_LOCAL_FALLBACK=1",
            ...Object.entries(options.env ?? {}).map(
              ([key, value]) => `${key}=${value}`,
            ),
            cmd,
            ...args,
          ],
          stdout: outputStream(),
          stderr: outputStream(),
          timeoutMs,
        });
        if (!streamedOutput) {
          streamedOutput = [await result.stdout(), await result.stderr()]
            .filter(Boolean)
            .join("\n");
          progress.observe(streamedOutput);
        }
        await progress.stop();
        const output = [browserSetup.output, streamedOutput]
          .filter(Boolean)
          .join("\n");
        const ok = result.exitCode === 0;
        return {
          step,
          ok,
          output: output.slice(-OUTPUT_TAIL),
          durationMs: Date.now() - started,
          failureFingerprint: ok
            ? undefined
            : createFailureFingerprint(step, output),
        };
      } catch (err) {
        await progress.stop();
        const output = `Sandbox command failed: ${err instanceof Error ? err.message : String(err)}`;
        return {
          step,
          ok: false,
          output,
          durationMs: Date.now() - started,
          failureFingerprint: createFailureFingerprint(step, output),
        };
      }
    },
    async runFocused(
      focus: FocusedRun,
      runOptions: RunStepOptions = {},
    ): Promise<StepResult> {
      const { step, cmd, args } = focusedRunCommand(focus);
      const timeoutMs = STEPS[step].timeoutMs;
      const started = Date.now();
      const progress = createStepProgressTracker({
        step,
        startedAt: started,
        onProgress: runOptions.onProgress,
      });
      if (step === "e2e") {
        progress.note("Preparing the hosted browser test runtime.");
      }
      try {
        const browserSetup =
          step === "e2e"
            ? await prepareBrowser()
            : { ok: true, output: "" };
        if (!browserSetup.ok) {
          await progress.stop();
          return {
            step,
            ok: false,
            output: browserSetup.output.slice(-OUTPUT_TAIL),
            durationMs: Date.now() - started,
            failureFingerprint: createFailureFingerprint(
              step,
              browserSetup.output,
            ),
          };
        }
        let streamedOutput = "";
        const outputStream = () =>
          new Writable({
            write(chunk, _encoding, callback) {
              const text = chunk.toString();
              streamedOutput = (streamedOutput + text).slice(
                -DIAGNOSTIC_CAPTURE_LIMIT,
              );
              progress.observe(text);
              callback();
            },
          });
        const result = await sandbox.runCommand({
          cmd: "env",
          args: [
            "CI=true",
            "NEXT_TELEMETRY_DISABLED=1",
            "VOICEFORGE_DATA_LOCAL_FALLBACK=1",
            ...Object.entries(options.env ?? {}).map(
              ([key, value]) => `${key}=${value}`,
            ),
            cmd,
            ...args,
          ],
          stdout: outputStream(),
          stderr: outputStream(),
          timeoutMs,
        });
        if (!streamedOutput) {
          streamedOutput = [await result.stdout(), await result.stderr()]
            .filter(Boolean)
            .join("\n");
          progress.observe(streamedOutput);
        }
        await progress.stop();
        const output = [browserSetup.output, streamedOutput]
          .filter(Boolean)
          .join("\n");
        const ok = result.exitCode === 0;
        return {
          step,
          ok,
          output: output.slice(-OUTPUT_TAIL),
          durationMs: Date.now() - started,
          failureFingerprint: ok
            ? undefined
            : createFailureFingerprint(step, output),
        };
      } catch (error) {
        await progress.stop();
        const output = `Sandbox command failed: ${error instanceof Error ? error.message : String(error)}`;
        return {
          step,
          ok: false,
          output,
          durationMs: Date.now() - started,
          failureFingerprint: createFailureFingerprint(step, output),
        };
      }
    },
    async dispose() {
      await sandbox.stop().catch(() => {});
    },
  };
}
