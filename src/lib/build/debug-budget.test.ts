import { describe, expect, it } from "vitest";
import {
  DebugBudgetExceededError,
  createDebugBudget,
  recordDebugAttempt,
  reserveDebugRound,
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
});
