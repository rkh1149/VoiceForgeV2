/**
 * LOCKED PLATFORM FILE - managed by VoiceForge.
 * Emits compact progress markers that the build runner streams to the user.
 */
import type {
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

const PREFIX = "[voiceforge-e2e]";

class VoiceForgeProgressReporter implements Reporter {
  onBegin(_config: unknown, suite: Suite): void {
    console.log(`${PREFIX} Preparing ${suite.allTests().length} browser test(s).`);
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    console.log(
      `${PREFIX} Started ${testLabel(test)} (attempt ${result.retry + 1}).`,
    );
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (
      process.env.VOICEFORGE_ACCEPTANCE_RETRY_PROBE === "1" &&
      result.retry === 0 &&
      result.errors.some((error) =>
        error.message?.includes("[voiceforge-retry-probe:"),
      )
    ) {
      console.log(
        `${PREFIX} Retry isolation probe completed for ${testLabel(test)}; Playwright is recreating its fixtures.`,
      );
      return;
    }
    console.log(
      `${PREFIX} ${statusLabel(result.status)} ${testLabel(test)} in ${formatDuration(result.duration)}.`,
    );
  }

  onEnd(result: FullResult): void {
    console.log(`${PREFIX} Browser suite ${statusLabel(result.status)}.`);
  }
}

function testLabel(test: TestCase): string {
  return test.titlePath().filter(Boolean).join(" > ");
}

function statusLabel(status: string): string {
  if (status === "passed") return "Passed";
  if (status === "failed" || status === "timedout") return "Failed";
  if (status === "skipped" || status === "interrupted") return "Stopped";
  return status;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${Math.round(durationMs / 1_000)}s`;
}

export default VoiceForgeProgressReporter;
