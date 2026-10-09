import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  aiArray,
  aiRecord,
  aiText,
  parseAiJson,
  parseStructuredAiText,
} from "./voiceforge-ai";

describe("VoiceForge AI response boundary", () => {
  it("coerces numeric recipe quantities before form code uses string methods", () => {
    const ingredientSchema = z.object({
      name: z.unknown().transform((value) => aiText(value)),
      quantity: z.unknown().transform((value) => aiText(value)),
    });
    const ingredient = parseStructuredAiText(
      '```json\n{"name":"Almonds","quantity":2}\n```',
      ingredientSchema,
    );

    expect(ingredient).toEqual({ name: "Almonds", quantity: "2" });
    expect(ingredient.quantity.trim()).toBe("2");
  });

  it("uses safe empty containers for malformed optional fields", () => {
    expect(aiRecord(null)).toEqual({});
    expect(aiArray("not-an-array")).toEqual([]);
    expect(() => parseAiJson("not json")).toThrow("unexpected format");
  });
});
