import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  appFiles,
  appRecordEvents,
  appRecords,
  type AppFile,
  type User,
} from "../../db/schema";
import {
  assertCanReadAppData,
  assertCanWriteAppData,
  PlatformDataError,
} from "./data";

type Database = ReturnType<typeof getDb>;
type PlatformFileUser = Pick<User, "id" | "role">;

export type PlatformFileMetadata = Omit<AppFile, "dataBase64" | "storageKey">;

export type PlatformFileDownload = {
  file: PlatformFileMetadata;
  dataBase64: string;
};

export const PLATFORM_FILES_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const PLATFORM_FILES_MAX_FILES_PER_APP = 250;
export const PLATFORM_FILES_MAX_TOTAL_BYTES_PER_APP = 25 * 1024 * 1024;
export const PLATFORM_FILES_RATE_LIMIT_WINDOW_MS = 60_000;
export const PLATFORM_FILES_RATE_LIMIT_MAX_REQUESTS = 60;

export const PLATFORM_FILES_ALLOWED_CONTENT_TYPES = new Set([
  "application/json",
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/plain",
]);

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export function consumePlatformFileRateLimit(
  key: string,
  now = Date.now(),
): { remaining: number; resetAt: number } {
  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + PLATFORM_FILES_RATE_LIMIT_WINDOW_MS;
    rateLimitBuckets.set(key, { count: 1, resetAt });
    return {
      remaining: PLATFORM_FILES_RATE_LIMIT_MAX_REQUESTS - 1,
      resetAt,
    };
  }
  if (existing.count >= PLATFORM_FILES_RATE_LIMIT_MAX_REQUESTS) {
    throw new PlatformDataError(
      429,
      "rate_limited",
      "Too many platform file requests. Please wait a moment and try again.",
      { resetAt: new Date(existing.resetAt).toISOString() },
    );
  }
  existing.count += 1;
  return {
    remaining: PLATFORM_FILES_RATE_LIMIT_MAX_REQUESTS - existing.count,
    resetAt: existing.resetAt,
  };
}

export function resetPlatformFileRateLimitsForTests(): void {
  rateLimitBuckets.clear();
}

export function validatePlatformFileUpload(input: {
  fileName: string;
  contentType: string;
  dataBase64: string;
}): {
  fileName: string;
  contentType: string;
  dataBase64: string;
  sizeBytes: number;
} {
  const fileName = normalizeFileName(input.fileName);
  const contentType = normalizeContentType(input.contentType);
  const dataBase64 = normalizeBase64(input.dataBase64);
  const sizeBytes = Buffer.byteLength(Buffer.from(dataBase64, "base64"));

  if (!PLATFORM_FILES_ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new PlatformDataError(
      400,
      "unsupported_file_type",
      `Files of type ${contentType || "unknown"} are not allowed.`,
    );
  }
  if (sizeBytes < 1) {
    throw new PlatformDataError(
      400,
      "empty_file",
      "Uploaded files must not be empty.",
    );
  }
  if (sizeBytes > PLATFORM_FILES_MAX_FILE_BYTES) {
    throw new PlatformDataError(
      413,
      "file_too_large",
      `File is too large. Limit is ${formatBytes(PLATFORM_FILES_MAX_FILE_BYTES)}.`,
    );
  }

  return { fileName, contentType, dataBase64, sizeBytes };
}

export async function uploadPlatformFile(
  db: Database,
  input: {
    appId: string;
    recordId?: string;
    user: PlatformFileUser;
    fileName: string;
    contentType: string;
    dataBase64: string;
  },
): Promise<PlatformFileMetadata> {
  await assertCanWriteAppData(db, input.appId, input.user);
  if (input.recordId) {
    await assertRecordBelongsToApp(db, {
      appId: input.appId,
      recordId: input.recordId,
    });
  }

  const upload = validatePlatformFileUpload(input);
  const usage = await getAppFileUsage(db, input.appId);
  if (usage.fileCount >= PLATFORM_FILES_MAX_FILES_PER_APP) {
    throw new PlatformDataError(
      409,
      "file_count_quota_exceeded",
      `This app has reached the limit of ${PLATFORM_FILES_MAX_FILES_PER_APP} files.`,
    );
  }
  if (
    usage.totalBytes + upload.sizeBytes >
    PLATFORM_FILES_MAX_TOTAL_BYTES_PER_APP
  ) {
    throw new PlatformDataError(
      409,
      "file_storage_quota_exceeded",
      `This app has reached the file storage limit of ${formatBytes(
        PLATFORM_FILES_MAX_TOTAL_BYTES_PER_APP,
      )}.`,
    );
  }

  const storageKey = `${input.appId}/${crypto.randomUUID()}-${upload.fileName}`;
  const [file] = await db
    .insert(appFiles)
    .values({
      appId: input.appId,
      recordId: input.recordId,
      ownerId: input.user.id,
      fileName: upload.fileName,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      storageProvider: "neon",
      storageKey,
      dataBase64: upload.dataBase64,
    })
    .returning();

  await db.insert(appRecordEvents).values({
    appId: input.appId,
    recordId: input.recordId,
    userId: input.user.id,
    eventType: "file_upload",
    payload: {
      fileId: file.id,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    },
  });

  return toPlatformFileMetadata(file);
}

