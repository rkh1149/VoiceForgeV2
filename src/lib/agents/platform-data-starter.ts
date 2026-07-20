import type { ArchitecturePlan } from "../architecture";
import type { FileMap } from "../build/template";
import { platformEntityFromSpec } from "../platform/spec-seeding";
import type { AppSpec } from "../spec";
import type { FileOperation } from "./file-tools";
import type { CodegenResult } from "./coder";

type StarterField = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
};

export function canUsePlatformDataStarter(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
}): boolean {
  const needsRichStage10Ui =
    input.architecture.dependencyProfile.some((profile) =>
      ["advancedInterface", "fileExport"].includes(profile),
    ) || hasExplicitRichUiRequest(input.spec);
  return (
    !needsRichStage10Ui &&
    input.spec.fileRequirements.length === 0 &&
    input.spec.notifications.every((notification) => notification.channel === "none") &&
    input.spec.dataEntities.length > 0 &&
    input.architecture.dataModel.some((entity) => entity.storage === "platformData")
  );
}

function hasExplicitRichUiRequest(spec: AppSpec): boolean {
  const text = JSON.stringify({
    appName: spec.appName,
    purpose: spec.purpose,
    screens: spec.screens,
    features: spec.features,
    workflows: spec.workflows,
    dataToStore: spec.dataToStore,
    acceptanceCriteria: spec.acceptanceCriteria,
    testScenarios: spec.testScenarios,
  }).toLowerCase();
  return [
    "chart",
    "dashboard",
    "search",
    "filter",
    "saved filter",
    "report",
    "sortable",
    "table",
    "calendar",
    "date picker",
    "drag",
    "drop",
    "kanban",
    "csv",
    "export",
    "comment",
    "activity history",
  ].some((signal) => text.includes(signal));
}

export function generatePlatformDataStarterApp(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
}): CodegenResult {
  const entity = platformEntityFromSpec(input.spec.dataEntities[0], input.spec);
  const fields: StarterField[] = entity.fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
  }));
  const primaryField =
    fields.find((field) => /title|name|item|task|chore/i.test(field.key)) ??
    fields[0];
  const toggleField =
    fields.find(
      (field) =>
        field.type === "boolean" &&
        /bought|done|complete|completed|purchased|checked|finished/i.test(
          `${field.key} ${field.label}`,
        ),
    ) ?? fields.find((field) => field.type === "boolean");

  const files: FileMap = {
    "src/app/page.tsx": pageFile(),
    "src/components/PlatformDataApp.tsx": componentFile(),
    "src/lib/platform-app-config.ts": configFile({
      spec: input.spec,
      entityKey: entity.key,
      entityLabel: entity.name,
      fields,
      primaryFieldKey: primaryField.key,
      toggleFieldKey: toggleField?.key ?? null,
    }),
    "src/lib/platform-app-config.test.ts": configTestFile(),
  };
  const filesWritten = Object.keys(files);
  const operations: FileOperation[] = filesWritten.map((path) => ({
    operation: "write",
    path,
  }));

  return {
    files,
    deletedFiles: [],
    notes:
      "Generated a fast shared-data starter app using the locked platform data client.",
    filesWritten,
    phases: [
      {
        id: "platform-data-starter",
        label: "Fast platform data starter",
        agentKey: "backend_platform_planner",
        filesWritten,
        filesDeleted: [],
        notes:
          "Created a shared CRUD interface backed by VoiceForge platform data.",
      },
    ],
    operations,
  };
}

function pageFile(): string {
  return `import PlatformDataApp from "@/components/PlatformDataApp";

export default function HomePage() {
  return <PlatformDataApp />;
}
`;
}

