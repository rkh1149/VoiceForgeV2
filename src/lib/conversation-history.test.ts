import { describe, expect, it } from "vitest";
import {
  getConversationMessages,
  getConversationPreview,
} from "./conversation-history";

describe("conversation history display helpers", () => {
  it("extracts readable user and assistant turns from planner transcripts", () => {
    const messages = getConversationMessages([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Build a family trip planner." }],
      },
      {
        type: "function_call",
        name: "propose_spec",
        arguments: '{"appName":"Trip Planner"}',
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Who should be able to edit the itinerary?",
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "Build a family trip planner." },
      {
        role: "assistant",
        content: "Who should be able to edit the itinerary?",
      },
    ]);
  });

  it("supports voice transcripts and nested raw items", () => {
    const messages = getConversationMessages([
      { role: "user", text: "Use my voice prompt." },
      {
        rawItem: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I can help plan that." }],
        },
      },
      { role: "system", content: "hidden" },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "Use my voice prompt." },
      { role: "assistant", content: "I can help plan that." },
    ]);
  });

  it("uses the first user turn as a planning session preview", () => {
    const preview = getConversationPreview([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Build a family renovation tracker with budgets, notes, files, approvals, and reports.",
          },
        ],
      },
    ]);

    expect(preview).toBe(
      "Build a family renovation tracker with budgets, notes, files, approvals, and reports.",
    );
  });
});
