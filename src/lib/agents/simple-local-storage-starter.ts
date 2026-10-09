import type { ArchitecturePlan } from "../architecture";
import type { FileMap } from "../build/template";
import { platformEntityFromSpec } from "../platform/spec-seeding";
import {
  appHasPersistentData,
  appNeedsServerData,
  type AppSpec,
} from "../spec";
import type { FileOperation } from "./file-tools";
import type { CodegenResult } from "./coder";

type ControlBinding = {
  workflowId: string;
  controlId: string;
  accessibleName: string;
};

type SimpleBindings = {
  createInput: ControlBinding;
  createSave: ControlBinding;
  editOpen: ControlBinding;
  editInput: ControlBinding;
  editSave: ControlBinding;
  toggle: ControlBinding | null;
  remove: ControlBinding;
  filter: ControlBinding | null;
  mappedControlIds: string[];
};

export function canUseSimpleLocalStorageStarter(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
}): boolean {
  const { spec, architecture } = input;
  const entity = spec.dataEntities[0];
  const platform = entity ? platformEntityFromSpec(entity, spec) : null;
  if (!platform) return false;
  const userFields = platform.fields.filter(
    (field) => !/^(?:created_at|updated_at|createdat|updatedat)$/.test(field.key),
  );
  const textFields = userFields.filter((field) => field.type === "text");
  const booleanFields = userFields.filter((field) => field.type === "boolean");
  const unsupportedFields = userFields.filter(
    (field) => !["text", "boolean"].includes(field.type),
  );
  const bindings = simpleBindings(architecture, platform.key);
  const requiredControlIds = architecture.workflowContracts.flatMap((contract) =>
    contract.controls.map((control) => control.id),
  );
  const allowedWorkflow = /\b(?:add|create|edit|rename|update|complete|completion|reopen|toggle|mark|delete|remove|filter|view|restore|load|confirm)\b/i;

  return Boolean(
    appHasPersistentData(spec) &&
      !appNeedsServerData(spec) &&
      !spec.needsLogin &&
      spec.sharingModel === "private" &&
      spec.capabilityTier === "personal" &&
      spec.screens.length === 1 &&
      spec.dataEntities.length === 1 &&
      entity.relationships.length === 0 &&
      textFields.length === 1 &&
      textFields[0].required &&
      booleanFields.length <= 1 &&
      unsupportedFields.length === 0 &&
      spec.aiFeatures.length === 0 &&
      spec.fileRequirements.length === 0 &&
      spec.integrations.length === 0 &&
      spec.notifications.every((notification) => notification.channel === "none") &&
      spec.reports.length === 0 &&
      architecture.dataModel.some(
        (candidate) =>
          candidate.storage === "localStorage" &&
          platformEntityFromSpec(entity, spec).key === platform.key,
      ) &&
      architecture.workflowContracts.every(
        (contract) =>
          contract.trigger !== "user_action" || allowedWorkflow.test(contract.name),
      ) &&
      bindings !== null &&
      requiredControlIds.every((id) => bindings.mappedControlIds.includes(id)),
  );
}

export function generateSimpleLocalStorageStarterApp(input: {
  spec: AppSpec;
  architecture: ArchitecturePlan;
}): CodegenResult {
  const entity = platformEntityFromSpec(input.spec.dataEntities[0], input.spec);
  const primaryField = entity.fields.find((field) => field.type === "text")!;
  const toggleField = entity.fields.find((field) => field.type === "boolean") ?? null;
  const bindings = simpleBindings(input.architecture, entity.key);
  if (!bindings) throw new Error("Simple localStorage workflow bindings are incomplete.");

  const files: FileMap = {
    "src/app/page.tsx": pageFile(),
    "src/components/SimpleLocalApp.tsx": componentFile(),
    "src/components/SimpleLocalApp.test.tsx": componentTestFile(),
    "src/lib/simple-app-config.ts": configFile({
      spec: input.spec,
      entityKey: entity.key,
      entityLabel: entity.name,
      primaryFieldKey: primaryField.key,
      primaryFieldLabel: primaryField.label,
      toggleFieldKey: toggleField?.key ?? null,
      bindings,
    }),
    "src/lib/simple-app-storage.ts": storageFile(),
    "src/lib/simple-app-storage.test.ts": storageTestFile(),
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
      "Generated the deterministic one-screen personal CRUD blueprint with localStorage persistence.",
    filesWritten,
    phases: [
      {
        id: "simple-local-storage-starter",
        label: "Deterministic simple CRUD blueprint",
        agentKey: "frontend_builder",
        filesWritten,
        filesDeleted: [],
        notes:
          "Created validated add, edit, status, delete, filter, and refresh-persistence workflows without AI-generated structure.",
        turnContinuations: 0,
        turnLimit: 0,
      },
    ],
    operations,
  };
}

