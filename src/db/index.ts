import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Lazily create the database client so the app can build without a
 * DATABASE_URL (e.g. in CI). Any runtime query without it throws clearly.
 */
function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Add your Neon connection string to .env.local (see .env.example).",
    );
  }
  return drizzle(neon(url), { schema });
}

let _db: ReturnType<typeof createDb> | undefined;

export function getDb() {
  _db ??= createDb();
  return _db;
}

export * as dbSchema from "./schema";
