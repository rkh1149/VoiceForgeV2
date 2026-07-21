import { describe, expect, it } from "vitest";
import {
  CHANGE_GENERATION_PHASES,
  CODE_GENERATION_PHASES,
  DEEP_DIAGNOSTIC_CHANGE_PHASES,
} from "./code-phases";

describe("code generation specialist phases", () => {
  it("splits new app generation across backend, frontend, test, and integration specialists", () => {
    expect(CODE_GENERATION_PHASES.map((phase) => phase.agentKey)).toEqual([
      "backend_platform_planner",
      "frontend_builder",
      "frontend_builder",
      "test_agent",
      "test_agent",
      "final_integration_agent",
    ]);
    expect(CODE_GENERATION_PHASES.at(-1)).toMatchObject({
      id: "final-integration-review",
      agentKey: "final_integration_agent",
    });
  });

  it("budgets enough foundation turns for advanced platform apps with many entities", () => {
    const foundation = CODE_GENERATION_PHASES.find(
      (phase) => phase.id === "foundation",
    );

    expect(foundation?.maxTurns).toBeGreaterThanOrEqual(30);
    expect(foundation?.objective).toContain("large advanced apps");
  });

  it("keeps change mode diagnostic, implementation, test, and final review phases separate", () => {
    expect(CHANGE_GENERATION_PHASES.map((phase) => phase.agentKey)).toEqual([
      "diagnostic_agent",
      "frontend_builder",
      "test_agent",
      "final_integration_agent",
    ]);
    expect(CHANGE_GENERATION_PHASES[0].allowMutations).toBe(false);
  });

  it("keeps deep diagnostic mapping and tracing read-only before tests and fixes", () => {
    expect(
      DEEP_DIAGNOSTIC_CHANGE_PHASES.slice(0, 3).every(
        (phase) =>
          phase.agentKey === "diagnostic_agent" && phase.allowMutations === false,
      ),
    ).toBe(true);
    expect(DEEP_DIAGNOSTIC_CHANGE_PHASES.map((phase) => phase.agentKey)).toContain(
      "test_agent",
    );
    expect(DEEP_DIAGNOSTIC_CHANGE_PHASES.at(-1)?.agentKey).toBe(
      "final_integration_agent",
    );
  });
});
