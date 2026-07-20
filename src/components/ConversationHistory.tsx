import type { ConversationDisplaySession } from "@/lib/conversation-history";

function formatWhen(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function channelLabel(channel: string): string {
  return channel === "voice" ? "Voice conversation" : "Text conversation";
}

export default function ConversationHistory({
  conversations,
}: {
  conversations: ConversationDisplaySession[];
}) {
  if (conversations.length === 0) return null;

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-700">
        Prompts and responses
      </h3>
      <p className="mt-1 text-xs text-slate-400">
        Planning prompts, clarifying questions, and VoiceForge responses for
        this app. Internal tool calls are hidden.
      </p>
      <div className="mt-3 space-y-3">
        {conversations.map((conversation, index) => (
          <details
            key={conversation.id}
            open={index === 0}
            className="border-t border-slate-100 pt-3 first:border-t-0 first:pt-0"
          >
            <summary className="cursor-pointer text-sm font-medium text-slate-800">
              {channelLabel(conversation.channel)}
              <span className="ml-2 text-xs font-normal text-slate-400">
                {formatWhen(conversation.updatedAt)}
              </span>
            </summary>
            {conversation.messages.length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">
                No readable prompts were saved for this session.
              </p>
            ) : (
              <div className="mt-3 max-h-96 space-y-3 overflow-y-auto pr-1">
                {conversation.messages.map((message, messageIndex) => (
                  <div
                    key={`${conversation.id}-${messageIndex}`}
                    className={
                      message.role === "user"
                        ? "border-l-2 border-forge-300 pl-3"
                        : "border-l-2 border-slate-200 pl-3"
                    }
                  >
                    <p className="text-xs font-semibold text-slate-400">
                      {message.role === "user" ? "Prompt" : "VoiceForge"}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                      {message.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </details>
        ))}
      </div>
    </div>
  );
}
