export default function CreateAppPage() {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-bold text-forge-900">Create a new app</h1>
      <p className="mt-1 text-sm text-slate-500">
        Tell VoiceForge what you want to build. It will ask a few questions,
        show you a plan, and only build after you approve.
      </p>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <label
          htmlFor="idea"
          className="block text-sm font-medium text-slate-700"
        >
          What should your app do?
        </label>
        <textarea
          id="idea"
          rows={4}
          disabled
          placeholder="e.g. Build me an app for tracking family recipes…"
          className="mt-2 w-full rounded-xl border border-slate-300 p-3 text-sm placeholder:text-slate-400 disabled:bg-slate-50"
        />
        <button
          disabled
          className="mt-4 w-full rounded-xl bg-forge-600 py-3 font-semibold text-white opacity-50"
        >
          Start planning
        </button>
        <p className="mt-3 text-center text-xs text-slate-400">
          Coming in Stage 1 — the guided planning conversation.
        </p>
      </div>
    </div>
  );
}
