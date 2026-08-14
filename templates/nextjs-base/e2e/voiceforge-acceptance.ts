/**
 * LOCKED PLATFORM FILE - managed by VoiceForge.
 * Stable helpers for generated contract-driven Playwright journeys.
 */
import { expect, type Download, type Locator, type Page } from "@playwright/test";

type ContractLocatorScope = Page | Locator;

export type VoiceForgeAcceptanceRole =
  | "owner"
  | "editor"
  | "viewer"
  | "public";

const ACCEPTANCE_RUN_SUFFIX = `${process.pid}-${Date.now().toString(36)}`;

export function acceptanceRunSuffix(): string {
  return ACCEPTANCE_RUN_SUFFIX;
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
