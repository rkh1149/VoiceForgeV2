"use client";

import { useState } from "react";

type Version = {
  id: string;
  url: string | null;
  createdAt: string;
  vercelDeploymentId: string | null;
};

export default function VersionHistory({
  appId,
  versions,
  currentDeploymentId,
}: {
  appId: string;
  versions: Version[]; // newest first
  /** From Vercel: which deployment production points at (rollback-aware). */
  currentDeploymentId: string | null;
}) {
  const isCurrent = (v: Version, i: number) =>
    currentDeploymentId
      ? v.vercelDeploymentId === currentDeploymentId
      : i === 0;
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (versions.length < 2) return null; // nothing to roll back to

  async function rollback(deploymentId: string) {
    if (busy) return;
    setBusy(deploymentId);
    setMessage(null);
    try {
      const res = await fetch(`/api/apps/${appId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploymentId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Rollback failed");
      setMessage(
        "Done — the live app now serves that version. (The app's link is unchanged.)",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Rollback failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-700">
        Published versions
      </h3>
      <ul className="mt-2 space-y-2">
        {versions.map((v, i) => (
          <li key={v.id} className="flex items-center justify-between text-sm">
            {/* suppressHydrationWarning: locale date formatting can differ
                between server and browser; the client value wins. */}
            <span className="text-slate-600" suppressHydrationWarning>
              {new Date(v.createdAt).toLocaleString("en-CA", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              {isCurrent(v, i) && (
                <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                  current
                </span>
              )}
            </span>
            {!isCurrent(v, i) && (
              <button
                onClick={() => rollback(v.id)}
                disabled={busy !== null}
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
              >
                {busy === v.id ? "Restoring…" : "Restore this version"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {message && <p className="mt-3 text-xs text-slate-500">{message}</p>}
    </div>
  );
}
