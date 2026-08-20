/**
 * LOCKED PLATFORM FILE - managed by VoiceForge.
 * Stable helpers for generated contract-driven Playwright journeys.
 */
import {
  expect,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

type ContractLocatorScope = Page | Locator;

export type VoiceForgeAcceptanceRole =
  | "owner"
  | "editor"
  | "viewer"
  | "public";

export type VoiceForgeAcceptanceManifest = {
  version: number;
  compilerVersion: number;
  sourcePlanVersion: number;
  locatorMode: "contract" | "accessible_name_fallback";
  journeys: readonly unknown[];
  adapters: readonly unknown[];
  summary: Record<string, number>;
};

export type VoiceForgeAcceptanceAdapterContext = {
  page: Page;
  context: BrowserContext;
  control: Locator | null;
  fixtures: Record<string, unknown>;
  step: {
    journeyId: string;
    workflowId: string;
    contractStepId: string;
    description: string;
  };
};

export type VoiceForgeAcceptanceAdapters = Record<
  string,
  (context: VoiceForgeAcceptanceAdapterContext) => Promise<void>
>;

export type VoiceForgeAcceptanceFormFixture = {
  id: string;
  label: string;
  type: string;
  value: unknown;
};

export function acceptanceRunSuffix(
  testInfo?: TestInfo,
  fixtureNamespace = "legacy",
): string {
  if (!testInfo) {
    return [
      "vf",
      acceptanceIdentityHash(fixtureNamespace),
      process.pid.toString(36),
      Date.now().toString(36).slice(-7),
      Math.random().toString(36).slice(2, 7),
    ].join("-");
  }
  return [
    "vf",
    acceptanceIdentityHash(fixtureNamespace),
    acceptanceIdentityHash(testInfo.project.name || "project"),
    acceptanceIdentityHash(testInfo.testId),
    `w${testInfo.workerIndex}`,
    `p${testInfo.parallelIndex}`,
    `r${testInfo.retry}`,
    `n${testInfo.repeatEachIndex}`,
    process.pid.toString(36),
    Date.now().toString(36).slice(-7),
  ].join("-");
}

export function acceptanceRetryProbe(
  testInfo: TestInfo,
  journeyId: string,
): void {
  if (
    process.env.VOICEFORGE_ACCEPTANCE_RETRY_PROBE === "1" &&
    testInfo.retry === 0
  ) {
    throw new Error(
      `[voiceforge-retry-probe:${journeyId}] Intentional first-attempt failure after visible prerequisite setup.`,
    );
  }
}

export function workflowJourneyTitle(journeyId: string, name: string): string {
  return `[voiceforge-journey:${journeyId}] ${name}`;
}

export function workflowStepTitle(
  workflowId: string,
  stepId: string,
  description: string,
): string {
  return `[voiceforge-workflow:${workflowId}][voiceforge-step:${stepId}] ${description}`;
}

export function workflowSaveTitle(saveId: string): string {
  return `[voiceforge-save:${saveId}] persists after reload`;
}

export function workflowHandoffTitle(handoffId: string): string {
  return `[voiceforge-handoff:${handoffId}] reaches its consumer`;
}

export function workflowFixtureSetupTitle(
  targetJourneyId: string,
  sourceJourneyId: string,
): string {
  return `[voiceforge-fixture-setup:${targetJourneyId}:${sourceJourneyId}] recreate prerequisite through visible UI`;
}

export function workflowFixtureStepTitle(
  targetJourneyId: string,
  sourceJourneyId: string,
  workflowId: string,
  stepId: string,
  description: string,
): string {
  return `[voiceforge-fixture-step:${targetJourneyId}:${sourceJourneyId}:${workflowId}:${stepId}] ${description}`;
}

export function workflowFixtureSaveTitle(
  targetJourneyId: string,
  sourceJourneyId: string,
  saveId: string,
): string {
  return `[voiceforge-fixture-save:${targetJourneyId}:${sourceJourneyId}:${saveId}] prerequisite persists`;
}

export function workflowFixtureHandoffTitle(
  targetJourneyId: string,
  sourceJourneyId: string,
  handoffId: string,
): string {
  return `[voiceforge-fixture-handoff:${targetJourneyId}:${sourceJourneyId}:${handoffId}] prerequisite reaches its consumer`;
}

export function vfControl(
  scope: ContractLocatorScope,
  workflowId: string,
  controlId: string,
): Locator {
  return scope.locator(
    `[data-vf-workflow=${cssAttributeValue(workflowId)}][data-vf-control=${cssAttributeValue(controlId)}]`,
  );
}

export function vfRecords(
  scope: ContractLocatorScope,
  entityKey: string,
): Locator {
  return scope.locator(
    `[data-vf-entity=${cssAttributeValue(entityKey)}][data-vf-record]`,
  );
}

export function vfRecord(
  scope: ContractLocatorScope,
  entityKey: string,
  recordId: string,
): Locator {
  return scope.locator(
    `[data-vf-entity=${cssAttributeValue(entityKey)}][data-vf-record=${cssAttributeValue(recordId)}]`,
  );
}

export function vfRecordControl(
  record: Locator,
  workflowId: string,
  controlId: string,
): Locator {
  return vfControl(record, workflowId, controlId);
}

export function resolveAcceptanceControl(
  scope: ContractLocatorScope,
  workflowId: string,
  controlId: string,
  accessibleName: string,
): Locator {
  const stable = vfControl(scope, workflowId, controlId);
  return stable
    .or(scope.getByRole("button", { name: accessibleName, exact: true }))
    .or(scope.getByRole("link", { name: accessibleName, exact: true }))
    .or(scope.getByLabel(accessibleName, { exact: true }))
    .first();
}

export async function resolveUniqueAcceptanceControl(
  scope: ContractLocatorScope,
  workflowId: string,
  controlId: string,
  accessibleName: string,
): Promise<Locator> {
  const stable = vfControl(scope, workflowId, controlId);
  if ((await stable.count()) === 1) return stable;
  const accessible = [
    scope.getByRole("button", { name: accessibleName, exact: true }),
    scope.getByRole("link", { name: accessibleName, exact: true }),
    scope.getByLabel(accessibleName, { exact: true }),
  ];
  for (const candidate of accessible) {
    if ((await candidate.count()) === 1) return candidate;
  }
  return stable.or(accessible[0]).or(accessible[1]).or(accessible[2]).first();
}

export async function expectContractControl(
  control: Locator,
  accessibleName?: string | RegExp,
): Promise<void> {
  await expect(control).toHaveCount(1);
  await expect(control).toBeVisible();
  if (accessibleName) await expect(control).toHaveAccessibleName(accessibleName);
}

export function voiceForgeRoleHeaders(
  role: VoiceForgeAcceptanceRole,
): Record<string, string> {
  return { "x-voiceforge-test-role": role };
}

export function voiceForgeIsolationHeaders(
  role: VoiceForgeAcceptanceRole,
  runSuffix: string,
): Record<string, string> {
  return {
    ...voiceForgeRoleHeaders(role),
    "x-voiceforge-test-namespace": runSuffix,
  };
}

export async function expectPersistedAfterReload(
  page: Page,
  visibleRecord: Locator,
): Promise<void> {
  await page.reload();
  await expect(visibleRecord).toBeVisible();
}

export async function expectDownloadedFile(
  download: Download,
  expectedName: RegExp,
): Promise<void> {
  expect(download.suggestedFilename()).toMatch(expectedName);
  expect(await download.failure()).toBeNull();
}

export async function selectAcceptanceOption(
  control: Locator,
  requestedValue: unknown,
): Promise<void> {
  const tagName = await control.evaluate((element) => element.tagName.toLowerCase());
  if (tagName === "select") {
    const requested = String(requestedValue ?? "");
    if (requested) {
      const matching = control.locator("option").filter({ hasText: requested });
      if ((await matching.count()) > 0) {
        await control.selectOption({ label: await matching.first().innerText() });
        return;
      }
      const values = await control.locator("option").evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      );
      if (values.includes(requested)) {
        await control.selectOption(requested);
        return;
      }
    }
    const fallbackValue = await firstUsableOptionValue(control);
    await control.selectOption(fallbackValue);
    return;
  }

  await control.click();
  const requested = String(requestedValue ?? "");
  const page = control.page();
  const requestedOption = requested
    ? page.getByRole("option", { name: requested, exact: true })
    : null;
  if (requestedOption && (await requestedOption.count()) > 0) {
    await requestedOption.first().click();
    return;
  }
  const firstOption = page.getByRole("option").filter({ visible: true }).first();
  await expect(firstOption).toBeVisible();
  await firstOption.click();
}

