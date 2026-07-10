import { currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users, type User } from "@/db/schema";

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * Returns the VoiceForge user record for the signed-in Clerk user,
 * creating it on first visit. Returns null if not signed in.
 */
export async function getOrCreateCurrentUser(): Promise<User | null> {
  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const db = getDb();
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUser.id))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const email =
    clerkUser.primaryEmailAddress?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    "";
  const role = ADMIN_EMAILS.includes(email.toLowerCase()) ? "admin" : "user";

  const inserted = await db
    .insert(users)
    .values({
      clerkUserId: clerkUser.id,
      email,
      displayName: clerkUser.firstName ?? null,
      role,
    })
    .onConflictDoNothing({ target: users.clerkUserId })
    .returning();

  if (inserted.length > 0) return inserted[0];

  // Row was created concurrently; fetch it.
  const refetched = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUser.id))
    .limit(1);
  return refetched[0] ?? null;
}
