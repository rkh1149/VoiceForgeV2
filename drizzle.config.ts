import { defineConfig } from "drizzle-kit";

// drizzle-kit does not load .env.local automatically the way Next.js does.
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local missing — fall through; DATABASE_URL may be set in the shell.
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
