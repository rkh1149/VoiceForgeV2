import { z } from "zod";
import { CHAT_MESSAGE_MAX_LENGTH } from "./chat-limits";
import {
  composeRequirementsMessage,
  extractRequirementsDocument,
  RequirementsDocumentError,
} from "./requirements-document";

export type ParsedChatRequest = {
  conversationId?: string | null;
  appId?: string | null;
  forceDeepDiagnostic: boolean;
  message: string;
};

export class ChatRequestError extends Error {}

const jsonBodySchema = z.object({
  conversationId: z.string().uuid().nullish(),
  appId: z.string().uuid().nullish(),
  forceDeepDiagnostic: z.boolean().default(false),
  message: z.string().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
});

const multipartFieldsSchema = z.object({
  conversationId: z.string().uuid().nullable(),
  appId: z.string().uuid().nullable(),
  forceDeepDiagnostic: z.boolean(),
  message: z.string().max(CHAT_MESSAGE_MAX_LENGTH),
});

export async function parseChatRequest(req: Request): Promise<ParsedChatRequest> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    const parsed = jsonBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ChatRequestError("Invalid request");
    return parsed.data;
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    throw new ChatRequestError("VoiceForge could not read the submitted form.");
  }
  const fields = multipartFieldsSchema.safeParse({
    conversationId: optionalFormString(formData, "conversationId"),
    appId: optionalFormString(formData, "appId"),
    forceDeepDiagnostic: formData.get("forceDeepDiagnostic") === "true",
    message: formString(formData, "message"),
  });
  if (!fields.success) throw new ChatRequestError("Invalid request");

  const fileValue = formData.get("requirementsFile");
  const file = fileValue instanceof File && fileValue.size > 0 ? fileValue : null;
  if (file && fields.data.appId) {
    throw new ChatRequestError(
      "Requirements documents can only be attached while creating a new app.",
    );
  }

  try {
    const document = file ? await extractRequirementsDocument(file) : null;
    const message = composeRequirementsMessage(fields.data.message, document);
    if (!message) {
      throw new ChatRequestError(
        "Type a message or choose a requirements document.",
      );
    }
    return { ...fields.data, message };
  } catch (error) {
    if (error instanceof ChatRequestError) throw error;
    if (error instanceof RequirementsDocumentError) {
      throw new ChatRequestError(error.message);
    }
    throw error;
  }
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function optionalFormString(formData: FormData, key: string): string | null {
  const value = formString(formData, key).trim();
  return value || null;
}
