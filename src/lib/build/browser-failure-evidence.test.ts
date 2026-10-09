import { describe, expect, it } from "vitest";
import { collectBrowserFailureEvidence } from "./browser-failure-evidence";

describe("browser failure evidence", () => {
  it("does not blame the test for a save-triggered navigation timeout", () => {
    const evidence = collectBrowserFailureEvidence(`
[voiceforge-e2e] Failed Family Recipe > Save scanned recipe in 30s.
e2e/generated/voiceforge-compiled.spec.ts:91
await page.getByRole('button', { name: 'Save recipe' }).click();
await page.waitForURL('/recipes');
Timeout 30000ms exceeded.
`);
    expect(evidence.likelySurface).toBe("ambiguous");
    expect(evidence.signals).toContain("navigation_or_save_transition");
  });

  it("recognizes explicit application validation and provider failures", () => {
    expect(
      collectBrowserFailureEvidence("Record data failed validation at /api/data").likelySurface,
    ).toBe("application_source");
    expect(
      collectBrowserFailureEvidence("Provider returned HTTP 503").likelySurface,
    ).toBe("external_environment");
  });
});
