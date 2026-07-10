import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";

type AuditEntry = {
  userId?: string;
  appId?: string;
  buildRunId?: string;
  action: string;
  /** Sanitized details only — never include secrets or tokens. */
  payload?: Record<string, unknown>;
};

/** Append-only audit trail. Every sensitive action should call this. */
export async function audit(entry: AuditEntry): Promise<void> {
  const db = getDb();
  await db.insert(auditLogs).values({
    userId: entry.userId,
    appId: entry.appId,
    buildRunId: entry.buildRunId,
    action: entry.action,
    payload: entry.payload ?? null,
  });
}