function simpleBindings(
  architecture: ArchitecturePlan,
  entityKey: string,
): SimpleBindings | null {
  const mutation = (operation: "create" | "update" | "delete") =>
    architecture.workflowContracts.filter((contract) =>
      contract.expectedSaves.some(
        (save) => save.entityKey === entityKey && save.operation === operation,
      ),
    );
  const create = mutation("create")[0];
  const update = mutation("update");
  const edit = update.find((contract) => /\b(?:edit|rename)\b/i.test(contract.name));
  const toggle = update.find((contract) =>
    /\b(?:complete|completion|reopen|toggle|mark|status)\b/i.test(contract.name),
  );
  const remove = mutation("delete")[0];
  const filter = architecture.workflowContracts.find(
    (contract) =>
      contract.expectedSaves.length === 0 && /\b(?:filter|view)\b/i.test(contract.name),
  );
  if (!create || !edit || !remove) return null;

  const createInput = bindingForStep(create, (step) => step.kind === "input");
  const createSave = saveBinding(create, entityKey, "create");
  const editInput = bindingForStep(edit, (step) => step.kind === "input");
  const editSave = saveBinding(edit, entityKey, "update");
  const editOpen = bindingForStep(
    edit,
    (step) =>
      ["navigate", "action"].includes(step.kind) &&
      step.controlId !== editInput?.controlId,
  );
  const removeControl = saveBinding(remove, entityKey, "delete");
  const toggleControl = toggle
    ? saveBinding(toggle, entityKey, "update") ??
      bindingForStep(toggle, (step) => ["action", "save"].includes(step.kind))
    : null;
  const filterControl = filter
    ? bindingForStep(filter, (step) => ["action", "input"].includes(step.kind))
    : null;
  if (!createInput || !createSave || !editOpen || !editInput || !editSave || !removeControl) {
    return null;
  }
  const values = [
    createInput,
    createSave,
    editOpen,
    editInput,
    editSave,
    toggleControl,
    removeControl,
    filterControl,
  ].filter((value): value is ControlBinding => value !== null);
  return {
    createInput,
    createSave,
    editOpen,
    editInput,
    editSave,
    toggle: toggleControl,
    remove: removeControl,
    filter: filterControl,
    mappedControlIds: [...new Set(values.map((value) => value.controlId))],
  };
}

function saveBinding(
  contract: ArchitecturePlan["workflowContracts"][number],
  entityKey: string,
  operation: "create" | "update" | "delete",
): ControlBinding | null {
  const stepId = contract.expectedSaves.find(
    (save) => save.entityKey === entityKey && save.operation === operation,
  )?.stepId;
  return bindingForStep(contract, (step) => step.id === stepId);
}

function bindingForStep(
  contract: ArchitecturePlan["workflowContracts"][number],
  predicate: (step: ArchitecturePlan["workflowContracts"][number]["steps"][number]) => boolean,
): ControlBinding | null {
  const step = contract.steps.find((candidate) => predicate(candidate));
  const control = contract.controls.find(
    (candidate) => candidate.id === step?.controlId,
  );
  return control
    ? {
        workflowId: contract.id,
        controlId: control.id,
        accessibleName: control.accessibleName,
      }
    : null;
}

function pageFile(): string {
  return `import SimpleLocalApp from "@/components/SimpleLocalApp";

export default function HomePage() {
  return <SimpleLocalApp />;
}
`;
}

