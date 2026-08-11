import { describe, expect, it } from "vitest";
import { createFallbackArchitecturePlan } from "../architecture";
import { computeSpecComplexity } from "../spec";
import { GOLDEN_REGRESSION_SPECS } from "./golden-regression-specs";
import { analyzeGeneratedAcceptanceTests } from "./acceptance-test-review";
import {
  extractAcceptanceTraceCalls,
  findAcceptanceTraceCall,
} from "./acceptance-trace-parser";
import {
  synthesizeWorkflowAcceptancePlan,
  type WorkflowAcceptanceJourney,
  type WorkflowAcceptanceStep,
} from "./workflow-acceptance-plan";

function sharedApp() {
  const spec = GOLDEN_REGRESSION_SPECS.find(
    (golden) => golden.id === "shared-platform-data",
  )!.spec;
  const architecture = createFallbackArchitecturePlan(
    spec,
    computeSpecComplexity(spec),
  );
  return { spec, architecture };
}

function compliantTest(journey: WorkflowAcceptanceJourney): string {
  const fixture = journey.fixtures.find(
    (candidate) =>
      typeof candidate.value === "string" &&
      !String(candidate.value).startsWith("@"),
  );
  const fixtureValue = String(fixture?.value ?? "VoiceForge acceptance record");
  const stepBlocks = journey.steps
    .map((step) => stepBlock(step, fixtureValue))
    .join("\n");
  const saveBlocks = journey.saves
    .map(
      (save) => `await test.step(workflowSaveTitle(${JSON.stringify(save.id)}), async () => {
  await page.reload();
  await expect(page.getByText(${JSON.stringify(fixtureValue)})).toBeVisible();
});`,
    )
    .join("\n");
  const handoffBlocks = journey.handoffs
    .map(
      (handoff) => `await test.step(workflowHandoffTitle(${JSON.stringify(handoff.id)}), async () => {
  await page.goto(${JSON.stringify(handoff.consumerRoute)});
  await expect(page.getByText(${JSON.stringify(fixtureValue)})).toBeVisible();
});`,
    )
    .join("\n");
  const roleBlocks = journey.roleScenarios
    .flatMap((scenario) =>
      scenario.readOnlyRoles.map(
        (role) => `const ${role}Context = await browser.newContext({ extraHTTPHeaders: voiceForgeRoleHeaders(${JSON.stringify(role)}) });
const ${role}Page = await ${role}Context.newPage();
await ${role}Page.goto(${JSON.stringify(journey.startRoute)});
await expect(${role}Page.getByRole("button", { name: ${JSON.stringify(scenario.visibleControlNames[0] ?? "Save record")} })).not.toBeVisible();
await ${role}Context.close();`,
      ),
    )
    .join("\n");

  return `import { test, expect } from "@playwright/test";
import { workflowJourneyTitle, workflowStepTitle, workflowSaveTitle, workflowHandoffTitle, voiceForgeRoleHeaders } from "../voiceforge-acceptance";
test(workflowJourneyTitle(${JSON.stringify(journey.id)}, ${JSON.stringify(journey.name)}), async ({ page, browser }) => {
  const fixture = ${JSON.stringify(fixtureValue)};
  void fixture;
  await page.goto(${JSON.stringify(journey.startRoute)});
  ${stepBlocks}
  ${saveBlocks}
  ${handoffBlocks}
  ${roleBlocks}
});`;
}

function stepBlock(step: WorkflowAcceptanceStep, fixture: string): string {
  const marker = `workflowStepTitle(${JSON.stringify(step.workflowId)}, ${JSON.stringify(step.contractStepId)}, ${JSON.stringify(step.description)})`;
  if (step.kind === "navigate") {
    return step.accessibleName
      ? `await test.step(${marker}, async () => { await page.getByRole("link", { name: ${JSON.stringify(step.accessibleName)} }).click(); await expect(page).toHaveURL(${JSON.stringify(step.route)}); });`
      : `await test.step(${marker}, async () => { await page.goto(${JSON.stringify(step.route)}); await expect(page).toHaveURL(${JSON.stringify(step.route)}); });`;
  }
  if (step.kind === "input") {
    return `await test.step(${marker}, async () => { await page.getByLabel(${JSON.stringify(step.accessibleName)}).fill(${JSON.stringify(fixture)}); });`;
  }
  if (step.kind === "result" || step.kind === "automatic") {
    return `await test.step(${marker}, async () => { await expect(page.getByText(${JSON.stringify(step.visibleResult || fixture)})).toBeVisible(); });`;
  }
  return `await test.step(${marker}, async () => { await page.getByRole("button", { name: ${JSON.stringify(step.accessibleName)} }).click(); });`;
}

