import { z } from "zod";

/** LOCKED PLATFORM FILE - normalizes untrusted AI text at the app boundary. */

export function aiText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
}

export function aiNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function aiBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return fallback;
}

export function aiRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function aiArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function aiTextArray(value: unknown): string[] {
  return aiArray(value).map((item) => aiText(item)).filter(Boolean);
}

export function parseAiJson(text: string): unknown {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!clean) throw new Error("AI returned an empty response.");
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    throw new Error("AI returned information in an unexpected format. Please try again.");
  }
}

export function parseStructuredAiText<T>(
  text: string,
  schema: z.ZodType<T>,
): T {
  const parsed = schema.safeParse(parseAiJson(text));
  if (!parsed.success) {
    throw new Error("AI returned incomplete or invalid fields. Please try again.");
  }
  return parsed.data;
}

export async function readAiTextResponse(response: Response): Promise<string> {
  const payload = aiRecord(await response.json());
  if (!response.ok) {
    throw new Error(aiText(payload.error, "AI request failed. Please try again."));
  }
  const text = aiText(payload.text);
  if (!text) throw new Error("AI returned an empty response.");
  return text;
}
