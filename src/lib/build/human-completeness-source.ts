import { and, desc, eq, lte } from "drizzle-orm";
import { getDb } from "../../db";
import { conversations, type Requirement } from "../../db/schema";
import { getConversationMessages } from "../conversation-history";
import type { HumanCompletenessSourceContext } from "./human-completeness-review";

export async function loadHumanCompletenessSourceContext(input: {
  requirement: Requirement;
  changeSummary?: string | null;
}): Promise<HumanCompletenessSourceContext> {
  const db = getDb();
  const [linkedConversation] = input.requirement.sourceConversationId
    ? await db
        .select({ transcript: conversations.transcript })
        .from(conversations)
        .where(eq(conversations.id, input.requirement.sourceConversationId))
        .limit(1)
    : [];
  if (linkedConversation) {
    return sourceContext({
      transcript: linkedConversation.transcript,
      provenance: "linked_conversation",
      approvedSummary: input.requirement.plainSummary,
      changeSummary: input.changeSummary,
    });
  }

  const [legacyConversation] = await db
    .select({ transcript: conversations.transcript })
    .from(conversations)
    .where(
      and(
        eq(conversations.appId, input.requirement.appId),
        lte(conversations.updatedAt, input.requirement.createdAt),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  if (legacyConversation) {
    return sourceContext({
      transcript: legacyConversation.transcript,
      provenance: "legacy_conversation",
      approvedSummary: input.requirement.plainSummary,
      changeSummary: input.changeSummary,
    });
  }

  return {
    provenance: "summary_fallback",
    userMessages: [],
    approvedSummary: input.requirement.plainSummary ?? "",
    changeSummary: input.changeSummary ?? "",
  };
}

function sourceContext(input: {
  transcript: unknown;
  provenance: HumanCompletenessSourceContext["provenance"];
  approvedSummary: string | null;
  changeSummary?: string | null;
}): HumanCompletenessSourceContext {
  return {
    provenance: input.provenance,
    userMessages: getConversationMessages(input.transcript)
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    approvedSummary: input.approvedSummary ?? "",
    changeSummary: input.changeSummary ?? "",
  };
}