describe("generated acceptance test review", () => {
  it("verifies a traceable UI journey with save refresh and viewer proof", () => {
    const { spec, architecture } = sharedApp();
    const plan = synthesizeWorkflowAcceptancePlan(spec, architecture);
    const source = compliantTest(plan.journeys[0]);
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues).toEqual([]);
    expect(review.summary.journeysVerified).toBe(1);
    expect(review.summary.stepsVerified).toBe(review.summary.stepsRequired);
    expect(review.summary.refreshChecksVerified).toBe(
      review.summary.refreshChecksRequired,
    );
    expect(review.summary.roleScenariosVerified).toBe(
      review.summary.roleScenariosRequired,
    );
  });

  it("recognizes trace helpers that use aliases and statically declared ids", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    const source = compliantTest(journey)
      .replace(
        "workflowJourneyTitle,",
        "workflowJourneyTitle as journeyTitle,",
      )
      .replace(
        `test(workflowJourneyTitle(${JSON.stringify(journey.id)},`,
        `const TRACE_IDS = { journey: ${JSON.stringify(journey.id)} } as const;\ntest(journeyTitle(TRACE_IDS.journey,`,
      );
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.summary.journeysGenerated).toBe(1);
    expect(review.summary.journeysVerified).toBe(1);
    expect(review.blockingIssues).toEqual([]);
  });

  it("accepts visible navigation proven with a destination URL assertion", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    let source = compliantTest(journey);
    for (const handoff of journey.handoffs) {
      source = source.replaceAll(
        `await page.goto(${JSON.stringify(handoff.consumerRoute)});`,
        `await page.getByRole("link", { name: "Open destination" }).click();\n  await expect(page).toHaveURL(${JSON.stringify(handoff.consumerRoute)});`,
      );
    }
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues).toEqual([]);
    expect(review.summary.handoffsVerified).toBe(
      review.summary.handoffsRequired,
    );
  });

  it("assigns nested workflow actions to both owning trace blocks", () => {
    const source = `await test.step(workflowHandoffTitle("member-to-loan"), async () => {
  await test.step(workflowStepTitle("lend-equipment", "open-active-loans", "Open active loans"), async () => {
    await page.goto("/active-loans");
    await expect(page).toHaveURL("/active-loans");
  });
  await expect(page.getByRole("option", { name: "Alex Morgan" })).toBeVisible();
});`;
    const calls = extractAcceptanceTraceCalls(source);
    const handoff = findAcceptanceTraceCall(calls, "workflowHandoffTitle", [
      "member-to-loan",
    ])!;
    const step = findAcceptanceTraceCall(calls, "workflowStepTitle", [
      "lend-equipment",
      "open-active-loans",
    ])!;
    const handoffScope = source.slice(handoff.scopeStart!, handoff.scopeEnd!);
    const stepScope = source.slice(step.scopeStart!, step.scopeEnd!);

    expect(handoffScope).toContain('page.goto("/active-loans")');
    expect(handoffScope).toContain('name: "Alex Morgan"');
    expect(stepScope).toContain('page.goto("/active-loans")');
    expect(stepScope).not.toContain('name: "Alex Morgan"');
  });

  it("blocks a save marker that does not prove persistence after reload", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(spec, architecture).journeys[0];
    const source = compliantTest(journey).replace("await page.reload();", "void page;");
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).toContain(
      "does not reload and visibly assert saved",
    );
  });

  it("blocks skipped journeys and direct localStorage setup", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(spec, architecture).journeys[0];
    const source = compliantTest(journey)
      .replace("test(workflowJourneyTitle", "test.skip(workflowJourneyTitle")
      .replace("void fixture;", 'localStorage.setItem("records", fixture);');
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues).toContain(
      "acceptance_test:quality Generated workflow acceptance tests may not use test.skip or test.fixme.",
    );
    expect(review.blockingIssues.join(" ")).toContain(
      "not direct storage or platform API setup",
    );
  });

  it("does not accept a labeled contract step without its UI action", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(spec, architecture).journeys[0];
    const actionable = journey.steps.find(
      (step) => step.kind === "action" || step.kind === "save",
    )!;
    const source = compliantTest(journey).replace(
      `await page.getByRole("button", { name: ${JSON.stringify(actionable.accessibleName)} }).click();`,
      "void page;",
    );
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).toContain(
      `labels ${actionable.contractStepId} but does not perform`,
    );
  });

  it("defers locator wording uncertainty to the real browser journey", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(
      spec,
      architecture,
    ).journeys[0];
    const actionable = journey.steps.find(
      (step) => step.kind === "action" || step.kind === "save",
    )!;
    const source = compliantTest(journey).replace(
      `await page.getByRole("button", { name: ${JSON.stringify(actionable.accessibleName)} }).click();`,
      'await page.getByRole("button", { name: "Save this item" }).click();',
    );
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).not.toContain(
      "does not use the contracted control",
    );
    expect(review.warnings.join(" ")).toContain(
      "locator wording is equivalent",
    );
    expect(review.warnings.join(" ")).toContain("actual Playwright result");
  });

  it("defers an opaque helper implementation to the actual Playwright run", () => {
    const { spec, architecture } = sharedApp();
    const journey = synthesizeWorkflowAcceptancePlan(spec, architecture).journeys[0];
    const actionable = journey.steps.find(
      (step) => step.kind === "action" || step.kind === "save",
    )!;
    const source = compliantTest(journey).replace(
      `await page.getByRole("button", { name: ${JSON.stringify(actionable.accessibleName)} }).click();`,
      "await completeContractedAction(page);",
    );
    const review = analyzeGeneratedAcceptanceTests({
      spec,
      architecture,
      files: { "e2e/generated/chore-journey.spec.ts": source },
    });

    expect(review.blockingIssues.join(" ")).not.toContain(
      `labels ${actionable.contractStepId} but does not perform`,
    );
    expect(review.warnings.join(" ")).toContain(
      "actual Playwright result",
    );
  });
});