export async function completeAcceptanceForm(
  page: Page,
  formOrControl: Locator,
  fixtures: readonly VoiceForgeAcceptanceFormFixture[],
): Promise<void> {
  const scope =
    (await formOrControl.evaluate((element) => element.tagName.toLowerCase())) ===
    "form"
      ? formOrControl
      : page.locator("form").filter({ has: formOrControl }).first();
  const target = (await scope.count()) > 0 ? scope : page.locator("body");
  for (const fixture of fixtures) {
    const field = target.getByLabel(fixture.label, { exact: true });
    if ((await field.count()) === 0) continue;
    const candidate = field.first();
    const inputType = (await candidate.getAttribute("type"))?.toLowerCase() ?? "";
    const tagName = await candidate.evaluate((element) =>
      element.tagName.toLowerCase(),
    );
    if (inputType === "hidden" || inputType === "submit" || inputType === "button") {
      continue;
    }
    if (inputType === "checkbox" || inputType === "radio") {
      await candidate.check();
    } else if (inputType === "file") {
      await candidate.setInputFiles(tinyPngUpload(String(fixture.value)));
    } else if (tagName === "select") {
      await selectAcceptanceOption(candidate, fixture.value);
    } else {
      await candidate.fill(formFixtureText(fixture));
    }
  }
}

