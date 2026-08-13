import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("build resume status filter", () => {
  it("only treats actively running or input-waiting builds as resumable", () => {
    const source = readFileSync(
      new URL("./build-resume.ts", import.meta.url),
      "utf8",
    );
    const statusesMatch = source.match(
      /RESUMABLE_RUN_STATUSES\s*=\s*\[([\s\S]*?)\]\s+as const/,
    );

    expect(statusesMatch?.[1]).toContain('"queued"');
    expect(statusesMatch?.[1]).toContain('"generating"');
    expect(statusesMatch?.[1]).toContain('"testing"');
    expect(statusesMatch?.[1]).toContain('"debugging"');
    expect(statusesMatch?.[1]).toContain('"deploying"');
    expect(statusesMatch?.[1]).toContain('"needs_input"');
    expect(statusesMatch?.[1]).not.toContain('"awaiting_user_test"');
    expect(statusesMatch?.[1]).not.toContain('"failed"');
  });

  it("resumes failed review builds from their durable checkpoint", () => {
    const pipeline = readFileSync(
      new URL("./build/pipeline.ts", import.meta.url),
      "utf8",
    );
    const checkpoints = readFileSync(
      new URL("./build/checkpoints.ts", import.meta.url),
      "utf8",
    );
    const rebuildRoute = readFileSync(
      new URL(
        "../app/api/apps/[appId]/rebuild/route.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(checkpoints).toContain('"reviewing"');
    expect(pipeline).toContain("runCheckpointReviewGate");
    expect(pipeline).toContain("best saved source checkpoint");
    expect(pipeline).toContain("refreshResumedTemplateFiles");
    expect(pipeline).toContain("options?.resetDebugBudget");
    expect(pipeline).toContain("recheckTestingCheckpoint");
    expect(pipeline).toContain("includeCompleteness: !recheckTestingCheckpoint");
    expect(pipeline).toContain(
      "latest deterministic workflow and acceptance rules",
    );
    expect(pipeline).toContain("preserved the checkpoint and will retry");
    expect(pipeline).not.toContain("Debug agent could not produce a fix");
    expect(rebuildRoute).toContain("isBuildCheckpointCompatible");
    expect(rebuildRoute).toContain("restartedFromStaleCheckpoint");
    expect(rebuildRoute).toContain("resetDebugBudget");
    expect(rebuildRoute).toContain("resumed: true");
  });
});
