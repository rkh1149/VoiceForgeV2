export default function ChangeAppPage() {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-bold text-forge-900">Change an app</h1>
      <p className="mt-1 text-sm text-slate-500">
        Ask for changes to any app you own, like “add a shopping list to my
        recipe app.” VoiceForge will confirm the change before building it.
      </p>

      <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
        <p className="text-3xl">🔄</p>
        <p className="mt-3 text-sm text-slate-500">
          Coming in Stage 4 — change requests with preview before going live.
        </p>
      </div>
    </div>
  );
}
