export type ConversationDisplayMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ConversationDisplaySession = {
  id: string;
  channel: string;
  updatedAt: Date | string;
  messages: ConversationDisplayMessage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return normalizeText(content);
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const text = part.text;
    const transcript = part.transcript;
    if (typeof text === "string") parts.push(text);
    else if (typeof transcript === "string") parts.push(transcript);
  }
  return normalizeText(parts.join(" "));
}

function displayTextFromItem(item: Record<string, unknown>): string {
  const directText = item.text;
  if (typeof directText === "string") return normalizeText(directText);

  return textFromContent(item.content);
}

export function getConversationMessages(
  transcript: unknown,
): ConversationDisplayMessage[] {
  if (!Array.isArray(transcript)) return [];

  const messages: ConversationDisplayMessage[] = [];
  for (const item of transcript) {
    if (!isRecord(item)) continue;

    const rawItem = isRecord(item.rawItem) ? item.rawItem : item;
    const role = rawItem.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = displayTextFromItem(rawItem);
    if (content) messages.push({ role, content });
  }

  return messages;
}

export function getConversationPreview(transcript: unknown): string {
  const firstUserMessage = getConversationMessages(transcript).find(
    (message) => message.role === "user",
  );
  if (!firstUserMessage) return "Untitled planning session";
  if (firstUserMessage.content.length <= 90) return firstUserMessage.content;
  return `${firstUserMessage.content.slice(0, 87).trim()}...`;
}
