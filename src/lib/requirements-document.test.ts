import { describe, expect, it } from "vitest";
import {
  composeRequirementsMessage,
  extractRequirementsDocument,
  RequirementsDocumentError,
} from "./requirements-document";
import {
  REQUIREMENTS_FILE_MAX_BYTES,
  requirementsFileExtension,
  validateRequirementsFileSelection,
} from "./requirements-file";

describe("requirements documents", () => {
  it("accepts the supported filename extensions case-insensitively", () => {
    expect(requirementsFileExtension("requirements.TXT")).toBe("txt");
    expect(requirementsFileExtension("requirements.pdf")).toBe("pdf");
    expect(requirementsFileExtension("requirements.doc")).toBe("doc");
    expect(requirementsFileExtension("requirements.DOCX")).toBe("docx");
    expect(requirementsFileExtension("requirements.pages")).toBeNull();
  });

  it("rejects unsupported, empty, oversized, and mismatched selections", () => {
    expect(
      validateRequirementsFileSelection({
        name: "requirements.png",
        size: 20,
        type: "image/png",
      }),
    ).toContain("TXT, PDF, DOC, or DOCX");
    expect(
      validateRequirementsFileSelection({
        name: "requirements.txt",
        size: 0,
        type: "text/plain",
      }),
    ).toContain("empty");
    expect(
      validateRequirementsFileSelection({
        name: "requirements.pdf",
        size: REQUIREMENTS_FILE_MAX_BYTES + 1,
        type: "application/pdf",
      }),
    ).toContain("4 MB");
    expect(
      validateRequirementsFileSelection({
        name: "requirements.pdf",
        size: 20,
        type: "text/plain",
      }),
    ).toContain("valid .pdf");
  });

  it("extracts and normalizes readable TXT requirements", async () => {
    const document = await extractRequirementsDocument(
      new File(["Build a family calendar.\r\n\r\nInclude reminders."], "plan.txt", {
        type: "text/plain",
      }),
    );

    expect(document).toEqual({
      filename: "plan.txt",
      text: "Build a family calendar.\n\nInclude reminders.",
    });
  });

  it("combines typed and attached requirements without requiring both", () => {
    const document = { filename: "plan.txt", text: "Include a shared list." };

    expect(composeRequirementsMessage("Use large text.", document)).toContain(
      "Use large text.\n\nRequirements document: plan.txt",
    );
    expect(composeRequirementsMessage("", document)).toContain(
      "Include a shared list.",
    );
    expect(composeRequirementsMessage("Use large text.", null)).toBe(
      "Use large text.",
    );
  });

  it("rejects a file whose contents do not match its PDF extension", async () => {
    await expect(
      extractRequirementsDocument(
        new File(["not a pdf"], "plan.pdf", { type: "application/pdf" }),
      ),
    ).rejects.toBeInstanceOf(RequirementsDocumentError);
  });
});
