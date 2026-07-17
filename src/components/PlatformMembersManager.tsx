"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type MemberRole = "owner" | "editor" | "viewer";

type Membership = {
  id: string;
  appId: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: MemberRole;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  appId: string;
  ownerEmail: string;
  ownerName: string | null;
};

const ROLE_OPTIONS: Array<{ value: MemberRole; label: string; help: string }> = [
  {
    value: "owner",
    label: "Owner",
    help: "Can manage members, schemas, and records.",
  },
  {
    value: "editor",
    label: "Editor",
    help: "Can view, create, update, and delete records.",
  },
  {
    value: "viewer",
    label: "Viewer",
    help: "Can view records only.",
  },
];

function displayPerson(email: string, displayName: string | null): string {
  return displayName?.trim() || email;
}

function roleHelp(role: MemberRole): string {
  return (
    ROLE_OPTIONS.find((option) => option.value === role)?.help ??
    "Can access this app."
  );
}

export default function PlatformMembersManager({
  appId,
  ownerEmail,
  ownerName,
}: Props) {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("editor");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const ownerDisplay = useMemo(
    () => displayPerson(ownerEmail, ownerName),
    [ownerEmail, ownerName],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/platform/data/memberships?appId=${encodeURIComponent(appId)}`,
      );
      const json = (await res.json()) as {
        memberships?: Membership[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Could not load members.");
      setMemberships(json.memberships ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load members.");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/platform/data/memberships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, email, role }),
      });
      const json = (await res.json()) as {
        membership?: Membership;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Could not add member.");
      setEmail("");
      setRole("editor");
      setMessage("Member access saved.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add member.");
    } finally {
      setSaving(false);
    }
  }

  async function updateRole(membershipId: string, nextRole: MemberRole) {
    setError(null);
    setMessage(null);
    const previous = memberships;
    setMemberships((current) =>
      current.map((membership) =>
        membership.id === membershipId
          ? { ...membership, role: nextRole }
          : membership,
      ),
    );
    try {
      const res = await fetch(`/api/platform/data/memberships/${membershipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      const json = (await res.json()) as {
        membership?: Membership;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Could not update role.");
      setMessage("Member role updated.");
      await load();
    } catch (err) {
      setMemberships(previous);
      setError(err instanceof Error ? err.message : "Could not update role.");
    }
  }

  async function removeMember(membershipId: string) {
    setError(null);
    setMessage(null);
    const previous = memberships;
    setMemberships((current) =>
      current.filter((membership) => membership.id !== membershipId),
    );
    try {
      const res = await fetch(`/api/platform/data/memberships/${membershipId}`, {
        method: "DELETE",
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not remove member.");
      setMessage("Member removed.");
    } catch (err) {
      setMemberships(previous);
      setError(err instanceof Error ? err.message : "Could not remove member.");
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">
            Members and roles
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Add VoiceForge users who should be able to use this app&apos;s platform
            data.
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
          {memberships.length + 1} total
        </span>
      </div>

      <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-900">{ownerDisplay}</p>
            <p className="text-xs text-slate-500">{ownerEmail}</p>
          </div>
          <div className="text-left sm:text-right">
            <span className="rounded-full bg-forge-100 px-2 py-0.5 text-xs font-semibold text-forge-700">
              Owner
            </span>
            <p className="mt-1 text-xs text-slate-500">{roleHelp("owner")}</p>
          </div>
        </div>
      </div>

      <form onSubmit={addMember} className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px_auto]">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-700">
            Member email
          </span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="family@example.com"
            required
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-forge-500 focus:ring-2 focus:ring-forge-100"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-700">Role</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as MemberRole)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-forge-500 focus:ring-2 focus:ring-forge-100"
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={saving}
          className="self-end rounded-xl bg-forge-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-forge-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Add"}
        </button>
      </form>

      {error && (
        <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {message && (
        <p className="mt-3 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {message}
        </p>
      )}

      <div className="mt-4 space-y-2">
        {loading && (
          <p className="text-sm text-slate-400">Loading members...</p>
        )}
        {!loading && memberships.length === 0 && (
          <p className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">
            No additional members yet.
          </p>
        )}
        {memberships.map((membership) => (
          <div
            key={membership.id}
            className="rounded-xl border border-slate-100 p-3"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-slate-900">
                  {displayPerson(membership.email, membership.displayName)}
                </p>
                <p className="text-xs text-slate-500">{membership.email}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {roleHelp(membership.role)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`role-${membership.id}`}>
                  Role for {membership.email}
                </label>
                <select
                  id={`role-${membership.id}`}
                  value={membership.role}
                  onChange={(event) =>
                    void updateRole(
                      membership.id,
                      event.target.value as MemberRole,
                    )
                  }
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-forge-500 focus:ring-2 focus:ring-forge-100"
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void removeMember(membership.id)}
                  className="rounded-xl border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
