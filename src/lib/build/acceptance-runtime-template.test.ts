import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Stage 14H locked acceptance runtime", () => {
  it("provides deterministic primitives and a typed adapter boundary", () => {
    const source = readFileSync(
      new URL(
        "../../../templates/nextjs-base/e2e/voiceforge-acceptance.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("VoiceForgeAcceptanceAdapters");
    expect(source).toContain("resolveAcceptanceControl");
    expect(source).toContain("selectAcceptanceOption");
    expect(source).toContain("completeAcceptanceForm");
    expect(source).toContain("runAcceptanceAdapter");
    expect(source).toContain("dragAcceptanceControl");
    expect(source).toContain("new DataTransfer()");
  });
});
