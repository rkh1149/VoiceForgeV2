/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * Typed browser client for generated apps that use VoiceForge platform data.
 * It talks only to the same-origin /api/data route; app secrets remain on
 * the server.
 */

export type PlatformRecord<TData extends object> = {
  id: string;
  appId: string;
  entityKey: string;
  ownerId: string | null;
  data: TData;
  version: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformEntitySchema = {
  id: string;
  appId: string;
  entityKey: string;
  displayName: string;
  definition: unknown;
  createdAt: string;
  updatedAt: string;
};

export type PlatformRecordFilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "in"
  | "empty"
  | "not_empty"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between";

export type PlatformRecordQueryFilter = {
  fieldKey: string;
  operator: PlatformRecordFilterOperator;
  value?: unknown;
  valueTo?: unknown;
};

export type PlatformRecordQuerySort = {
  fieldKey: string;
  direction: "asc" | "desc";
};

export type PlatformRecordQuery = {
  query?: string;
  fields?: string[];
  filters?: PlatformRecordQueryFilter[];
  sort?: PlatformRecordQuerySort[];
  limit?: number;
  offset?: number;
};

export type PlatformRecordSearchResult<TData extends object> = {
  records: Array<PlatformRecord<TData>>;
  total: number;
  offset: number;
  limit: number;
};

export type PlatformRecordSearchConfig = {
  id: string;
  appId: string;
  entityKey: string;
  indexedFields: string[];
  defaultSort: PlatformRecordQuerySort[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformSavedRecordFilter = {
  id: string;
  appId: string;
  entityKey: string;
  name: string;
  definition: Omit<PlatformRecordQuery, "limit" | "offset">;
  visibility: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformRecordReportInput = Omit<
  PlatformRecordQuery,
  "limit" | "offset"
> & {
  groupByFieldKey?: string;
  metric?: "count" | "sum" | "average";
  metricFieldKey?: string;
  limit?: number;
};

export type PlatformRecordReport = {
  totalRecords: number;
  groupByFieldKey: string | null;
  metric: "count" | "sum" | "average";
  metricFieldKey: string | null;
  rows: Array<{
    label: string;
    count: number;
    sum: number | null;
    average: number | null;
  }>;
  generatedAt: string;
};

export type PlatformRecordCsvExport = {
  fileName: string;
  contentType: "text/csv";
  csv: string;
  rowCount: number;
};

export type PlatformSession = {
  status: "anonymous" | "signed_in" | "signed_out" | "no_access";
  user: {
    id: string;
    email: string;
    displayName: string | null;
  } | null;
  role: "owner" | "editor" | "viewer" | null;
  canWrite: boolean;
  canManage: boolean;
  requireSignIn: boolean;
  loginUrl: string;
  error?: string;
};

type RequestBody =
  | { action: "session"; sessionToken?: string; returnTo: string }
  | { action: "listSchemas" }
  | {
      action: "listRecords";
      entityKey: string;
      includeDeleted?: boolean;
      limit?: number;
    }
  | {
      action: "searchRecords";
      entityKey: string;
      includeDeleted?: boolean;
      query?: PlatformRecordQuery;
    }
  | { action: "getRecord"; recordId: string }
  | { action: "createRecord"; entityKey: string; data: object }
  | { action: "updateRecord"; recordId: string; data: object }
  | { action: "deleteRecord"; recordId: string }
  | { action: "listSearchConfigs"; entityKey?: string }
  | { action: "listSavedFilters"; entityKey?: string }
  | {
      action: "saveFilter";
      entityKey: string;
      name: string;
      definition: Omit<PlatformRecordQuery, "limit" | "offset">;
    }
  | { action: "deleteSavedFilter"; filterId: string }
  | { action: "runReport"; entityKey: string; report: PlatformRecordReportInput }
  | {
      action: "exportRecordsCsv";
      entityKey: string;
      query?: PlatformRecordQuery;
      fileName?: string;
    };

const SESSION_STORAGE_KEY = "voiceforge.platformSessionToken";

async function request<TResponse>(body: RequestBody): Promise<TResponse> {
  const sessionToken =
    body.action === "session" ? body.sessionToken : getStoredSessionToken();
  const res = await fetch("/api/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, sessionToken }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & TResponse;
  if (!res.ok) {
    throw new Error(payload.error ?? "Platform data request failed.");
  }
  return payload;
}

export function consumePlatformSessionFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const token = url.searchParams.get("vf_session");
  const error = url.searchParams.get("vf_error");
  if (token) {
    window.localStorage.setItem(SESSION_STORAGE_KEY, token);
  }
  if (token || error) {
    url.searchParams.delete("vf_session");
    url.searchParams.delete("vf_error");
    window.history.replaceState({}, "", url.toString());
  }
  return error;
}

export function getStoredSessionToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(SESSION_STORAGE_KEY) ?? undefined;
}

export function signOutPlatformSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

export async function getPlatformSession(): Promise<PlatformSession> {
  const redirectedError = consumePlatformSessionFromUrl();
  const returnTo =
    typeof window === "undefined" ? "" : window.location.href.toString();
  const result = await request<{ session: PlatformSession }>({
    action: "session",
    sessionToken: getStoredSessionToken(),
    returnTo,
  });
  if (redirectedError === "no_access") {
    return {
      ...result.session,
      status: "no_access",
      canWrite: false,
      canManage: false,
      error: "You do not have access to this app.",
    };
  }
  if (result.session.status === "anonymous") {
    return {
      ...result.session,
      requireSignIn: false,
      loginUrl: result.session.loginUrl,
    };
  }
  return result.session;
}

export function signInToPlatform(session: PlatformSession): void {
  if (typeof window === "undefined") return;
  window.location.href = session.loginUrl;
}

export async function listPlatformEntitySchemas(): Promise<
  PlatformEntitySchema[]
> {
  const result = await request<{ entities: PlatformEntitySchema[] }>({
    action: "listSchemas",
  });
  return result.entities;
}

export async function listPlatformRecords<TData extends object>(
  entityKey: string,
  options: { includeDeleted?: boolean; limit?: number } = {},
): Promise<Array<PlatformRecord<TData>>> {
  const result = await request<{ records: Array<PlatformRecord<TData>> }>({
    action: "listRecords",
    entityKey,
    ...options,
  });
  return result.records;
}

export async function searchPlatformRecords<TData extends object>(
  entityKey: string,
  query: PlatformRecordQuery = {},
  options: { includeDeleted?: boolean } = {},
): Promise<PlatformRecordSearchResult<TData>> {
  return request<PlatformRecordSearchResult<TData>>({
    action: "searchRecords",
    entityKey,
    query,
    ...options,
  });
}

export async function listPlatformRecordSearchConfigs(
  entityKey?: string,
): Promise<PlatformRecordSearchConfig[]> {
  const result = await request<{ configs: PlatformRecordSearchConfig[] }>({
    action: "listSearchConfigs",
    entityKey,
  });
  return result.configs;
}

export async function listPlatformSavedFilters(
  entityKey?: string,
): Promise<PlatformSavedRecordFilter[]> {
  const result = await request<{ filters: PlatformSavedRecordFilter[] }>({
    action: "listSavedFilters",
    entityKey,
  });
  return result.filters;
}

export async function savePlatformRecordFilter(
  entityKey: string,
  name: string,
  definition: Omit<PlatformRecordQuery, "limit" | "offset">,
): Promise<PlatformSavedRecordFilter> {
  const result = await request<{ filter: PlatformSavedRecordFilter }>({
    action: "saveFilter",
    entityKey,
    name,
    definition,
  });
  return result.filter;
}

export async function deletePlatformSavedFilter(
  filterId: string,
): Promise<PlatformSavedRecordFilter> {
  const result = await request<{ filter: PlatformSavedRecordFilter }>({
    action: "deleteSavedFilter",
    filterId,
  });
  return result.filter;
}

export async function runPlatformRecordReport(
  entityKey: string,
  report: PlatformRecordReportInput,
): Promise<PlatformRecordReport> {
  const result = await request<{ report: PlatformRecordReport }>({
    action: "runReport",
    entityKey,
    report,
  });
  return result.report;
}

export async function exportPlatformRecordsCsv(
  entityKey: string,
  options: { query?: PlatformRecordQuery; fileName?: string } = {},
): Promise<PlatformRecordCsvExport> {
  const result = await request<{ export: PlatformRecordCsvExport }>({
    action: "exportRecordsCsv",
    entityKey,
    ...options,
  });
  return result.export;
}

export async function getPlatformRecord<TData extends object>(
  recordId: string,
): Promise<PlatformRecord<TData>> {
  const result = await request<{ record: PlatformRecord<TData> }>({
    action: "getRecord",
    recordId,
  });
  return result.record;
}

export async function createPlatformRecord<TData extends object>(
  entityKey: string,
  data: TData,
): Promise<PlatformRecord<TData>> {
  const result = await request<{ record: PlatformRecord<TData> }>({
    action: "createRecord",
    entityKey,
    data,
  });
  return result.record;
}

export async function updatePlatformRecord<TData extends object>(
  recordId: string,
  data: TData,
): Promise<PlatformRecord<TData>> {
  const result = await request<{ record: PlatformRecord<TData> }>({
    action: "updateRecord",
    recordId,
    data,
  });
  return result.record;
}

export async function deletePlatformRecord<TData extends object>(
  recordId: string,
): Promise<PlatformRecord<TData>> {
  const result = await request<{ record: PlatformRecord<TData> }>({
    action: "deleteRecord",
    recordId,
  });
  return result.record;
}
