import { z } from "zod";
import type { AppRecord } from "@/db/schema";
import { type JsonObject, type JsonValue } from "./data";

export const PLATFORM_RECORD_QUERY_MAX_RESPONSE_RECORDS = 500;
export const PLATFORM_RECORD_EXPORT_MAX_RECORDS = 1_000;
export const PLATFORM_RECORD_REPORT_MAX_GROUPS = 100;

export const recordQueryOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "in",
  "empty",
  "not_empty",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
]);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const recordQueryFilterSchema = z
  .object({
    fieldKey: z.string().min(1).max(80),
    operator: recordQueryOperatorSchema,
    value: jsonValueSchema.optional(),
    valueTo: jsonValueSchema.optional(),
  })
  .strict();

export const recordQuerySortSchema = z
  .object({
    fieldKey: z.string().min(1).max(80),
    direction: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

export const platformRecordQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    fields: z.array(z.string().min(1).max(80)).max(50).default([]),
    filters: z.array(recordQueryFilterSchema).max(25).default([]),
    sort: z.array(recordQuerySortSchema).max(5).default([]),
    limit: z.number().int().min(1).max(PLATFORM_RECORD_QUERY_MAX_RESPONSE_RECORDS).optional(),
    offset: z.number().int().min(0).max(5_000).default(0),
  })
  .strict();

export const savedRecordFilterDefinitionSchema = platformRecordQuerySchema
  .omit({ limit: true, offset: true })
  .strict();

export const recordReportInputSchema = savedRecordFilterDefinitionSchema
  .extend({
    groupByFieldKey: z.string().min(1).max(80).optional(),
    metric: z.enum(["count", "sum", "average"]).default("count"),
    metricFieldKey: z.string().min(1).max(80).optional(),
    limit: z.number().int().min(1).max(PLATFORM_RECORD_REPORT_MAX_GROUPS).optional(),
  })
  .strict();

export type RecordQueryFilter = z.infer<typeof recordQueryFilterSchema>;
export type RecordQuerySort = z.infer<typeof recordQuerySortSchema>;
export type PlatformRecordQuery = z.infer<typeof platformRecordQuerySchema>;
export type SavedRecordFilterDefinition = z.infer<
  typeof savedRecordFilterDefinitionSchema
>;
export type RecordReportInput = z.infer<typeof recordReportInputSchema>;

export type SearchableRecord = Pick<
  AppRecord,
  "id" | "data" | "createdAt" | "updatedAt" | "deletedAt"
>;

export type RecordSearchResult<TRecord extends SearchableRecord> = {
  records: TRecord[];
  total: number;
  offset: number;
  limit: number;
};

export type RecordReportRow = {
  label: string;
  count: number;
  sum: number | null;
  average: number | null;
};

export type RecordReportResult = {
  totalRecords: number;
  groupByFieldKey: string | null;
  metric: "count" | "sum" | "average";
  metricFieldKey: string | null;
  rows: RecordReportRow[];
  generatedAt: string;
};

export function normalizeRecordFieldKey(value: string): string {
  const key = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return key || "field";
}

export function normalizeRecordQuery(input: unknown): PlatformRecordQuery {
  const parsed = platformRecordQuerySchema.parse(input ?? {});
  return {
    ...parsed,
    fields: normalizeFieldList(parsed.fields),
    filters: parsed.filters.map((filter) => ({
      ...filter,
      fieldKey: normalizeRecordFieldKey(filter.fieldKey),
    })),
    sort: parsed.sort.map((sort) => ({
      ...sort,
      fieldKey: normalizeRecordFieldKey(sort.fieldKey),
    })),
    query: parsed.query?.trim() || undefined,
    limit: parsed.limit ?? PLATFORM_RECORD_QUERY_MAX_RESPONSE_RECORDS,
  };
}

export function normalizeSavedFilterDefinition(
  input: unknown,
): SavedRecordFilterDefinition {
  const parsed = savedRecordFilterDefinitionSchema.parse(input ?? {});
  const query = normalizeRecordQuery(parsed);
  return {
    query: query.query,
    fields: query.fields,
    filters: query.filters,
    sort: query.sort,
  };
}

