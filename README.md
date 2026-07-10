# VoiceForge

A voice-controlled app builder for family and friends. Describe an app in plain language; VoiceForge plans it with you, builds it, tests it, and deploys it.

This is **Stage 0**: the application shell — auth, database schema, and dashboard. The planning conversation (Stage 1), build pipeline (Stage 2), and deployment (Stage 3) come next.

## Stack

Next.js 15 (App Router, TypeScript), Tailwind CSS 4, Clerk (auth), Neon Postgres + Drizzle ORM, hosted on Vercel.

## Local setup

Prerequisite: Node.js 20.9+ (`node --version`). Install from https://nodejs.org if needed.

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run db:push              # creates all tables in Neon
npm run dev                  # open http://localhost:3000
```

### 1. Clerk (sign-in)

1. Create an application at https://dashboard.clerk.com — name it "VoiceForge".
2. Sign-in method: enable **Email** with **Email verification link** (magic link). Disable everything else for simplicity.
3. Go to **Configure → Restrictions** and set sign-up mode to **Restricted** — this makes VoiceForge invite-only. Invite family/friends from the Clerk dashboard (**Users → Invite**).
4. Copy the **Publishable key** and **Secret key** from **API Keys** into `.env.local`.

### 2. Neon (database)

1. Create a free project at https://console.neon.tech (or in Vercel: **Storage → Create Database → Neon**).
2. Copy the pooled connection string into `DATABASE_URL` in `.env.local`.
3. Run `npm run db:push` to create the tables.

### 3. Admin role

Set `ADMIN_EMAILS` in `.env.local` to your email. Whoever signs in with a listed email becomes an admin.

## Verify

```bash
npm run typecheck   # TypeScript
npm run lint        # ESLint
npm run build       # production build
```

## Deploy to Vercel

1. Push this folder to a GitHub repo (e.g. `richardhoyne/voiceforge`).
2. In Vercel: **Add New → Project**, import the repo. Defaults are fine.
3. Add the same environment variables from `.env.local` in **Project → Settings → Environment Variables** (use your Clerk *production* keys once you add a domain; test keys work for previews).
4. Deploy. Pushes to `main` go to production; other branches get preview URLs.

## Database schema

Ten tables mirror the spec: `users`, `apps`, `conversations`, `requirements` (versioned specs), `approvals`, `build_runs` (durable job states), `deployments`, `test_results`, `change_requests`, `audit_logs`. See `src/db/schema.ts`.

## Security notes

- No OpenAI/GitHub/Vercel keys ever reach the browser — server-side only (later stages).
- Sign-up is restricted (invite-only) via Clerk.
- `/dashboard` and `/api` routes require sign-in (see `src/middleware.ts`).
- Every sensitive action in later stages writes to `audit_logs` (`src/lib/audit.ts`).
