import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("build pipeline app status fallbacks", () => {
  it("keeps existing previews testable when a later build fails", () => {
    const source = readFileSync(
      new URL("./pipeline.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("function appStatusAfterBuildFailure");
    expect(source).toContain('if (app.previewUrl) return "testing";');
    expect(source).toContain("status: appStatusAfterBuildFailure");
    expect(source).toContain("function appStatusAfterNeedsInput");
  });
});