export async function runAcceptanceAdapter(
  adapters: VoiceForgeAcceptanceAdapters,
  adapterId: string | null,
  context: VoiceForgeAcceptanceAdapterContext,
): Promise<void> {
  if (!adapterId) {
    throw new Error(
      `VoiceForge acceptance compiler did not declare an adapter for ${context.step.workflowId}/${context.step.contractStepId}.`,
    );
  }
  const adapter = adapters[adapterId];
  if (!adapter) {
    throw new Error(
      `VoiceForge acceptance adapter ${adapterId} is unresolved for ${context.step.workflowId}/${context.step.contractStepId}.`,
    );
  }
  await adapter(context);
}

export async function dragAcceptanceControl(
  source: Locator,
  target: Locator,
  payload: Record<string, string> = {},
): Promise<void> {
  const dataTransfer = await source.page().evaluateHandle(
    (entries) => {
      const transfer = new DataTransfer();
      for (const [mimeType, value] of entries) transfer.setData(mimeType, value);
      return transfer;
    },
    Object.entries(payload),
  );
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await source.dispatchEvent("dragend", { dataTransfer });
  await dataTransfer.dispose();
}

export function tinyPngUpload(fileName = "voiceforge-stage-14d.png") {
  return {
    name: fileName,
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  };
}

function cssAttributeValue(value: string): string {
  const escaped = value.replace(/[\\"\n\r\f]/g, (character) => {
    if (character === "\n") return "\\a ";
    if (character === "\r") return "\\d ";
    if (character === "\f") return "\\c ";
    return `\\${character}`;
  });
  return `"${escaped}"`;
}

function acceptanceIdentityHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(-7);
}

async function firstUsableOptionValue(control: Locator): Promise<string> {
  const values = await control.locator("option").evaluateAll((options) =>
    options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      disabled: (option as HTMLOptionElement).disabled,
    })),
  );
  const option = values.find((candidate) => candidate.value && !candidate.disabled);
  if (!option) throw new Error("Acceptance combobox has no selectable option.");
  return option.value;
}

function formFixtureText(fixture: VoiceForgeAcceptanceFormFixture): string {
  if (typeof fixture.value === "string") return fixture.value;
  if (typeof fixture.value === "number") return String(fixture.value);
  if (Array.isArray(fixture.value)) return fixture.value.join(", ");
  if (typeof fixture.value === "boolean") return fixture.value ? "true" : "false";
  return JSON.stringify(fixture.value);
}
