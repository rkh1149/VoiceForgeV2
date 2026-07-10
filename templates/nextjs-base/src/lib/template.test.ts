// Baseline test: guarantees the test suite always has at least one test.
// The Code Agent adds real tests for app features alongside this file.
import { describe, it, expect } from "vitest";

describe("template baseline", () => {
  it("runs the test environment", () => {
    expect(1 + 1).toBe(2);
  });
});
