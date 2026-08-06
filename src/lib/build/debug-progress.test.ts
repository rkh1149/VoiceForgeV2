import { describe, expect, it } from "vitest";
import {
  compareFailureFingerprints,
  createFailureFingerprint,
  restoreFileMap,
  shouldEscalateDebugScope,
} from "./debug-progress";

describe("debug progress", () => {
  it("extracts named Vitest failures and their error signatures", () => {
    const fingerprint = createFailureFingerprint(
      "test",
      [
        "FAIL  src/components/meal-planner.test.tsx > MealPlanner > saves a valid recipe",
        "AssertionError: expected spy to be called once, but got 0 times",
        "FAIL  src/lib/meal-planner.test.ts > validatePlannedMealDraft > rejects an unknown recipe",
        "AssertionError: expected undefined to be 'Choose an existing saved recipe.'",
      ].join("\n"),
    );

    expect(fingerprint.failedTests).toEqual([
      "src/components/meal-planner.test.tsx > MealPlanner > saves a valid recipe",
      "src/lib/meal-planner.test.ts > validatePlannedMealDraft > rejects an unknown recipe",
    ]);
    expect(fingerprint.cases[0].signature).toContain("expected spy");
  });

  it("marks fewer failures as improvement and new failures as regression", () => {
    const before = createFailureFingerprint(
      "test",
      [
        "FAIL src/app.test.tsx > saves a recipe",
        "AssertionError: expected 1",
        "FAIL src/app.test.tsx > refreshes the meal plan",
        "AssertionError: expected Pasta",
      ].join("\n"),
    );
    const improved = createFailureFingerprint(
      "test",
      "FAIL src/app.test.tsx > refreshes the meal plan\nAssertionError: expected Pasta",
    );
    const regressed = createFailureFingerprint(
      "test",
      [
        "FAIL src/app.test.tsx > refreshes the meal plan",
        "AssertionError: expected Pasta",
        "FAIL src/app.test.tsx > accepts a valid recipe",
        "AssertionError: expected save",
      ].join("\n"),
    );

    expect(compareFailureFingerprints(before, improved).status).toBe(
      "improved",
    );
    expect(compareFailureFingerprints(improved, regressed)).toMatchObject({
      status: "regressed",
      newFailures: ["src/app.test.tsx > accepts a valid recipe"],
    });
  });

  it("distinguishes an unchanged failure from a changed error", () => {
    const before = createFailureFingerprint(
      "test",
      "FAIL src/app.test.tsx > saves a recipe\nAssertionError: expected 1",
    );
    const unchanged = createFailureFingerprint(
      "test",
      "FAIL src/app.test.tsx > saves a recipe\nAssertionError: expected 1",
    );
    const changed = createFailureFingerprint(
      "test",
      "FAIL src/app.test.tsx > saves a recipe\nTestingLibraryElementError: unable to find Pasta",
    );

    expect(compareFailureFingerprints(before, unchanged).status).toBe(
      "unchanged",
    );
    expect(compareFailureFingerprints(before, changed).status).toBe("changed");
  });

  it("escalates after two ineffective rounds", () => {
    expect(shouldEscalateDebugScope(1)).toBe(false);
    expect(shouldEscalateDebugScope(2)).toBe(true);
  });

  it("restores a pre-repair file map and reports newly added paths", () => {
    const files = {
      "src/app/page.tsx": "broken",
      "src/lib/new-helper.ts": "new",
    };
    const removed = restoreFileMap(files, {
      "src/app/page.tsx": "working baseline",
    });

    expect(removed).toEqual(["src/lib/new-helper.ts"]);
    expect(files).toEqual({ "src/app/page.tsx": "working baseline" });
  });
});
