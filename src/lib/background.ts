import { waitUntil } from "@vercel/functions";

/**
 * Run long work after the response is sent. Locally a floating promise is
 * fine (the dev server stays alive); on Vercel the function freezes after
 * responding unless the promise is registered with waitUntil.
 */
export function runInBackground(fn: () => Promise<void>, label: string): void {
  const promise = fn().catch((err) =>
    console.error(`Background job crashed (${label}):`, err),
  );
  if (process.env.VERCEL) {
    waitUntil(promise);
  }
}