export function normalizeRecordReportInput(input: unknown): RecordReportInput {
  const parsed = recordReportInputSchema.parse(input ?? {});
  const query = normalizeSavedFilterDefinition({
    query: parsed.query,
    fields: parsed.fields,
    filters: parsed.filters,
    sort: parsed.sort,
  });
  const metric = parsed.metric ?? "count";
  return {
    ...query,
    groupByFieldKey: parsed.groupByFieldKey
      ? normalizeRecordFieldKey(parsed.groupByFieldKey)
      : undefined,
    metric,
    metricFieldKey: parsed.metricFieldKey
      ? normalizeRecordFieldKey(parsed.metricFieldKey)
      : undefined,
    limit: parsed.limit ?? PLATFORM_RECORD_REPORT_MAX_GROUPS,
  };
}

export function normalizeFieldList(fields: string[]): string[] {
  return [...new Set(fields.map(normalizeRecordFieldKey))].slice(0, 50);
}

export function queryPlatformRecords<TRecord extends SearchableRecord>(
  records: TRecord[],
  input: unknown,
  defaultFields: string[] = [],
): RecordSearchResult<TRecord> {
  const query = normalizeRecordQuery(input);
  const searchFields = query.fields.length > 0 ? query.fields : defaultFields;
  const filtered = records.filter((record) =>
    matchesRecordQuery(record, query, searchFields),
  );
  const sorted = sortRecords(filtered, query.sort);
  const limit = Math.min(
    Math.max(query.limit ?? PLATFORM_RECORD_QUERY_MAX_RESPONSE_RECORDS, 1),
    PLATFORM_RECORD_QUERY_MAX_RESPONSE_RECORDS,
  );
  const offset = Math.min(query.offset, sorted.length);
  return {
    records: sorted.slice(offset, offset + limit),
    total: sorted.length,
    offset,
    limit,
  };
}

