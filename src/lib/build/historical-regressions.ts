import type { GoldenCapabilityId } from "./capability-catalog";

export type HistoricalRegressionGate =
  | "architecture"
  | "implementation"
  | "interface"
  | "persistence"
  | "acceptance"
  | "dependency"
  | "browser"
  | "checkpoint";

export type HistoricalRegression = {
  id: string;
  symptom: string;
  rootCause: string;
  capability: GoldenCapabilityId;
  expectedGate: HistoricalRegressionGate;
  expectedRepairSurface: "application_source" | "generated_test" | "pipeline" | "external_environment";
  sampleFailure: string;
  match: RegExp;
  testReference: string;
};

export const HISTORICAL_REGRESSIONS: HistoricalRegression[] = [
  regression("VFREG-001", "Ambiguous locators", "Generated controls shared labels without stable identity.", "authentication_roles", "acceptance", "generated_test", "strict mode violation: locator resolved to 2 elements", /strict mode violation|resolved to \d+ elements/i, "src/lib/build/workflow-repair.test.ts"),
  regression("VFREG-002", "Invented accessibility roles", "Tests queried ARIA roles that the UI did not render.", "authentication_roles", "browser", "generated_test", "getByRole('region') could not find role region", /getbyrole.*could not find|unknown aria role/i, "src/lib/build/acceptance-test-review.test.ts"),
  regression("VFREG-003", "Cross-test browser state", "A journey relied on localStorage created by another test.", "browser_persistence", "acceptance", "generated_test", "fresh browser context and localStorage was empty", /fresh browser context|localstorage was empty|cross-test state/i, "src/lib/build/fixture-isolation-review.test.ts"),
  regression("VFREG-004", "Navigation or reload race", "A test blamed navigation before proving the save action succeeded.", "workflow_handoff", "browser", "application_source", "page.waitForURL timed out after Save route", /waitforurl|tohaveurl|navigation timeout/i, "src/lib/build/browser-failure-evidence.test.ts"),
  regression("VFREG-005", "Hidden select option", "A dependent workflow did not create or reload its prerequisite option.", "related_records", "acceptance", "generated_test", "selectOption failed because option was not found", /selectoption.*option.*not found|no options? found/i, "src/lib/build/workflow-repair.test.ts"),
  regression("VFREG-006", "Duplicate form labels", "Visually hidden duplicate labels made accessible names ambiguous.", "authentication_roles", "interface", "application_source", "getByLabelText found multiple elements", /getbylabeltext.*multiple|duplicate label/i, "src/lib/build/ui-affordance-review.test.ts"),
  regression("VFREG-007", "Broken drag/drop test", "The DataTransfer mock stored only one value instead of MIME-keyed values.", "drag_drop", "acceptance", "generated_test", "DataTransfer getData application/json returned text/plain", /datatransfer.*(?:mime|application\/json|text\/plain)/i, "src/lib/build/post-generation-reviews.test.ts"),
  regression("VFREG-008", "Damaged PDF", "Plain text bytes were mislabeled as application/pdf.", "pdf_csv_exports", "dependency", "application_source", "fake PDF by labeling non-PDF bytes as application/pdf", /fake pdf|non-pdf bytes|damaged pdf/i, "src/lib/build/golden-regressions.test.ts"),
  regression("VFREG-009", "Wrong platform keys", "Display labels or aliases were sent instead of exact schema keys.", "platform_data", "persistence", "application_source", "Record data failed validation: unknown field recipeTitle", /record data failed validation|unknown field|exact field key/i, "src/lib/build/golden-regressions.test.ts"),
  regression("VFREG-010", "Raw image in record", "Base64 image bytes exceeded the JSONB record limit.", "files_images", "implementation", "application_source", "raw image data into platform-data records", /raw (?:image|file).*platform-data|64 kb platform-record|base64.*record/i, "src/lib/build/post-generation-reviews.test.ts"),
  regression("VFREG-011", "Missing sign-in action", "The generated app described authentication without a usable locked sign-in control.", "authentication_roles", "interface", "application_source", "did not provide a usable locked platform sign-in action", /usable locked platform sign-in|missing sign-in/i, "src/lib/build/golden-regressions.test.ts"),
  regression("VFREG-012", "Broken workflow handoff", "A producer result was never durably loaded by the consumer.", "workflow_handoff", "persistence", "application_source", "persistence_handoff:handoff consumer does not load saved route", /persistence_handoff:handoff|producer.*consumer|consumer.*load/i, "src/lib/build/workflow-repair.test.ts"),
  regression("VFREG-013", "AI value type mismatch", "Untrusted structured AI values reached string-only form code.", "ai_text_image", "implementation", "application_source", "quantity.trim is not a function", /\.trim is not a function|structured ai output without.*validation/i, "templates/nextjs-base/src/lib/voiceforge-ai.test.ts"),
  regression("VFREG-014", "Dependency manifest drift", "Generated source imported a package absent from the locked catalogue.", "ai_text_image", "dependency", "pipeline", "package.json dependency utif is missing", /dependency.*(?:missing|not approved)|unapproved package/i, "src/lib/build/dependencies.test.ts"),
  regression("VFREG-015", "Checkpoint rejected after deployment", "Compatibility was tied to an exact deployment commit.", "workflow_handoff", "checkpoint", "pipeline", "checkpoint was created by an older VoiceForge pipeline", /checkpoint.*older voiceforge pipeline|deployment revision changed/i, "src/lib/build/checkpoints.test.ts"),
  regression("VFREG-016", "Save relation id collision", "A validation error variable replaced the selected related-record id.", "related_records", "persistence", "application_source", "valid saved relation id was rejected", /valid saved relation|field-value\/error-variable collision|unknown relation id/i, "src/lib/build/post-generation-reviews.test.ts"),
  regression("VFREG-017", "CSV export page limit mismatch", "The export service requested more records than the search query schema allowed.", "pdf_csv_exports", "browser", "pipeline", "CSV export failed: expected limit to be less than or equal to 500", /csv export.*limit|limit.*less than or equal to 500|too_big.*limit/i, "src/lib/build/stage15-database-golden.test.ts"),
  regression("VFREG-018", "Filter action misclassified as text input", "The workflow compiler treated a finite filter choice and its automatic display result as textboxes.", "search_filter_sort", "interface", "pipeline", "Workflow Filter items expected visible textbox Choose a filter and Display only items matching that filter", /filter items.*textbox.*choose a filter|display only items matching.*textbox/i, "src/lib/workflow-contract.test.ts"),
  regression("VFREG-019", "Playwright-only option used in unit test", "Generated React Testing Library code passed exact: true to getByRole even though ByRoleOptions does not support it.", "browser_persistence", "acceptance", "generated_test", "tests_review: quick-list-view.test.tsx getByRole exact: true is not supported by ByRoleOptions", /tests_review:.*(?:getbyrole.*exact|byroleoptions)/i, "src/lib/build/post-generation-reviews.test.ts"),
  regression("VFREG-020", "Valid workflow repair blamed for unrelated failure", "Focused validation rolled back an interface improvement because an unchanged test file already failed typecheck.", "workflow_handoff", "checkpoint", "pipeline", "focused workflow typecheck found a failure outside the repair's changed files", /focused workflow typecheck.*outside the repair's changed files/i, "src/lib/build/pipeline-status.test.ts"),
];

export function identifyHistoricalRegressions(text: string): string[] {
  return HISTORICAL_REGRESSIONS.filter((item) => item.match.test(text)).map(
    (item) => item.id,
  );
}

export function validateHistoricalRegressionRegistry(): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const item of HISTORICAL_REGRESSIONS) {
    if (ids.has(item.id)) issues.push(`Duplicate regression id ${item.id}.`);
    ids.add(item.id);
    if (!item.match.test(item.sampleFailure)) {
      issues.push(`${item.id} does not match its minimal reproduction.`);
    }
    if (!item.testReference) issues.push(`${item.id} has no regression test reference.`);
  }
  return issues;
}

function regression(
  id: string,
  symptom: string,
  rootCause: string,
  capability: GoldenCapabilityId,
  expectedGate: HistoricalRegressionGate,
  expectedRepairSurface: HistoricalRegression["expectedRepairSurface"],
  sampleFailure: string,
  match: RegExp,
  testReference: string,
): HistoricalRegression {
  return { id, symptom, rootCause, capability, expectedGate, expectedRepairSurface, sampleFailure, match, testReference };
}
