import WordExtractor from "word-extractor";
import {
  REQUIREMENTS_FILE_MAX_TEXT_LENGTH,
  REQUIREMENTS_PDF_MAX_PAGES,
  requirementsFileExtension,
  validateRequirementsFileSelection,
  type RequirementsFileExtension,
} from "./requirements-file";

export class RequirementsDocumentError extends Error {}

export type ExtractedRequirementsDocument = {
  filename: string;
  text: string;
};

export async function extractRequirementsDocument(
  file: File,
): Promise<ExtractedRequirementsDocument> {
  const validationError = validateRequirementsFileSelection(file);
  if (validationError) throw new RequirementsDocumentError(validationError);

  const extension = requirementsFileExtension(file.name);
  if (!extension) {
    throw new RequirementsDocumentError(
      "Choose a TXT, PDF, DOC, or DOCX requirements file.",
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateDocumentSignature(bytes, extension);

  let extracted: string;
  try {
    if (extension === "txt") extracted = extractTextFile(bytes);
    else if (extension === "pdf") extracted = await extractPdf(bytes);
    else extracted = await extractWordDocument(bytes);
  } catch (error) {
    if (error instanceof RequirementsDocumentError) throw error;
    console.error("Requirements document extraction failed:", error);
    throw new RequirementsDocumentError(
      "VoiceForge could not read that requirements document. Try saving it again or use a TXT file.",
    );
  }

  const text = normalizeExtractedText(extracted);
  if (!text) {
    throw new RequirementsDocumentError(
      extension === "pdf"
        ? "The PDF has no readable text. Scanned-image PDFs need OCR before they can be used."
        : "The requirements document has no readable text.",
    );
  }
  if (text.length > REQUIREMENTS_FILE_MAX_TEXT_LENGTH) {
    throw new RequirementsDocumentError(
      "The requirements document contains too much text. Shorten it to 100,000 characters or fewer.",
    );
  }

  return {
    filename: sanitizeFilename(file.name),
    text,
  };
}

export function composeRequirementsMessage(
  typedMessage: string,
  document: ExtractedRequirementsDocument | null,
): string {
  const parts: string[] = [];
  const typed = typedMessage.trim();
  if (typed) parts.push(typed);
  if (document) {
    parts.push(
      `Requirements document: ${document.filename}\n\n--- BEGIN REQUIREMENTS DOCUMENT ---\n${document.text}\n--- END REQUIREMENTS DOCUMENT ---`,
    );
  }
  return parts.join("\n\n");
}

function extractTextFile(bytes: Uint8Array): string {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  const suspiciousBytes = sample.filter(
    (byte) => byte === 0 || (byte < 9 && byte !== 0),
  ).length;
  if (suspiciousBytes > Math.max(1, sample.length * 0.01)) {
    throw new RequirementsDocumentError(
      "The selected TXT file appears to contain binary data.",
    );
  }
  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  try {
    const document = await loadingTask.promise;
    if (document.numPages > REQUIREMENTS_PDF_MAX_PAGES) {
      throw new RequirementsDocumentError(
        `The PDF has ${document.numPages} pages. The limit is ${REQUIREMENTS_PDF_MAX_PAGES}.`,
      );
    }
    const pages: string[] = [];
    let extractedLength = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pages.push(pageText);
      extractedLength += pageText.length;
      if (extractedLength > REQUIREMENTS_FILE_MAX_TEXT_LENGTH) {
        throw new RequirementsDocumentError(
          "The requirements document contains too much text. Shorten it to 100,000 characters or fewer.",
        );
      }
    }
    return pages.join("\n\n");
  } finally {
    await loadingTask.destroy();
  }
}

async function extractWordDocument(bytes: Uint8Array): Promise<string> {
  const extractor = new WordExtractor();
  const document = await extractor.extract(Buffer.from(bytes));
  return document.getBody();
}

function validateDocumentSignature(
  bytes: Uint8Array,
  extension: RequirementsFileExtension,
): void {
  if (extension === "txt") return;
  if (
    extension === "pdf" &&
    !matchesBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
  ) {
    throw new RequirementsDocumentError(
      "The selected file does not contain a valid PDF document.",
    );
  }
  if (
    extension === "doc" &&
    !matchesBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  ) {
    throw new RequirementsDocumentError(
      "The selected file does not contain a valid Microsoft Word DOC document.",
    );
  }
  if (
    extension === "docx" &&
    !matchesBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) &&
    !matchesBytes(bytes, [0x50, 0x4b, 0x05, 0x06]) &&
    !matchesBytes(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    throw new RequirementsDocumentError(
      "The selected file does not contain a valid Microsoft Word DOCX document.",
    );
  }
}

function matchesBytes(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[\r\n\u0000]/g, " ").trim().slice(0, 180);
}
