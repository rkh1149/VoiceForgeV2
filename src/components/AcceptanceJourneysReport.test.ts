import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AcceptanceJourneysReport", () => {
  it("shows planned, generated, verified, and executed journey readiness", () => {
    const source = readFileSync(
      new URL("./AcceptanceJourneysReport.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Acceptance journeys");
    expect(source).toContain(
      "Can a person complete the promised workflows from start to finish?",
    );
    expect(source).toContain("journeysPlanned");
    expect(source).toContain("journeysGenerated");
    expect(source).toContain("journeysVerified");
    expect(source).toContain("Browser passed");
    expect(source).toContain("stepsVerified");
    expect(source).toContain("savesVerified");
    expect(source).toContain("handoffsVerified");
    expect(source).toContain("roleScenariosVerified");
    expect(source).toContain("Needs repair");
  });
});
