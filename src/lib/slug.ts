import { and, eq, like } from "drizzle-orm";
import { getDb } from "@/db";
import { apps } from "@/db/schema";

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip accents left by NFKD
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "app"
  );
}

/** Returns a slug unique among the owner's apps (appends -2, -3, …). */
export async function uniqueSlugForOwner(
  ownerId: string,
  name: string,
): Promise<string> {
  const base = slugify(name);
  const db = getDb();
  const existing = await db
    .select({ slug: apps.slug })
    .from(apps)
    .where(and(eq(apps.ownerId, ownerId), like(apps.slug, `${base}%`)));

  const taken = new Set(existing.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
