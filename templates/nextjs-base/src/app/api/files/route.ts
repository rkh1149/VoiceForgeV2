import { NextResponse } from "next/server";

/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * Browser code in generated apps calls this same-origin route. This route
 * adds the server-only VoiceForge app token and forwards file operations to
 * VoiceForge V2's platform file service. The token is never sent to the
 * browser.
 */

type FileAction = "listFiles" | "uploadFile" | "downloadFile" | "deleteFile";

type FileBody = {
  action?: unknown;
  recordId?: unknown;
  fileId?: unknown;
  fileName?: unknown;
  contentType?: unknown;
  dataBase64?: unknown;
  sessionToken?: unknown;
};

type LocalFile = {
  id: string;
  appId: string;
  recordId: string | null;
  ownerId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  storageProvider: string;
  dataBase64: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type LocalFileMetadata = Omit<LocalFile, "dataBase64">;

const ACTIONS = new Set<FileAction>([
  "listFiles",
  "uploadFile",
  "downloadFile",
  "deleteFile",
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_APP = 250;
const MAX_TOTAL_BYTES_PER_APP = 25 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
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

const globalStore = globalThis as typeof globalThis & {
  __voiceforgeLocalFiles?: Map<string, LocalFile>;
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as FileBody | null;
  if (!body || typeof body.action !== "string" || !ACTIONS.has(body.action as FileAction)) {
    return NextResponse.json({ error: "Invalid file action." }, { status: 400 });
  }

  if (process.env.VOICEFORGE_DATA_LOCAL_FALLBACK === "1") {
    return handleLocalFiles(body as FileBody & { action: FileAction });
  }

  const base = process.env.VOICEFORGE_PUBLIC_URL?.replace(/\/$/, "");
  const token = process.env.VOICEFORGE_APP_TOKEN;
  if (!base || !token) {
    return NextResponse.json(
      { error: "Platform files are not enabled for this app." },
      { status: 503 },
    );
  }
  const requireSession = process.env.VOICEFORGE_REQUIRE_SIGN_IN === "1";
  const sharingModel = normalizeSharingModel(process.env.VOICEFORGE_SHARING_MODEL);
  const sessionToken =
    typeof body.sessionToken === "string" ? body.sessionToken : undefined;

  const platformRes = await fetch(`${base}/api/platform-files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      token,
      sessionToken,
      requireSession,
      sharingModel,
    }),
  }).catch(() => null);

  if (!platformRes) {
    return NextResponse.json(
      { error: "Platform files are unavailable right now." },
      { status: 502 },
    );
  }

  const text = await platformRes.text();
  return new Response(text, {
    status: platformRes.status,
    headers: {
      "Content-Type":
        platformRes.headers.get("content-type") ?? "application/json",
    },
  });
}

function handleLocalFiles(body: FileBody & { action: FileAction }) {
  const files = getLocalFiles();
  const now = new Date().toISOString();

  switch (body.action) {
    case "listFiles": {
      const recordId = typeof body.recordId === "string" ? body.recordId : undefined;
      const result = [...files.values()]
        .filter(
          (file) =>
            !file.deletedAt && (!recordId || file.recordId === recordId),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(toLocalFileMetadata);
      return NextResponse.json({ files: result });
    }
    case "uploadFile": {
      if (
        typeof body.fileName !== "string" ||
        typeof body.contentType !== "string" ||
        typeof body.dataBase64 !== "string"
      ) {
        return localPlatformError(
          400,
          "invalid_upload",
          "fileName, contentType, and dataBase64 are required.",
        );
      }
      const validation = validateLocalUpload({
        fileName: body.fileName,
        contentType: body.contentType,
        dataBase64: body.dataBase64,
      });
      if (!validation.ok) {
        return localPlatformError(
          validation.status,
          validation.code,
          validation.error,
        );
      }

      const activeFiles = [...files.values()].filter((file) => !file.deletedAt);
      const usedBytes = activeFiles.reduce(
        (sum, file) => sum + file.sizeBytes,
        0,
      );
      if (activeFiles.length >= MAX_FILES_PER_APP) {
        return localPlatformError(
          409,
          "file_count_quota_exceeded",
          `This app has reached the limit of ${MAX_FILES_PER_APP} files.`,
        );
      }
      if (usedBytes + validation.upload.sizeBytes > MAX_TOTAL_BYTES_PER_APP) {
        return localPlatformError(
          409,
          "file_storage_quota_exceeded",
          "This app has reached the file storage limit.",
        );
      }

      const file: LocalFile = {
        id: crypto.randomUUID(),
        appId: "local",
        recordId: typeof body.recordId === "string" ? body.recordId : null,
        ownerId: "local-user",
        fileName: validation.upload.fileName,
        contentType: validation.upload.contentType,
        sizeBytes: validation.upload.sizeBytes,
        storageProvider: "local",
        dataBase64: validation.upload.dataBase64,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      files.set(file.id, file);
      return NextResponse.json({ file: toLocalFileMetadata(file) }, { status: 201 });
    }
    case "downloadFile": {
      if (typeof body.fileId !== "string") {
        return NextResponse.json({ error: "fileId required." }, { status: 400 });
      }
      const file = files.get(body.fileId);
      if (!file || file.deletedAt) {
        return NextResponse.json({ error: "File not found." }, { status: 404 });
      }
      return NextResponse.json({
        file: toLocalFileMetadata(file),
        dataBase64: file.dataBase64,
      });
    }
    case "deleteFile": {
      if (typeof body.fileId !== "string") {
        return NextResponse.json({ error: "fileId required." }, { status: 400 });
      }
      const file = files.get(body.fileId);
      if (!file || file.deletedAt) {
        return NextResponse.json({ error: "File not found." }, { status: 404 });
      }
      const deleted = { ...file, deletedAt: now, updatedAt: now };
      files.set(deleted.id, deleted);
      return NextResponse.json({ file: toLocalFileMetadata(deleted) });
    }
  }
}

function getLocalFiles(): Map<string, LocalFile> {
  globalStore.__voiceforgeLocalFiles ??= new Map<string, LocalFile>();
  return globalStore.__voiceforgeLocalFiles;
}

function validateLocalUpload(input: {
  fileName: string;
  contentType: string;
  dataBase64: string;
}):
  | {
      ok: true;
      upload: {
        fileName: string;
        contentType: string;
        dataBase64: string;
        sizeBytes: number;
      };
    }
  | { ok: false; status: number; code: string; error: string } {
  const fileName = normalizeFileName(input.fileName);
  const contentType = input.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const dataBase64 = normalizeBase64(input.dataBase64);
  if (!dataBase64) {
    return {
      ok: false,
      status: 400,
      code: "invalid_file_payload",
      error: "File payload must be valid base64.",
    };
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return {
      ok: false,
      status: 400,
      code: "unsupported_file_type",
      error: `Files of type ${contentType || "unknown"} are not allowed.`,
    };
  }
  const sizeBytes = Buffer.byteLength(Buffer.from(dataBase64, "base64"));
  if (sizeBytes < 1) {
    return {
      ok: false,
      status: 400,
      code: "empty_file",
      error: "Uploaded files must not be empty.",
    };
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "file_too_large",
      error: "File is too large.",
    };
  }
  return { ok: true, upload: { fileName, contentType, dataBase64, sizeBytes } };
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

function normalizeBase64(value: string): string | null {
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
    return null;
  }
  return Buffer.from(clean, "base64").toString("base64");
}

function toLocalFileMetadata(file: LocalFile): LocalFileMetadata {
  const { dataBase64: _dataBase64, ...metadata } = file;
  return metadata;
}

function localPlatformError(
  status: number,
  code: string,
  error: string,
  details?: unknown,
) {
  return NextResponse.json({ error, code, details }, { status });
}

function normalizeSharingModel(value: string | undefined): "private" | "shared" | "public" {
  if (value === "private" || value === "public") return value;
  return "shared";
}
