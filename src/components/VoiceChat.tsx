"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RealtimeAgent,
  RealtimeSession,
  tool,
  type RealtimeItem,
} from "@openai/agents/realtime";
import {
  appSpecSchema,
  changeProposalSchema,
  type AppSpec,
  type ChangeProposal,
} from "@/lib/spec";

type TranscriptLine = { role: "user" | "assistant"; text: string };

type Proposal = {
  appId: string;
  appName: string;
  requirementId: string;
  approvalId: string;
  version: number;
};

const MAX_SESSION_MS = 10 * 60_000; // hard stop after 10 minutes (cost)

function mapHistory(items: RealtimeItem[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const item of items) {
    const msg = item as {
      type?: string;
      role?: string;
      content?: Array<Record<string, unknown>>;
    };
    if (msg.type !== "message") continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = (msg.content ?? [])
      .map((c) => (c.transcript as string) ?? (c.text as string) ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) lines.push({ role: msg.role, text });
  }
  return lines;
}

export default function VoiceChat({
  appId,
  appName,
}: {
  appId?: string;
  appName?: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<
    "idle" | "connecting" | "live" | "ended"
  >("idle");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount.
      sessionRef.current?.close();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, proposal]);

  async function start() {
    setError(null);
    setStatus("connecting");
    try {
      const res = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start voice session");
      conversationIdRef.current = data.conversationId;

      const proposeTool = data.changeMode
        ? tool({
            name: "propose_change",
            description:
              "Record the complete updated app specification plus a plain-language changeSummary.",
            parameters: changeProposalSchema,
            execute: async (change: ChangeProposal) => {
              const { changeSummary, ...spec } = change;
              return submitProposal(spec as AppSpec, changeSummary);
            },
          })
        : tool({
            name: "propose_spec",
            description:
              "Record the final app specification once the user has answered enough questions.",
            parameters: appSpecSchema,
            execute: async (spec: AppSpec) => submitProposal(spec, null),
          });

      const agent = new RealtimeAgent({
        name: "VoiceForge",
        instructions: data.instructions,
        tools: [proposeTool],
      });

      const session = new RealtimeSession(agent, {
        model: data.model,
        config: {
          audio: {
            input: { transcription: { model: "gpt-4o-mini-transcribe" } },
          },
        },
      });
      session.on("history_updated", (items: RealtimeItem[]) => {
        const lines = mapHistory(items);
        transcriptRef.current = lines;
        setTranscript(lines);
      });
      await session.connect({ apiKey: data.clientSecret });
      sessionRef.current = session;
      setStatus("live");

      timerRef.current = setTimeout(() => {
        void stop("Time limit reached — voice sessions stop after 10 minutes.");
      }, MAX_SESSION_MS);
    } catch (e) {
      console.error(e);
      setStatus("idle");
      setError(
        e instanceof Error
          ? e.message
          : "Could not start the voice session (is your microphone allowed?)",
      );
    }
  }

  async function submitProposal(
    spec: AppSpec,
    changeSummary: string | null,
  ): Promise<string> {
    try {
      const res = await fetch("/api/voice/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationIdRef.current,
          spec,
          changeSummary,
          plainSummary: "",
          transcript: transcriptRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save the plan");
      setProposal(data.proposal);
      setDecision(null);
      return "Plan recorded successfully. Now briefly summarize it out loud and tell the user to press the green Approve button on their screen.";
    } catch (e) {
      console.error(e);
      return `The plan could not be saved (${e instanceof Error ? e.message : "error"}). Apologize and ask the user to try again.`;
    }
  }

  async function stop(reason?: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    sessionRef.current?.close();
    sessionRef.current = null;
    setStatus("ended");
    if (reason) setError(reason);
    // Persist the transcript for the record.
    if (conversationIdRef.current && transcriptRef.current.length > 0) {
      await fetch("/api/voice/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationIdRef.current,
          transcript: transcriptRef.current,
        }),
      }).catch(() => {});
    }
  }

  async function decide(d: "approved" | "rejected") {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${proposal.approvalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: d }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setDecision(d);
      if (d === "approved") {
        await stop();
        setTimeout(() => router.push(`/dashboard/apps/${proposal.appId}`), 1200);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Talk control */}
      <div className="flex flex-col items-center gap-3 border-b border-slate-100 p-6">
        {status === "idle" || status === "ended" ? (
          <>
            <button
              onClick={start}
              className="flex h-20 w-20 items-center justify-center rounded-full bg-forge-600 text-3xl text-white shadow-lg transition hover:bg-forge-700"
              aria-label="Start talking"
            >
              🎤
            </button>
            <p className="text-sm text-slate-500">
              {status === "ended"
                ? "Session ended. Tap to start a new conversation."
                : appId
                  ? `Tap and tell me what to change in ${appName ?? "your app"}.`
                  : "Tap the microphone and describe the app you want."}
            </p>
          </>
        ) : (
          <>
            <div className="relative flex h-20 w-20 items-center justify-center">
              <span
                className={`absolute inline-flex h-full w-full rounded-full bg-forge-500 opacity-40 ${status === "live" ? "animate-ping" : ""}`}
              />
              <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-forge-600 text-3xl text-white">
                🎤
              </span>
            </div>
            <p className="text-sm font-medium text-forge-700">
              {status === "connecting" ? "Connecting…" : "Listening — just talk"}
            </p>
            <button
              onClick={() => stop()}
              className="rounded-xl border border-slate-300 px-4 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
            >
              End conversation
            </button>
          </>
        )}
      </div>

      {/* Live transcript */}
      <div className="max-h-[40vh] min-h-24 overflow-y-auto p-4">
        {transcript.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-300">
            Your conversation will appear here.
          </p>
        ) : (
          <div className="space-y-2">
            {transcript.map((line, i) => (
              <p key={i} className="text-sm">
                <span
                  className={
                    line.role === "user"
                      ? "font-semibold text-forge-700"
                      : "font-semibold text-slate-400"
                  }
                >
                  {line.role === "user" ? "You: " : "VoiceForge: "}
                </span>
                <span className="text-slate-700">{line.text}</span>
              </p>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Approval card */}
      {proposal && decision !== "approved" && (
        <div className="border-t border-slate-200 bg-forge-50 p-4">
          <p className="text-sm font-semibold text-forge-900">
            {appId ? "Change plan ready" : "Build plan ready"}: {proposal.appName}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => decide("approved")}
              disabled={busy}
              className="rounded-xl bg-green-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-green-700 disabled:opacity-50"
            >
              {appId ? "✓ Approve — make this change" : "✓ Approve — build this app"}
            </button>
            <button
              onClick={() => decide("rejected")}
              disabled={busy}
              className="rounded-xl border border-slate-300 bg-white px-5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Not yet
            </button>
          </div>
          {decision === "rejected" && (
            <p className="mt-2 text-xs text-slate-500">
              No problem — keep talking to change the plan.
            </p>
          )}
        </div>
      )}
      {decision === "approved" && (
        <div className="border-t border-green-200 bg-green-50 p-4 text-sm font-medium text-green-800">
          Approved! VoiceForge is building — taking you to the build page…
        </div>
      )}

      {error && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}
    </div>
  );
}
