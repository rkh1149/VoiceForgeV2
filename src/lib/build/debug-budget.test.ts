import { describe, expect, it } from "vitest";
import {
  DebugBudgetExceededError,
  createDebugBudget,
  hydrateDebugBudget,
  recordDebugAttempt,
  reserveDebugRound,
  serializeDebugBudget,
} from "./debug-budget";

describe("build debug budget", () => {
  it("tracks debug rounds per step so build is not starved by test fixes", () => {
    const budget = createDebugBudget({ maxRoundsPerStep: 5, maxTotalRounds: 12 });

    for (let i = 0; i < 5; i += 1) {
      const round = reserveDebugRound(budget, "test");
      recordDebugAttempt(budget, "test", `test fix ${round.stepRound}`);
    }

    expect(() => reserveDebugRound(budget, "build")).not.toThrow();
    expect(reserveDebugRound(budget, "build")).toMatchObject({
      stepRound: 2,
      previousAttempts: [],
    });
  });

  it("stops a single step after its own limit", () => {
    const budget = createDebugBudget({ maxRoundsPerStep: 1, maxTotalRounds: 12 });

    reserveDebugRound(budget, "test");

    expect(() => reserveDebugRound(budget, "test")).toThrow(
      DebugBudgetExceededError,
    );
  });

  it("serializes and hydrates previous attempts for resumed builds", () => {
    const budget = createDebugBudget({ maxRoundsPerStep: 5, maxTotalRounds: 12 });
    reserveDebugRound(budget, "typecheck");
    recordDebugAttempt(budget, "typecheck", "fixed nullable route params");

    const restored = hydrateDebugBudget(serializeDebugBudget(budget), {
      maxRoundsPerStep: 5,
      maxTotalRounds: 12,
    });
    const next = reserveDebugRound(restored, "typecheck");

    expect(next).toEqual({
      stepRound: 2,
      previousAttempts: ["fixed nullable route params"],
    });
    expect(restored.totalRounds).toBe(2);
  });
});
