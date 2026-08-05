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
});