function configFile(input: {
  spec: AppSpec;
  entityKey: string;
  entityLabel: string;
  fields: StarterField[];
  primaryFieldKey: string;
  toggleFieldKey: string | null;
}): string {
  return `export type FieldConfig = {
  key: string;
  label: string;
  type: "text" | "long_text" | "number" | "boolean" | "date" | "datetime" | "select" | "multi_select" | "image" | "file" | "relation" | "json";
  required: boolean;
  options: string[];
};

export const APP_NAME = ${JSON.stringify(input.spec.appName)};
export const APP_PURPOSE = ${JSON.stringify(input.spec.purpose)};
export const REQUIRE_SIGN_IN: boolean = ${JSON.stringify(input.spec.needsLogin)};
export const SHARING_MODEL: "private" | "shared" | "public" = ${JSON.stringify(input.spec.sharingModel)};
export const ENTITY_KEY = ${JSON.stringify(input.entityKey)};
export const ENTITY_LABEL = ${JSON.stringify(input.entityLabel)};
export const PRIMARY_FIELD_KEY = ${JSON.stringify(input.primaryFieldKey)};
export const TOGGLE_FIELD_KEY = ${JSON.stringify(input.toggleFieldKey)};
export const FIELDS: FieldConfig[] = ${JSON.stringify(input.fields, null, 2)};
export const VISIBLE_FIELDS = FIELDS.filter(
  (field) => !isSystemTimestampField(field),
);

export type DraftValue = string | number | boolean | string[] | null;
export type DraftData = Record<string, DraftValue>;

export function defaultValueForField(field: FieldConfig): DraftValue {
  if (field.type === "boolean") return false;
  if (field.type === "number") return 0;
  if (field.type === "multi_select") return [];
  return "";
}

export function createEmptyDraft(): DraftData {
  return Object.fromEntries(
    VISIBLE_FIELDS.map((field) => [field.key, defaultValueForField(field)]),
  ) as DraftData;
}

export function isSystemTimestampField(field: FieldConfig): boolean {
  return /^(created_at|updated_at|createdat|updatedat)$/.test(field.key);
}

export function isMissingRequiredValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function recordDisplayName(data: Record<string, unknown>): string {
  const primary = data[PRIMARY_FIELD_KEY];
  if (typeof primary === "string" && primary.trim()) return primary;
  if (typeof primary === "number") return String(primary);
  const fallback = Object.values(data).find(
    (value) => typeof value === "string" && value.trim(),
  );
  return typeof fallback === "string" ? fallback : ENTITY_LABEL;
}

export function prepareDataForSave(
  data: Record<string, unknown>,
  existingData: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = new Date().toISOString();
  const next: Record<string, unknown> = { ...data };
  for (const field of FIELDS) {
    if (!isSystemTimestampField(field)) continue;
    if (/^created/i.test(field.key)) {
      next[field.key] = existingData[field.key] ?? now;
    } else {
      next[field.key] = now;
    }
  }
  return next;
}
`;
}

