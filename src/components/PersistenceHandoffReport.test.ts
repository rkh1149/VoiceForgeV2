import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PersistenceHandoffReport", () => {
  it("keeps durable save, schema, refresh, handoff, and test readiness visible", () => {
    const source = readFileSync(
      new URL("./PersistenceHandoffReport.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Persistence and handoff");
    expect(source).toContain(
      "Do saved results survive refresh and reach the next workflow?",
    );
    expect(source).toContain("savesVerified");
    expect(source).toContain("exactSchemasVerified");
    expect(source).toContain("reloadPathsVerified");
    expect(source).toContain("handoffsVerified");
    expect(source).toContain("persistenceTestsVerified");
    expect(source).toContain("Needs repair");
  });
});
