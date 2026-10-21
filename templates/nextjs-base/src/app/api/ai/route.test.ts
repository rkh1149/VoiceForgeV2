import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("VoiceForge AI proxy", () => {
  it("uses the structured response budget and focused reasoning", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("VOICEFORGE_PUBLIC_URL", "");
    vi.stubEnv("VOICEFORGE_APP_TOKEN", "");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        status: "completed",
        output_text: JSON.stringify({ name: "Complete result" }),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(new Request("http://localhost/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "structured", prompt: "Return a JSON object." }),
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      max_output_tokens: number;
      reasoning?: { effort?: string };
    };
    expect(requestBody.max_output_tokens).toBe(6000);
    expect(requestBody.reasoning).toEqual({ effort: "low" });
  });

  it("retries an incomplete structured response once with a larger budget", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("VOICEFORGE_PUBLIC_URL", "");
    vi.stubEnv("VOICEFORGE_APP_TOKEN", "");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_text: "",
        usage: { input_tokens: 100, output_tokens: 6000 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "completed",
        output_text: JSON.stringify({ name: "Complete result" }),
        usage: { input_tokens: 100, output_tokens: 200 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(new Request("http://localhost/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "structured", prompt: "Return a JSON object." }),
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      max_output_tokens: number;
    };
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      max_output_tokens: number;
      instructions?: string;
    };
    expect(firstBody.max_output_tokens).toBe(6000);
    expect(retryBody.max_output_tokens).toBe(8000);
    expect(retryBody.instructions).toContain("automatic retry");
    await expect(response.json()).resolves.toEqual({
      text: JSON.stringify({ name: "Complete result" }),
    });
  });
});
