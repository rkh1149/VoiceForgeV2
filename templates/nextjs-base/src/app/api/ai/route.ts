import { NextResponse } from "next/server";

/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * The single AI endpoint for this generated app. The OpenAI key exists only
 * as a server env var set by VoiceForge at deploy time; the model is pinned;
 * every request is gated against a per-app daily limit and its token usage
 * is reported back to VoiceForge for the owner's dashboard.
 */

const MAX_PROMPT_CHARS = 4000;
const MAX_SYSTEM_CHARS = 1000;
const MAX_OUTPUT_TOKENS = 1000;
const MAX_RESEARCH_OUTPUT_TOKENS = 3600;

type AiRequestBody = {
  prompt?: unknown;
  system?: unknown;
  mode?: unknown;
  imageDataUrl?: unknown;
};
type GateResponse = { allowed?: boolean; reason?: string; usageId?: string };
type ImagesBody = {
  data?: Array<{ b64_json?: string }>;
  usage?: ResponsesUsage;
};
type ResponsesUsage = { input_tokens?: number; output_tokens?: number };
type UrlCitation = {
  type?: string;
  url?: string;
  title?: string;
  end_index?: number;
};
type SearchSource = { url?: string; title?: string };
type ResponsesContent = {
  type?: string;
  text?: string;
  annotations?: UrlCitation[];
};
type ResponsesOutputItem = {
  type?: string;
  status?: string;
  content?: ResponsesContent[];
  action?: { sources?: SearchSource[] };
};
type ResponsesBody = {
  output_text?: string;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
};

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "AI is not enabled for this app." },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => null)) as AiRequestBody | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const imageDataUrl =
    typeof body?.imageDataUrl === "string" ? body.imageDataUrl.trim() : "";
  const system =
    typeof body?.system === "string"
      ? body.system.slice(0, MAX_SYSTEM_CHARS)
      : undefined;
  const mode =
    body?.mode === "image"
      ? "image"
      : body?.mode === "research"
        ? "research"
        : "text";
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json(
      { error: `Prompt must be 1–${MAX_PROMPT_CHARS} characters.` },
      { status: 400 },
    );
  }
  if (
    imageDataUrl &&
    (!/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(
      imageDataUrl,
    ) ||
      imageDataUrl.length > 4_000_000)
  ) {
    return NextResponse.json(
      { error: "Image input must be a JPG, PNG, or WebP data URL under 3 MB." },
      { status: 400 },
    );
  }

  // Daily-limit gate (fail-closed: if VoiceForge can't be reached, deny —
  // cost safety beats availability for a family app).
  const gateBase = process.env.VOICEFORGE_PUBLIC_URL;
  const gateToken = process.env.VOICEFORGE_APP_TOKEN;
  let usageId: string | null = null;
  if (gateBase && gateToken) {
    let gate: GateResponse | null = null;
    try {
      const res = await fetch(`${gateBase}/api/ai-usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: gateToken,
          phase: "gate",
          kind: mode === "image" ? "image" : "text",
        }),
      });
      gate = (await res.json()) as GateResponse;
    } catch {
      gate = null;
    }
    if (!gate?.allowed) {
      return NextResponse.json(
        {
          error:
            gate?.reason ??
            "The AI helper is unavailable right now. Please try again later.",
        },
        { status: 429 },
      );
    }
    usageId = gate.usageId ?? null;
  }

  // ---- image mode -----------------------------------------------------
  if (mode === "image") {
    const imageModel = process.env.AI_IMAGE_MODEL ?? "gpt-image-2";
    const imgRes = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: imageModel,
        prompt,
        n: 1,
        size: "1024x1024",
        quality: "low",
      }),
    });
    const imgData = (await imgRes.json().catch(() => ({}))) as ImagesBody;
    const imageBase64 = imgData.data?.[0]?.b64_json;
    if (!imgRes.ok || !imageBase64) {
      return NextResponse.json(
        { error: "The image maker hit a problem. Please try again." },
        { status: 502 },
      );
    }
    if (gateBase && gateToken && usageId) {
      void fetch(`${gateBase}/api/ai-usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: gateToken,
          phase: "report",
          usageId,
          model: imageModel,
          inputTokens: imgData.usage?.input_tokens ?? 0,
          outputTokens: imgData.usage?.output_tokens ?? 0,
        }),
      }).catch(() => {});
    }
    return NextResponse.json({ imageBase64 });
  }

  // ---- text mode -------------------------------------------------------
  const model = process.env.AI_MODEL ?? "gpt-5.6-terra";
  const aiRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: imageDataUrl
        ? [
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                {
                  type: "input_image",
                  image_url: imageDataUrl,
                  detail: "high",
                },
              ],
            },
          ]
        : prompt,
      instructions: system,
      max_output_tokens:
        mode === "research" ? MAX_RESEARCH_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
      ...(mode === "research"
        ? {
            tools: [{ type: "web_search" }],
            tool_choice: "required",
            max_tool_calls: 3,
            include: ["web_search_call.action.sources"],
          }
        : {}),
    }),
  });
  const data = (await aiRes.json().catch(() => ({}))) as ResponsesBody;
  if (!aiRes.ok) {
    return NextResponse.json(
      { error: "The AI helper hit a problem. Please try again." },
      { status: 502 },
    );
  }

  const text =
    data.output_text ??
    (data.output ?? [])
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");

  const citations: Array<{ title: string; url: string; sourceNote?: string }> = [];
  let researchText = "";
  let researchCompleted = true;
  if (mode === "research") {
    const searched = (data.output ?? []).some(
      (item) => item.type === "web_search_call" && item.status === "completed",
    );
    const blocks = (data.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((content) => content.type === "output_text" && content.text);
    researchText = blocks
      .map((block) => {
        let annotated = block.text ?? "";
        const marks = (block.annotations ?? [])
          .filter((annotation) => annotation.type === "url_citation")
          .map((annotation) => {
            let url: URL;
            try {
              url = new URL(annotation.url ?? "");
            } catch {
              return null;
            }
            if (url.protocol !== "https:") return null;
            let index = citations.findIndex((item) => item.url === url.href);
            if (index < 0) {
              index = citations.length;
              citations.push({
                title: annotation.title?.trim() || url.hostname,
                url: url.href,
              });
            }
            return { index, end: annotation.end_index };
          })
          .filter((mark): mark is { index: number; end: number } =>
            Boolean(mark && typeof mark.end === "number"),
          )
          .sort((left, right) => right.end - left.end);
        for (const mark of marks) {
          if (mark.end >= 0 && mark.end <= annotated.length) {
            annotated = `${annotated.slice(0, mark.end)} [${mark.index + 1}]${annotated.slice(mark.end)}`;
          }
        }
        return annotated;
      })
      .join("\n\n");
    if (citations.length === 0) {
      for (const source of (data.output ?? []).flatMap((item) => item.action?.sources ?? [])) {
        let url: URL;
        try {
          url = new URL(source.url ?? "");
        } catch {
          continue;
        }
        if (url.protocol !== "https:" || citations.some((item) => item.url === url.href)) continue;
        citations.push({
          title: source.title?.trim() || url.hostname,
          url: url.href,
          sourceNote: "Research source consulted; not linked to a specific claim.",
        });
        if (citations.length >= 12) break;
      }
    }
    researchCompleted = searched && Boolean(researchText.trim());
  }

  // Report token usage (fire-and-forget; failures don't affect the user).
  if (gateBase && gateToken && usageId) {
    void fetch(`${gateBase}/api/ai-usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: gateToken,
        phase: "report",
        usageId,
        model,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      }),
    }).catch(() => {});
  }

  if (!researchCompleted) {
    return NextResponse.json(
      { error: "Research search did not complete. Please try again." },
      { status: 502 },
    );
  }

  return NextResponse.json(
    mode === "research"
      ? { text: researchText, citations, noSources: citations.length === 0 }
      : { text },
  );
}