export async function listPlatformFiles(
  db: Database,
  input: {
    appId: string;
    recordId?: string;
    user: PlatformFileUser;
  },
): Promise<PlatformFileMetadata[]> {
  await assertCanReadAppData(db, input.appId, input.user);
  const filters = [eq(appFiles.appId, input.appId), isNull(appFiles.deletedAt)];
  if (input.recordId) filters.push(eq(appFiles.recordId, input.recordId));

  const files = await db
    .select()
    .from(appFiles)
    .where(and(...filters))
    .orderBy(desc(appFiles.createdAt));
  return files.map(toPlatformFileMetadata);
}

export async function downloadPlatformFile(
  db: Database,
  input: { fileId: string; user: PlatformFileUser },
): Promise<PlatformFileDownload> {
  const file = await getLiveFile(db, input.fileId);
  await assertCanReadAppData(db, file.appId, input.user);
  return {
    file: toPlatformFileMetadata(file),
    dataBase64: file.dataBase64,
  };
}

export async function deletePlatformFile(
  db: Database,
  input: { fileId: string; user: PlatformFileUser },
): Promise<PlatformFileMetadata> {
  const file = await getLiveFile(db, input.fileId);
  await assertCanWriteAppData(db, file.appId, input.user);
  const now = new Date();
  const [deleted] = await db
    .update(appFiles)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(appFiles.id, file.id))
    .returning();

  await db.insert(appRecordEvents).values({
    appId: file.appId,
    recordId: file.recordId,
    userId: input.user.id,
    eventType: "file_delete",
    payload: {
      fileId: file.id,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    },
  });

  return toPlatformFileMetadata(deleted);
}

export function toPlatformFileMetadata(file: AppFile): PlatformFileMetadata {
  return {
    id: file.id,
    appId: file.appId,
    recordId: file.recordId,
    ownerId: file.ownerId,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    storageProvider: file.storageProvider,
    deletedAt: file.deletedAt,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

async function getLiveFile(db: Database, fileId: string): Promise<AppFile> {
  const [file] = await db
    .select()
    .from(appFiles)
    .where(and(eq(appFiles.id, fileId), isNull(appFiles.deletedAt)))
    .limit(1);
  if (!file) {
    throw new PlatformDataError(404, "file_not_found", "File not found.");
  }
  return file;
}

async function assertRecordBelongsToApp(
  db: Database,
  input: { appId: string; recordId: string },
): Promise<void> {
  const [record] = await db
    .select({ id: appRecords.id })
    .from(appRecords)
    .where(
      and(
        eq(appRecords.id, input.recordId),
        eq(appRecords.appId, input.appId),
        isNull(appRecords.deletedAt),
      ),
    )
    .limit(1);
  if (!record) {
    throw new PlatformDataError(
      404,
      "record_not_found",
      "The file must be attached to an existing record in this app.",
    );
  }
}

async function getAppFileUsage(
  db: Database,
  appId: string,
): Promise<{ fileCount: number; totalBytes: number }> {
  const [usage] = await db
    .select({
      fileCount: count(),
      totalBytes: sql<string>`coalesce(sum(${appFiles.sizeBytes}), 0)`,
    })
    .from(appFiles)
    .where(and(eq(appFiles.appId, appId), isNull(appFiles.deletedAt)));
  return {
    fileCount: Number(usage?.fileCount ?? 0),
    totalBytes: Number(usage?.totalBytes ?? 0),
  };
}

function normalizeFileName(value: string): string {
  const fileName = value
    .trim()
    .replace(/[/\\]/g, "-")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return fileName || "upload";
}

function normalizeContentType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function normalizeBase64(value: string): string {
  const trimmed = value.trim();
  const payload =
    trimmed.startsWith("data:") && trimmed.includes(",")
      ? trimmed.slice(trimmed.indexOf(",") + 1)
      : trimmed;
  const clean = payload.replace(/\s+/g, "");
  if (
    !clean ||
    clean.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)
  ) {
    throw new PlatformDataError(
      400,
      "invalid_file_payload",
      "File payload must be valid base64.",
    );
  }
  return Buffer.from(clean, "base64").toString("base64");
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} bytes`;
}
