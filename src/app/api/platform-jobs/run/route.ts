import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { runDuePlatformScheduledJobs } from "@/lib/platform/notifications";

/**
 * Locked platform job runner. This endpoint is suitable for Vercel Cron or a
 * manual operational trigger; generated apps can create job metadata through
 * /api/platform-notifications but cannot execute arbitrary background code.
 */

export async function POST(req: Request) {
  const secret = process.env.VOICEFORGE_CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Scheduled job execution is not configured." },
      { status: 503 },
    );
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runDuePlatformScheduledJobs(getDb());
  return NextResponse.json({ ok: true, ...result });
}
