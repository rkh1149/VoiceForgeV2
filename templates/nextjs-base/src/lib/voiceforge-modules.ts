import { format, isValid, parseISO } from "date-fns";
import Papa from "papaparse";
import { z } from "zod";

export type SortDirection = "asc" | "desc";

export type ActivityEvent = {
  id: string;
  actor: string;
  action: string;
  subject: string;
  createdAt: string;
};

export type CommentEntry = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
};

export const nonEmptyText = z.string().trim().min(1, "Required");

export function searchRecords<T>(
  records: T[],
  query: string,
  fields: Array<(record: T) => unknown>,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return records;
  return records.filter((record) =>
    fields.some((field) => String(field(record) ?? "").toLowerCase().includes(needle)),
  );
}

export function filterRecords<T>(
  records: T[],
  predicates: Array<(record: T) => boolean>,
): T[] {
  return predicates.reduce(
    (current, predicate) => current.filter(predicate),
    records,
  );
}

export function sortRecords<T>(
  records: T[],
  getValue: (record: T) => string | number | boolean | Date | null | undefined,
  direction: SortDirection = "asc",
): T[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...records].sort((a, b) => {
    const left = comparableValue(getValue(a));
    const right = comparableValue(getValue(b));
    if (left < right) return -1 * multiplier;
    if (left > right) return 1 * multiplier;
    return 0;
  });
}

export function makeActivityEvent(input: {
  actor: string;
  action: string;
  subject: string;
  now?: Date;
}): ActivityEvent {
  return {
    id: crypto.randomUUID(),
    actor: input.actor,
    action: input.action,
    subject: input.subject,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export function makeComment(input: {
  author: string;
  body: string;
  now?: Date;
}): CommentEntry {
  return {
    id: crypto.randomUUID(),
    author: input.author,
    body: input.body.trim(),
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export function recordsToCsv<T extends Record<string, unknown>>(
  records: T[],
): string {
  return Papa.unparse(records);
}

export function csvToRecords<T extends Record<string, unknown>>(
  csv: string,
): { records: T[]; errors: string[] } {
  const result = Papa.parse<T>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  return {
    records: result.data,
    errors: result.errors.map((error) => error.message),
  };
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = "text/plain;charset=utf-8",
): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(url);
}

export function formatDateLabel(value: string | Date | null | undefined): string {
  if (!value) return "Not set";
  const date = value instanceof Date ? value : parseISO(value);
  return isValid(date) ? format(date, "MMM d, yyyy") : "Not set";
}

function comparableValue(
  value: string | number | boolean | Date | null | undefined,
): string | number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return String(value ?? "").toLowerCase();
}
