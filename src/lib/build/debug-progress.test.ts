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

  it("distinguishes Playwright failures in the same test by their locator", () => {
    const before = createFailureFingerprint(
      "e2e",
      [
        "1) e2e/generated/lending.spec.ts:20:3 › lending journey",
        "Error: expect(locator).toBeVisible() failed",
        "Locator: getByRole('option', { name: 'Family member' })",
      ].join("\n"),
    );
    const changed = createFailureFingerprint(
      "e2e",
      [
        "1) e2e/generated/lending.spec.ts:20:3 › lending journey",
        "Error: expect(locator).toBeVisible() failed",
        "Locator: getByRole('cell', { name: 'Equipment' })",
      ].join("\n"),
    );

    expect(before.cases[0].signature).toContain("getByRole('option'");
    expect(compareFailureFingerprints(before, changed).status).toBe("changed");
  });

  it("distinguishes timed-out Playwright actions by the locator being awaited", () => {
    const before = createFailureFingerprint(
      "e2e",
      [
        "1) e2e/generated/lending.spec.ts:20:3 › lending journey",
        "Error: locator.click: Test timeout of 120000ms exceeded.",
        "Call log:",
        "  - waiting for getByRole('button', { name: 'Add equipment' })",
      ].join("\n"),
    );
    const changed = createFailureFingerprint(
      "e2e",
      [
        "1) e2e/generated/lending.spec.ts:20:3 › lending journey",
        "Error: locator.click: Test timeout of 120000ms exceeded.",
        "Call log:",
        "  - waiting for getByRole('button', { name: 'Lend equipment' })",
      ].join("\n"),
    );

    expect(before.cases[0].signature).toContain("Add equipment");
    expect(compareFailureFingerprints(before, changed).status).toBe("changed");
  });

  it("tracks progress within one generated journey instead of treating its next step as a regression", () => {
    const before = createFailureFingerprint(
      "e2e",
      [
        "1) e2e/generated/lending.spec.ts:20:3 › lending suite › [voiceforge-journey:lending] Lend equipment",
        "Error: expect(locator).toBeVisible() failed",
        "Locator: getByRole('option', { name: 'Borrower' })",
      ].join("\n"),
    );
    const advanced = createFailureFingerprint(
      "e2e",
      [
        "1) e2e/generated/lending.spec.ts:20:3 › lending suite › [voiceforge-journey:lending] Lend equipment › [voiceforge-save:equipment] persists after reload",
        "Error: expect(locator).toBeVisible() failed",
        "Locator: getByRole('cell', { name: 'Equipment' })",
      ].join("\n"),
    );

    expect(advanced.failedTests).toEqual(before.failedTests);
    expect(compareFailureFingerprints(before, advanced).status).toBe("changed");
  });

  it("ignores dynamic acceptance-run suffixes when the actual failure is unchanged", () => {
    const before = createFailureFingerprint(
      "e2e",
      [
        "1) e2e/generated/lending.spec.ts:20:3 › lending journey",
        "Error: expect(locator).toBeVisible() failed",
        "Locator: getByRole('cell', { name: 'Equipment 12345-m1abcde' })",
      ].join("\n"),
    );
    const unchanged = createFailureFingerprint(
      "e2e",
      [
        "1) e2e/generated/lending.spec.ts:20:3 › lending journey",
        "Error: expect(locator).toBeVisible() failed",
        "Locator: getByRole('cell', { name: 'Equipment 98765-m9vwxyz' })",
      ].join("\n"),
    );

    expect(compareFailureFingerprints(before, unchanged).status).toBe(
      "unchanged",
    );
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
