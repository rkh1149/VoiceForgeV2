import { describe, expect, it } from "vitest";
import { ChatRequestError, parseChatRequest } from "./chat-request";

describe("chat request parsing", () => {
  it("preserves the existing JSON text request", async () => {
    const request = new Request("http://voiceforge.test/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Build a family planner." }),
    });

    await expect(parseChatRequest(request)).resolves.toMatchObject({
      message: "Build a family planner.",
      forceDeepDiagnostic: false,
    });
  });

  it("accepts a requirements file without typed text", async () => {
    const formData = new FormData();
    formData.set("message", "");
    formData.set(
      "requirementsFile",
      new File(["Build a shared grocery list."], "requirements.txt", {
        type: "text/plain",
      }),
    );
    const request = new Request("http://voiceforge.test/api/chat", {
      method: "POST",
      body: formData,
    });

    await expect(parseChatRequest(request)).resolves.toMatchObject({
      message: expect.stringContaining("Build a shared grocery list."),
    });
  });

  it("combines typed text and an uploaded document", async () => {
    const formData = new FormData();
    formData.set("message", "Make the interface phone friendly.");
    formData.set(
      "requirementsFile",
      new File(["Include errands and reminders."], "requirements.txt", {
        type: "text/plain",
      }),
    );
    const request = new Request("http://voiceforge.test/api/chat", {
      method: "POST",
      body: formData,
    });
    const result = await parseChatRequest(request);

    expect(result.message).toContain("Make the interface phone friendly.");
    expect(result.message).toContain("Include errands and reminders.");
  });

  it("rejects multipart requests with neither text nor a file", async () => {
    const request = new Request("http://voiceforge.test/api/chat", {
      method: "POST",
      body: new FormData(),
    });

    await expect(parseChatRequest(request)).rejects.toEqual(
      new ChatRequestError("Type a message or choose a requirements document."),
    );
  });
});
