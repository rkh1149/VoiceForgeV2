/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * Typed browser client for generated apps that use VoiceForge platform files.
 * It talks only to the same-origin /api/files route; app secrets remain on
 * the server.
 */

import { getStoredSessionToken } from "./platform-data";

export type PlatformFile = {
  id: string;
  appId: string;
  recordId: string | null;
  ownerId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  storageProvider: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type RequestBody =
  | { action: "listFiles"; recordId?: string }
  | {
      action: "uploadFile";
      recordId?: string;
      fileName: string;
      contentType: string;
      dataBase64: string;
    }
  | { action: "downloadFile"; fileId: string }
  | { action: "deleteFile"; fileId: string };

async function request<TResponse>(body: RequestBody): Promise<TResponse> {
  const res = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, sessionToken: getStoredSessionToken() }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & TResponse;
  if (!res.ok) {
    throw new Error(payload.error ?? "Platform file request failed.");
  }
  return payload;
}

export async function listPlatformFiles(
  options: { recordId?: string } = {},
): Promise<PlatformFile[]> {
  const result = await request<{ files: PlatformFile[] }>({
    action: "listFiles",
    ...options,
  });
  return result.files;
}

export async function uploadPlatformFile(input: {
  file: File;
  recordId?: string;
  fileName?: string;
  contentType?: string;
}): Promise<PlatformFile> {
  const dataBase64 = await browserFileToBase64(input.file);
  return uploadPlatformFileData({
    recordId: input.recordId,
    fileName: input.fileName ?? input.file.name,
    contentType:
      input.contentType ||
      input.file.type ||
      inferContentType(input.file.name) ||
      "application/octet-stream",
    dataBase64,
  });
}

export async function uploadPlatformFileData(input: {
  recordId?: string;
  fileName: string;
  contentType: string;
  dataBase64: string;
}): Promise<PlatformFile> {
  const result = await request<{ file: PlatformFile }>({
    action: "uploadFile",
    ...input,
  });
  return result.file;
}

export async function downloadPlatformFile(input: {
  fileId: string;
}): Promise<{ file: PlatformFile; dataBase64: string; dataUrl: string }> {
  const result = await request<{ file: PlatformFile; dataBase64: string }>({
    action: "downloadFile",
    fileId: input.fileId,
  });
  return {
    ...result,
    dataUrl: platformFileDataUrl(result.file.contentType, result.dataBase64),
  };
}

export async function deletePlatformFile(fileId: string): Promise<PlatformFile> {
  const result = await request<{ file: PlatformFile }>({
    action: "deleteFile",
    fileId,
  });
  return result.file;
}

export async function downloadPlatformFileToBrowser(fileId: string): Promise<void> {
  if (typeof window === "undefined") return;
  const result = await downloadPlatformFile({ fileId });
  const link = document.createElement("a");
  link.href = result.dataUrl;
  link.download = result.file.fileName;
  link.click();
}

export function platformFileDataUrl(contentType: string, dataBase64: string): string {
  return `data:${contentType};base64,${dataBase64}`;
}

function browserFileToBase64(file: File): Promise<string> {
  if (typeof FileReader === "undefined") {
    return Promise.reject(new Error("File uploads are only available in the browser."));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}

function inferContentType(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpeg") || lower.endsWith(".jpg")) return "image/jpeg";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return null;
}
