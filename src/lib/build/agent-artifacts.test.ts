import { describe, expect, it } from "vitest";
import {
  artifactStatusFromIssues,
  summarizeArtifactFiles,
} from "./agent-artifact-utils";

describe("build agent artifacts", () => {
  it("derives artifact status from failures, skips, and warnings", () => {
    expect(artifactStatusFromIssues({ failed: true, warnings: ["unused"] })).toBe(
      "failed",
    );
    expect(artifactStatusFromIssues({ skipped: true })).toBe("skipped");
    expect(artifactStatusFromIssues({ warnings: ["review note"] })).toBe(
      "warning",
    );
    expect(artifactStatusFromIssues({ warnings: [] })).toBe("passed");
  });

  it("summarizes changed and deleted files without dumping file contents", () => {
    expect(
      summarizeArtifactFiles({
        label: "Reusable components",
        filesWritten: ["src/components/Form.tsx", "src/components/List.tsx"],
        filesDeleted: ["src/components/Old.tsx"],
      }),
    ).toBe(
      "Reusable components completed with 2 changed files and 1 deleted file: src/components/Form.tsx, src/components/List.tsx, src/components/Old.tsx",
    );
  });
});