export function buildPlatformRecordReport<TRecord extends SearchableRecord>(
  records: TRecord[],
  input: unknown,
  defaultFields: string[] = [],
): RecordReportResult {
  const report = normalizeRecordReportInput(input);
  const query = {
    query: report.query,
    fields: report.fields,
    filters: report.filters,
    sort: [],
    limit: PLATFORM_RECORD_QUERY_MAX_RESPONSE_RECORDS,
    offset: 0,
  };
  const matchingRecords = records.filter((record) =>
    matchesRecordQuery(
      record,
      normalizeRecordQuery(query),
      report.fields.length > 0 ? report.fields : defaultFields,
    ),
  );
  const groups = new Map<string, { count: number; sum: number }>();
  for (const record of matchingRecords) {
    const label = report.groupByFieldKey
      ? recordValueLabel(valueForField(record, report.groupByFieldKey))
      : "All records";
    const current = groups.get(label) ?? { count: 0, sum: 0 };
    const metricValue =
      report.metricFieldKey && report.metric !== "count"
        ? numberValue(valueForField(record, report.metricFieldKey))
        : null;
    groups.set(label, {
      count: current.count + 1,
      sum: current.sum + (metricValue ?? 0),
    });
  }
  const rows = [...groups.entries()]
    .map(([label, value]) => ({
      label,
      count: value.count,
      sum: report.metric === "count" ? null : value.sum,
      average:
        report.metric === "average" && value.count > 0
          ? value.sum / value.count
          : null,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, Math.min(report.limit ?? PLATFORM_RECORD_REPORT_MAX_GROUPS, PLATFORM_RECORD_REPORT_MAX_GROUPS));
  return {
    totalRecords: matchingRecords.length,
    groupByFieldKey: report.groupByFieldKey ?? null,
    metric: report.metric,
    metricFieldKey: report.metricFieldKey ?? null,
    rows,
    generatedAt: new Date().toISOString(),
  };
}

export function platformRecordsToCsv<TRecord extends SearchableRecord>(
  records: TRecord[],
  fields: string[] = [],
): string {
  const dataFields =
    fields.length > 0 ? normalizeFieldList(fields) : collectRecordFieldKeys(records);
  const headers = ["id", "createdAt", "updatedAt", ...dataFields];
  const rows = records.slice(0, PLATFORM_RECORD_EXPORT_MAX_RECORDS).map((record) =>
    [
      record.id,
      toIsoString(record.createdAt),
      toIsoString(record.updatedAt),
      ...dataFields.map((field) => csvCellValue(valueForField(record, field))),
    ].map(escapeCsvCell),
  );
  return [headers.map(escapeCsvCell), ...rows]
    .map((row) => row.join(","))
    .join("\n");
}

function matchesRecordQuery<TRecord extends SearchableRecord>(
  record: TRecord,
  query: PlatformRecordQuery,
  defaultFields: string[],
): boolean {
  if (record.deletedAt) return false;
  if (query.query) {
    const term = query.query.toLowerCase();
    const fields = query.fields.length > 0 ? query.fields : defaultFields;
    if (fields.length > 0) {
      const matchedField = fields.some((field) =>
        recordValueText(valueForField(record, field)).toLowerCase().includes(term),
      );
      if (!matchedField) return false;
    } else if (!recordValueText(record.data).toLowerCase().includes(term)) {
      return false;
    }
  }
  return query.filters.every((filter) => matchesFilter(record, filter));
}

function matchesFilter<TRecord extends SearchableRecord>(
  record: TRecord,
  filter: RecordQueryFilter,
): boolean {
  const value = valueForField(record, filter.fieldKey);
  switch (filter.operator) {
    case "equals":
      return compareValue(value, filter.value) === 0;
    case "not_equals":
      return compareValue(value, filter.value) !== 0;
    case "contains":
      return recordValueText(value)
        .toLowerCase()
        .includes(recordValueText(filter.value).toLowerCase());
    case "not_contains":
      return !recordValueText(value)
        .toLowerCase()
        .includes(recordValueText(filter.value).toLowerCase());
    case "starts_with":
      return recordValueText(value)
        .toLowerCase()
        .startsWith(recordValueText(filter.value).toLowerCase());
    case "in": {
      const options = Array.isArray(filter.value) ? filter.value : [filter.value];
      return options.some((option) => compareValue(value, option) === 0);
    }
    case "empty":
      return isEmptyValue(value);
    case "not_empty":
      return !isEmptyValue(value);
    case "gt":
      return compareValue(value, filter.value) > 0;
    case "gte":
      return compareValue(value, filter.value) >= 0;
    case "lt":
      return compareValue(value, filter.value) < 0;
    case "lte":
      return compareValue(value, filter.value) <= 0;
    case "between":
      return (
        compareValue(value, filter.value) >= 0 &&
        compareValue(value, filter.valueTo) <= 0
      );
  }
}

function sortRecords<TRecord extends SearchableRecord>(
  records: TRecord[],
  sort: RecordQuerySort[],
): TRecord[] {
  const sortSpec =
    sort.length > 0
      ? sort
      : [{ fieldKey: "updatedAt", direction: "desc" as const }];
  return [...records].sort((left, right) => {
    for (const item of sortSpec) {
      const leftValue = valueForField(left, item.fieldKey);
      const rightValue = valueForField(right, item.fieldKey);
      const comparison = compareValue(leftValue, rightValue);
      if (comparison !== 0) return item.direction === "desc" ? -comparison : comparison;
    }
    return left.id.localeCompare(right.id);
  });
}

function valueForField(record: SearchableRecord, fieldKey: string): unknown {
  if (fieldKey === "id") return record.id;
  if (fieldKey === "createdAt" || fieldKey === "created_at") return record.createdAt;
  if (fieldKey === "updatedAt" || fieldKey === "updated_at") return record.updatedAt;
  const data = isJsonObject(record.data) ? record.data : {};
  return data[normalizeRecordFieldKey(fieldKey)];
}

function compareValue(left: unknown, right: unknown): number {
  if (isEmptyValue(left) && isEmptyValue(right)) return 0;
  if (isEmptyValue(left)) return -1;
  if (isEmptyValue(right)) return 1;
  const leftNumber = numberValue(left);
  const rightNumber = numberValue(right);
  if (leftNumber !== null && rightNumber !== null) {
    return Math.sign(leftNumber - rightNumber);
  }
  const leftDate = dateValue(left);
  const rightDate = dateValue(right);
  if (leftDate !== null && rightDate !== null) return Math.sign(leftDate - rightDate);
  return recordValueText(left).localeCompare(recordValueText(right), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function recordValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(recordValueText).join(" ");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function recordValueLabel(value: unknown): string {
  const text = recordValueText(value).trim();
  return text || "(blank)";
}

function csvCellValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(recordValueText).join("; ");
  return recordValueText(value);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dateValue(value: unknown): number | null {
  const text = recordValueText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function collectRecordFieldKeys(records: SearchableRecord[]): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    if (!isJsonObject(record.data)) continue;
    for (const key of Object.keys(record.data)) keys.add(key);
  }
  return [...keys].sort();
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function escapeCsvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
