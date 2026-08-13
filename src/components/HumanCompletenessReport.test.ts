import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("HumanCompletenessReport", () => {
  it("shows product promise coverage in plain language", () => {
    const source = readFileSync(
      new URL("./HumanCompletenessReport.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Product completeness");
    expect(source).toContain(
      "Would a non-technical person recognize the app they were promised?",
    );
    expect(source).toContain("promisesReviewed");
    expect(source).toContain("partiallySupported");
    expect(source).toContain("Needs repair");
    expect(source).toContain("Confirm in preview");
  });
});
