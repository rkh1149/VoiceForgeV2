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

type RequestBody =
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

async function request<TResponse>(body: RequestBody): Promise<TResponse> {
  const res = await fetch("/api/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & TResponse;
  if (!res.ok) {
    throw new Error(payload.error ?? "Platform data request failed.");
  }
  return payload;
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