function componentFile(): string {
  return `"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  createPlatformRecord,
  deletePlatformRecord,
  getPlatformSession,
  listPlatformRecords,
  signInToPlatform,
  signOutPlatformSession,
  updatePlatformRecord,
  type PlatformSession,
  type PlatformRecord,
} from "@/lib/platform-data";
import {
  APP_NAME,
  APP_PURPOSE,
  ENTITY_KEY,
  ENTITY_LABEL,
  REQUIRE_SIGN_IN,
  SHARING_MODEL,
  TOGGLE_FIELD_KEY,
  VISIBLE_FIELDS,
  createEmptyDraft,
  isMissingRequiredValue,
  prepareDataForSave,
  recordDisplayName,
  type DraftData,
  type DraftValue,
  type FieldConfig,
} from "@/lib/platform-app-config";

type SharedRecord = PlatformRecord<Record<string, unknown>>;

function accessModeLabel(): string {
  if (REQUIRE_SIGN_IN) return "Invite-only workspace";
  if (SHARING_MODEL === "public") return "Public workspace";
  if (SHARING_MODEL === "private") return "Private workspace";
  return "Shared link workspace";
}

export default function PlatformDataApp() {
  const [records, setRecords] = useState<SharedRecord[]>([]);
  const [draft, setDraft] = useState<DraftData>(() => createEmptyDraft());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<PlatformSession | null>(null);

  useEffect(() => {
    let active = true;
    async function loadApp() {
      try {
        setIsLoading(true);
        setError(null);
        const currentSession = await getPlatformSession();
        if (!active) return;
        setSession(currentSession);
        if (
          currentSession.status === "signed_out" ||
          currentSession.status === "no_access"
        ) {
          setRecords([]);
          return;
        }
        const loaded = await listPlatformRecords<Record<string, unknown>>(
          ENTITY_KEY,
        );
        if (active) setRecords(loaded);
      } catch (err) {
        if (active) setError(errorMessage(err));
      } finally {
        if (active) setIsLoading(false);
      }
    }
    void loadApp();
    return () => {
      active = false;
    };
  }, []);

  const completedCount = useMemo(() => {
    const toggleKey = TOGGLE_FIELD_KEY;
    if (!toggleKey) return 0;
    return records.filter((record) => Boolean(record.data[toggleKey])).length;
  }, [records]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = prepareDataForSave(draft);
    const missing = VISIBLE_FIELDS.find(
      (field) => field.required && isMissingRequiredValue(payload[field.key]),
    );
    if (missing) {
      setError(\`\${missing.label} is required.\`);
      return;
    }
    if (!session?.canWrite) {
      setError("You can view this app, but you cannot change its data.");
      return;
    }

    try {
      setIsSaving(true);
      setError(null);
      const created = await createPlatformRecord<Record<string, unknown>>(
        ENTITY_KEY,
        payload,
      );
      setRecords((current) => [created, ...current]);
      setDraft(createEmptyDraft());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleRecord(record: SharedRecord) {
    const toggleKey = TOGGLE_FIELD_KEY;
    if (!toggleKey || !session?.canWrite) return;
    const nextData = {
      ...record.data,
      [toggleKey]: !Boolean(record.data[toggleKey]),
    };
    await updateExistingRecord(record.id, prepareDataForSave(nextData, record.data));
  }

  async function updateExistingRecord(
    recordId: string,
    data: Record<string, unknown>,
  ) {
    try {
      setError(null);
      const updated = await updatePlatformRecord<Record<string, unknown>>(
        recordId,
        data,
      );
      setRecords((current) =>
        current.map((record) => (record.id === updated.id ? updated : record)),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeRecord(recordId: string) {
    if (!session?.canWrite) {
      setError("You can view this app, but you cannot change its data.");
      return;
    }
    try {
      setError(null);
      await deletePlatformRecord(recordId);
      setRecords((current) => current.filter((record) => record.id !== recordId));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="border-b border-slate-200 pb-5">
          <p className="text-sm font-medium uppercase tracking-wide text-emerald-700">
            {accessModeLabel()}
          </p>
          <h1 className="mt-2 text-3xl font-bold text-slate-950">{APP_NAME}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            {APP_PURPOSE}
          </p>
          <SessionBanner
            session={session}
            isLoading={isLoading}
            onSignIn={() => session && signInToPlatform(session)}
            onSignOut={() => {
              signOutPlatformSession();
              window.location.reload();
            }}
          />
        </header>

        {session?.status === "signed_out" ? (
          <AccessState
            title="Sign in required"
            message="This app is shared with specific people. Sign in with VoiceForge to continue."
            actionLabel="Sign in with VoiceForge"
            onAction={() => signInToPlatform(session)}
          />
        ) : session?.status === "no_access" ? (
          <AccessState
            title="No access"
            message="You are signed in, but this app has not been shared with your VoiceForge account."
          />
        ) : (
          <>

        <section className="mt-6 grid gap-4 sm:grid-cols-3">
          <Metric label="Total" value={records.length} />
          <Metric label="Open" value={TOGGLE_FIELD_KEY ? records.length - completedCount : records.length} />
          <Metric label="Completed" value={TOGGLE_FIELD_KEY ? completedCount : 0} />
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
          <form
            onSubmit={handleSubmit}
            className={\`rounded-lg border border-slate-200 bg-white p-4 shadow-sm \${!session?.canWrite ? "opacity-75" : ""}\`}
          >
            <h2 className="text-lg font-semibold text-slate-950">
              Add {ENTITY_LABEL.toLowerCase()}
            </h2>
            {session?.canWrite ? (
              <div className="mt-4 space-y-4">
                {VISIBLE_FIELDS.map((field) => (
                  <FieldInput
                    key={field.key}
                    field={field}
                    value={draft[field.key]}
                    onChange={(value) =>
                      setDraft((current) => ({ ...current, [field.key]: value }))
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
                Your role is viewer, so adding and editing are disabled.
              </p>
            )}
            {error && (
              <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={isSaving || !session?.canWrite}
              className="mt-5 w-full rounded-md bg-emerald-700 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {isSaving ? "Saving..." : "Save item"}
            </button>
          </form>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-950">
                Shared list
              </h2>
              <span className="text-sm text-slate-500">
                {isLoading ? "Loading..." : \`\${records.length} item\${records.length === 1 ? "" : "s"}\`}
              </span>
            </div>

            {isLoading ? (
              <p className="mt-5 text-sm text-slate-500">Loading shared data...</p>
            ) : records.length === 0 ? (
              <p className="mt-5 rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
                Nothing has been added yet.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-slate-100">
                {records.map((record) => (
                  <li
                    key={record.id}
                    className="grid gap-3 py-4 sm:grid-cols-[1fr_auto]"
                  >
                    <div>
                      <h3 className="font-semibold text-slate-950">
                        {recordDisplayName(record.data)}
                      </h3>
                      <dl className="mt-2 grid gap-1 text-sm text-slate-600 sm:grid-cols-2">
                        {VISIBLE_FIELDS.filter((field) => field.key !== TOGGLE_FIELD_KEY).map(
                          (field) => (
                            <div key={field.key}>
                              <dt className="font-medium text-slate-500">
                                {field.label}
                              </dt>
                              <dd>{formatValue(record.data[field.key])}</dd>
                            </div>
                          ),
                        )}
                      </dl>
                    </div>
                    {session?.canWrite && (
                      <div className="flex items-start gap-2">
                        {renderToggleButton(record, toggleRecord)}
                        <button
                          type="button"
                          onClick={() => void removeRecord(record.id)}
                          className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
          </>
        )}
      </div>
    </main>
  );
}

function SessionBanner({
  session,
  isLoading,
  onSignIn,
  onSignOut,
}: {
  session: PlatformSession | null;
  isLoading: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  if (isLoading && !session) {
    return (
      <p className="mt-4 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-500">
        Checking access...
      </p>
    );
  }
  if (!session) return null;
  if (session.status === "anonymous") {
    const accessName =
      SHARING_MODEL === "public"
        ? "Public link access"
        : SHARING_MODEL === "private"
          ? "Private app access"
          : "Shared link access";
    const accessVerb = session.canWrite ? "view and edit" : "view";
    return (
      <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        {accessName} is enabled. Anyone with this link can {accessVerb}.
      </p>
    );
  }
  if (session.status === "signed_in") {
    return (
      <div className="mt-4 flex flex-col gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 sm:flex-row sm:items-center sm:justify-between">
        <p>
          Signed in as {session.user?.displayName || session.user?.email} - {session.role}
        </p>
        <button
          type="button"
          onClick={onSignOut}
          className="self-start rounded-md border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 sm:self-auto"
        >
          Sign out
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onSignIn}
      className="mt-4 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
    >
      Sign in with VoiceForge
    </button>
  );
}

function AccessState({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="mt-8 rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
        {message}
      </p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-5 rounded-md bg-emerald-700 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-800"
        >
          {actionLabel}
        </button>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-2xl font-bold text-slate-950">{value}</p>
      <p className="mt-1 text-sm text-slate-500">{label}</p>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldConfig;
  value: DraftValue;
  onChange: (value: DraftValue) => void;
}) {
  const id = \`field-\${field.key}\`;
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-3 text-sm font-medium text-slate-700">
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-emerald-700"
        />
        {field.label}
      </label>
    );
  }

  return (
    <label htmlFor={id} className="block text-sm font-medium text-slate-700">
      {field.label}
      {field.required && <span className="text-red-600"> *</span>}
      <input
        id={id}
        type={inputType(field)}
        value={inputValue(value)}
        onChange={(event) => onChange(coerceValue(field, event.target.value))}
        className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 shadow-sm focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
      />
    </label>
  );
}

function renderToggleButton(
  record: SharedRecord,
  onToggle: (record: SharedRecord) => Promise<void>,
) {
  const toggleKey = TOGGLE_FIELD_KEY;
  if (!toggleKey) return null;
  return (
    <button
      type="button"
      onClick={() => void onToggle(record)}
      className="rounded-md border border-emerald-200 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50"
    >
      {record.data[toggleKey] ? "Reopen" : "Mark done"}
    </button>
  );
}

function inputType(field: FieldConfig): string {
  if (field.type === "number") return "number";
  if (field.type === "date") return "date";
  if (field.type === "datetime") return "datetime-local";
  return "text";
}

function coerceValue(field: FieldConfig, value: string): DraftValue {
  if (field.type === "number") return value === "" ? 0 : Number(value);
  if (field.type === "multi_select") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return value;
}

function inputValue(value: DraftValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.join(", ");
  return "";
}

function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) return value.join(", ");
  return "Not set";
}

function errorMessage(err: unknown): string {
  return err instanceof Error
    ? err.message
    : "The shared data could not be updated. Please try again.";
}
`;
}

function configTestFile(): string {
  return `import { describe, expect, it } from "vitest";
import {
  ENTITY_KEY,
  FIELDS,
  PRIMARY_FIELD_KEY,
  VISIBLE_FIELDS,
  createEmptyDraft,
  recordDisplayName,
} from "./platform-app-config";

describe("platform app config", () => {
  it("defines a platform entity and draft shape", () => {
    const draft = createEmptyDraft();

    expect(ENTITY_KEY).toMatch(/^[a-z0-9_]+$/);
    expect(FIELDS.length).toBeGreaterThan(0);
    expect(Object.keys(draft)).toEqual(VISIBLE_FIELDS.map((field) => field.key));
  });

  it("uses the primary field as the display name", () => {
    expect(recordDisplayName({ [PRIMARY_FIELD_KEY]: "Milk" })).toBe("Milk");
  });
});
`;
}
