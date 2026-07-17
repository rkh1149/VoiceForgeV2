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
  | { action: "getRecord"; recordId: string }
  | { action: "createRecord"; entityKey: string; data: object }
  | { action: "updateRecord"; recordId: string; data: object }
  | { action: "deleteRecord"; recordId: string };

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
