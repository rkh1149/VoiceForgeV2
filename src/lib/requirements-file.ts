export const REQUIREMENTS_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const REQUIREMENTS_FILE_MAX_TEXT_LENGTH = 100_000;
export const REQUIREMENTS_PDF_MAX_PAGES = 250;

export const REQUIREMENTS_FILE_ACCEPT = [
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  "text/plain",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
].join(",");

export type RequirementsFileExtension = "txt" | "pdf" | "doc" | "docx";

const MIME_TYPES_BY_EXTENSION: Record<RequirementsFileExtension, Set<string>> = {
  txt: new Set(["text/plain"]),
  pdf: new Set(["application/pdf"]),
  doc: new Set([
    "application/msword",
    "application/x-ole-storage",
    "application/CDFV2",
  ]),
  docx: new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
  ]),
};

export function requirementsFileExtension(
  filename: string,
): RequirementsFileExtension | null {
  const extension = filename.split(".").pop()?.toLowerCase();
  return extension && extension in MIME_TYPES_BY_EXTENSION
    ? (extension as RequirementsFileExtension)
    : null;
}

export function validateRequirementsFileSelection(file: {
  name: string;
  size: number;
  type: string;
}): string | null {
  const extension = requirementsFileExtension(file.name);
  if (!extension) {
    return "Choose a TXT, PDF, DOC, or DOCX requirements file.";
  }
  if (file.size <= 0) return "The selected requirements file is empty.";
  if (file.size > REQUIREMENTS_FILE_MAX_BYTES) {
    return "The requirements file must be 4 MB or smaller.";
  }
  const mimeType = file.type.trim();
  if (
    mimeType &&
    mimeType !== "application/octet-stream" &&
    !MIME_TYPES_BY_EXTENSION[extension].has(mimeType)
  ) {
    return `The selected file does not appear to be a valid .${extension} document.`;
  }
  return null;
}

export function formatRequirementsFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