function configFile(input: {
  spec: AppSpec;
  entityKey: string;
  entityLabel: string;
  primaryFieldKey: string;
  primaryFieldLabel: string;
  toggleFieldKey: string | null;
  bindings: SimpleBindings;
}): string {
  return `export type ContractControl = {
  workflowId: string;
  controlId: string;
  accessibleName: string;
};

export const APP_NAME = ${JSON.stringify(input.spec.appName)};
export const APP_PURPOSE = ${JSON.stringify(input.spec.purpose)};
export const ENTITY_KEY = ${JSON.stringify(input.entityKey)};
export const ENTITY_LABEL = ${JSON.stringify(input.entityLabel)};
export const PRIMARY_FIELD_KEY = ${JSON.stringify(input.primaryFieldKey)};
export const PRIMARY_FIELD_LABEL = ${JSON.stringify(input.primaryFieldLabel)};
export const TOGGLE_FIELD_KEY = ${JSON.stringify(input.toggleFieldKey)};
export const STORAGE_KEY = ${JSON.stringify(`voiceforge:${input.spec.appName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:records`)};

export const CONTROLS = ${JSON.stringify(
    {
      createInput: input.bindings.createInput,
      createSave: input.bindings.createSave,
      editOpen: input.bindings.editOpen,
      editInput: input.bindings.editInput,
      editSave: input.bindings.editSave,
      toggle: input.bindings.toggle,
      remove: input.bindings.remove,
      filter: input.bindings.filter,
    },
    null,
    2,
  )} as const;

export function validateName(value: string): string | null {
  return value.trim() ? null : ${JSON.stringify(`${input.primaryFieldLabel} is required.`)};
}
`;
}

function storageFile(): string {
  return `import {
  PRIMARY_FIELD_KEY,
  STORAGE_KEY,
  TOGGLE_FIELD_KEY,
} from "./simple-app-config";

export type SimpleRecord = {
  id: string;
  data: Record<string, string | boolean>;
};

export type StorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function loadRecords(): StorageResult<SimpleRecord[]> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ok: true, value: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Saved data is not a list.");
    const records = parsed.filter(isSimpleRecord);
    if (records.length !== parsed.length) throw new Error("Saved data is invalid.");
    return { ok: true, value: records };
  } catch {
    return { ok: false, error: "Saved items could not be loaded." };
  }
}

export function saveRecords(records: SimpleRecord[]): StorageResult<SimpleRecord[]> {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    return { ok: true, value: records };
  } catch {
    return { ok: false, error: "Items could not be saved." };
  }
}

export function createRecord(id: string, name: string): SimpleRecord {
  return {
    id,
    data: {
      [PRIMARY_FIELD_KEY]: name,
      ...(TOGGLE_FIELD_KEY ? { [TOGGLE_FIELD_KEY]: false } : {}),
    },
  };
}

export function recordName(record: SimpleRecord): string {
  const value = record.data[PRIMARY_FIELD_KEY];
  return typeof value === "string" ? value : "";
}

export function recordCompleted(record: SimpleRecord): boolean {
  return TOGGLE_FIELD_KEY ? record.data[TOGGLE_FIELD_KEY] === true : false;
}

function isSimpleRecord(value: unknown): value is SimpleRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    Boolean(record.data) &&
    typeof record.data === "object" &&
    typeof (record.data as Record<string, unknown>)[PRIMARY_FIELD_KEY] === "string" &&
    (!TOGGLE_FIELD_KEY ||
      typeof (record.data as Record<string, unknown>)[TOGGLE_FIELD_KEY] === "boolean")
  );
}
`;
}

function componentFile(): string {
  return `"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  APP_NAME,
  APP_PURPOSE,
  CONTROLS,
  ENTITY_KEY,
  ENTITY_LABEL,
  PRIMARY_FIELD_KEY,
  PRIMARY_FIELD_LABEL,
  TOGGLE_FIELD_KEY,
  validateName,
  type ContractControl,
} from "@/lib/simple-app-config";
import {
  loadRecords,
  createRecord,
  recordCompleted,
  recordName,
  saveRecords,
  type SimpleRecord,
} from "@/lib/simple-app-storage";

type Filter = "all" | "active" | "completed";

export default function SimpleLocalApp() {
  const [records, setRecords] = useState<SimpleRecord[]>([]);
  const [name, setName] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loaded = loadRecords();
    if (loaded.ok) setRecords(loaded.value);
    else setError(loaded.error);
    setIsLoading(false);
  }, []);

  const visibleRecords = useMemo(
    () =>
      records.filter((record) =>
        filter === "all"
          ? true
          : filter === "completed"
            ? recordCompleted(record)
            : !recordCompleted(record),
      ),
    [filter, records],
  );

  function persist(next: SimpleRecord[], success: string): boolean {
    const saved = saveRecords(next);
    if (!saved.ok) {
      setError(saved.error);
      return false;
    }
    setRecords(saved.value);
    setError("");
    setMessage(success);
    return true;
  }

  function addRecord(event: FormEvent) {
    event.preventDefault();
    const validation = validateName(name);
    if (validation) {
      setError(validation);
      return;
    }
    const record = createRecord(crypto.randomUUID(), name.trim());
    if (persist([...records, record], PRIMARY_FIELD_LABEL + " added.")) setName("");
  }

  function beginEdit(record: SimpleRecord) {
    setEditingId(record.id);
    setEditName(recordName(record));
    setError("");
    setMessage("");
  }

  function saveEdit(record: SimpleRecord) {
    const validation = validateName(editName);
    if (validation) {
      setError(validation);
      return;
    }
    const next = records.map((candidate) =>
      candidate.id === record.id
        ? {
            ...candidate,
            data: { ...candidate.data, [PRIMARY_FIELD_KEY]: editName.trim() },
          }
        : candidate,
    );
    if (persist(next, PRIMARY_FIELD_LABEL + " updated.")) setEditingId(null);
  }

  function toggleRecord(record: SimpleRecord) {
    persist(
      records.map((candidate) =>
        candidate.id === record.id
          ? {
              ...candidate,
              data: {
                ...candidate.data,
                ...(TOGGLE_FIELD_KEY
                  ? { [TOGGLE_FIELD_KEY]: !recordCompleted(candidate) }
                  : {}),
              },
            }
          : candidate,
      ),
      recordCompleted(record) ? "Item reopened." : "Item completed.",
    );
  }

  function removeRecord(record: SimpleRecord) {
    persist(
      records.filter((candidate) => candidate.id !== record.id),
      "Item deleted.",
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 text-slate-950">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 border-b border-slate-200 pb-5">
          <h1 className="text-3xl font-bold">{APP_NAME}</h1>
          <p className="mt-2 text-slate-600">{APP_PURPOSE}</p>
        </header>

        <form onSubmit={addRecord} className="flex flex-col gap-3 sm:flex-row">
          <label className="flex-1 text-sm font-medium text-slate-700">
            {PRIMARY_FIELD_LABEL}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label={CONTROLS.createInput.accessibleName}
              {...contractAttributes(CONTROLS.createInput)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2"
            />
          </label>
          <button
            type="submit"
            aria-label={CONTROLS.createSave.accessibleName}
            {...contractAttributes(CONTROLS.createSave)}
            className="self-end rounded-md bg-emerald-700 px-4 py-2 font-semibold text-white hover:bg-emerald-800"
          >
            {CONTROLS.createSave.accessibleName}
          </button>
        </form>

        {CONTROLS.filter && (
          <label className="mt-6 block max-w-xs text-sm font-medium text-slate-700">
            {CONTROLS.filter.accessibleName}
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as Filter)}
              aria-label={CONTROLS.filter.accessibleName}
              {...contractAttributes(CONTROLS.filter)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2"
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
            </select>
          </label>
        )}

        {error && <p role="alert" className="mt-4 text-sm font-medium text-red-700">{error}</p>}
        {message && <p role="status" className="mt-4 text-sm font-medium text-emerald-800">{message}</p>}

        <section className="mt-8" aria-labelledby="items-heading">
          <h2 id="items-heading" className="text-xl font-semibold">{ENTITY_LABEL}</h2>
          {isLoading ? (
            <p className="mt-4 text-slate-600">Loading saved items…</p>
          ) : visibleRecords.length === 0 ? (
            <p className="mt-4 rounded-md border border-dashed border-slate-300 bg-white p-6 text-slate-600">
              {records.length === 0 ? "No items yet. Add the first one above." : "No items match this filter."}
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
              {visibleRecords.map((record) => (
                <li key={record.id} data-vf-entity={ENTITY_KEY} data-vf-record={record.id} className="p-4">
                  {editingId === record.id ? (
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <span className="sr-only">{recordName(record)}</span>
                      <input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        aria-label={CONTROLS.editInput.accessibleName}
                        {...contractAttributes(CONTROLS.editInput)}
                        className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2"
                      />
                      <button type="button" onClick={() => saveEdit(record)} aria-label={CONTROLS.editSave.accessibleName} {...contractAttributes(CONTROLS.editSave)} className="rounded-md bg-emerald-700 px-3 py-2 text-white">
                        {CONTROLS.editSave.accessibleName}
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} className="rounded-md border border-slate-300 px-3 py-2">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      {CONTROLS.toggle && (
                        <input
                          type="checkbox"
                          checked={recordCompleted(record)}
                          onChange={() => toggleRecord(record)}
                          aria-label={CONTROLS.toggle.accessibleName}
                          {...contractAttributes(CONTROLS.toggle)}
                          className="h-5 w-5"
                        />
                      )}
                      <span className={"min-w-0 flex-1 break-words " + (recordCompleted(record) ? "text-slate-500 line-through" : "")}>
                        {recordName(record)}
                      </span>
                      <button type="button" onClick={() => beginEdit(record)} aria-label={CONTROLS.editOpen.accessibleName} {...contractAttributes(CONTROLS.editOpen)} className="rounded-md border border-slate-300 px-3 py-2">
                        {CONTROLS.editOpen.accessibleName}
                      </button>
                      <button type="button" onClick={() => removeRecord(record)} aria-label={CONTROLS.remove.accessibleName} {...contractAttributes(CONTROLS.remove)} className="rounded-md border border-red-200 px-3 py-2 text-red-700">
                        {CONTROLS.remove.accessibleName}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function contractAttributes(control: ContractControl) {
  return {
    "data-vf-workflow": control.workflowId,
    "data-vf-control": control.controlId,
  };
}
`;
}

function storageTestFile(): string {
  return `import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEY } from "./simple-app-config";
import { createRecord, loadRecords, saveRecords } from "./simple-app-storage";

describe("simple app storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips records and completion state", () => {
    const record = createRecord("one", "Milk");
    const saved = saveRecords([record]);
    expect(saved.ok).toBe(true);
    expect(loadRecords()).toEqual({
      ok: true,
      value: [record],
    });
  });

  it("rejects malformed saved data", () => {
    window.localStorage.setItem(STORAGE_KEY, "not json");
    expect(loadRecords()).toEqual({
      ok: false,
      error: "Saved items could not be loaded.",
    });
  });
});
`;
}

function componentTestFile(): string {
  return `import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import SimpleLocalApp from "./SimpleLocalApp";
import { CONTROLS, STORAGE_KEY } from "@/lib/simple-app-config";

describe("SimpleLocalApp", () => {
  beforeEach(() => window.localStorage.clear());

  it("validates, adds, edits, completes, filters, deletes, and restores records", async () => {
    const first = render(<SimpleLocalApp />);
    await screen.findByText(/No items yet/i);
    fireEvent.click(screen.getByRole("button", { name: CONTROLS.createSave.accessibleName }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(CONTROLS.createInput.accessibleName), { target: { value: "Milk" } });
    fireEvent.click(screen.getByRole("button", { name: CONTROLS.createSave.accessibleName }));
    expect(await screen.findByText("Milk")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: CONTROLS.editOpen.accessibleName }));
    fireEvent.change(screen.getByLabelText(CONTROLS.editInput.accessibleName), { target: { value: "Oat milk" } });
    fireEvent.click(screen.getByRole("button", { name: CONTROLS.editSave.accessibleName }));
    expect(await screen.findByText("Oat milk")).toBeInTheDocument();

    if (CONTROLS.toggle) {
      fireEvent.click(screen.getByRole("checkbox", { name: CONTROLS.toggle.accessibleName }));
    }
    if (CONTROLS.filter) {
      fireEvent.change(screen.getByLabelText(CONTROLS.filter.accessibleName), { target: { value: "active" } });
      expect(screen.queryByText("Oat milk")).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(CONTROLS.filter.accessibleName), { target: { value: "all" } });
    }

    first.unmount();
    render(<SimpleLocalApp />);
    expect(await screen.findByText("Oat milk")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: CONTROLS.remove.accessibleName }));
    await waitFor(() => expect(screen.queryByText("Oat milk")).not.toBeInTheDocument());
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([]);
  });
});
`;
}
