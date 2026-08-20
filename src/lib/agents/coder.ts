import { Agent, MaxTurnsExceededError, run, user } from "@openai/agents";
import type { AppSpec } from "@/lib/spec";
import type { ArchitecturePlan } from "@/lib/architecture";
import type { FileMap } from "@/lib/build/template";
import {
  createAgentFileTools,
  type DiagnosticsContext,
  type FileInspection,
  type FileOperation,
} from "@/lib/agents/file-tools";
import {
  selectChangeWorkflow,
  type ChangeWorkflow,
} from "@/lib/agents/change-workflow";
import {
  CHANGE_GENERATION_PHASES,
  CODE_GENERATION_PHASES,
  DEEP_DIAGNOSTIC_CHANGE_PHASES,
  GENERATION_PHASE_CONTINUATION_TURNS,
  type GenerationPhase,
} from "@/lib/agents/code-phases";
import { platformEntityFromSpec } from "@/lib/platform/spec-seeding";
import { APPROVED_DEPENDENCY_GUIDANCE } from "../build/dependencies";
import type { PhaseAwareDebugContext } from "../build/phase-aware-debug";
import {
  workflowRepairAgentContext,
  type WorkflowRepairPackage,
} from "../build/workflow-repair";
import { synthesizeWorkflowAcceptancePlan } from "../build/workflow-acceptance-plan";
import { createAcceptanceTestManifest } from "../build/acceptance-manifest";

/**
 * Code Agent + Debug Agent.
 *
 * Stage 8C changes generation from one giant pass into explicit phases with
 * file navigation tools. Mutations still go through the same path policy:
 * generated app source/tests only, no configs, no package.json, no API routes.
 */

const CODER_MODEL = process.env.OPENAI_CODER_MODEL ?? "gpt-5.6-terra";

export const SHARED_RULES = `Rules for all files you mutate:
- This is a Next.js 15 App Router project with TypeScript (strict) and Tailwind CSS 4. React 19.
- You may ONLY mutate approved generated-app files via write_file, patch_file, delete_file, or rename_file: src/app/, src/components/, src/lib/, and e2e/generated/. package.json, configs, src/app/globals.css, src/lib/template.test.ts, e2e/smoke.spec.ts, e2e/voiceforge-acceptance.ts, e2e/voiceforge-progress-reporter.ts, e2e/voiceforge-isolation-runner.mjs, e2e/generated/voiceforge-acceptance-manifest.ts, e2e/generated/voiceforge-compiled.spec.ts, and all API routes are locked.
- The app must work through browser code plus locked platform endpoints only: no direct databases, no API keys, no arbitrary external services. If data is personal/browser-only, use localStorage inside client components ("use client") with a typed wrapper in src/lib/storage.ts. If the architecture data model uses storage:"platformData", use the locked src/lib/platform-data.ts client and the locked /api/data endpoint as the source of truth instead of localStorage. If the architecture includes file requirements, use src/lib/platform-files.ts and /api/files for uploads, downloads, metadata, and delete/archive. If the architecture includes notifications or reminders, use src/lib/platform-notifications.ts and /api/notifications for approved sends, preferences, notification lists, and scheduled notification jobs. If the architecture includes approved integrations, use src/lib/platform-integrations.ts and /api/integrations only.
- If an architecture entity uses storage:"none", treat it as built-in typed content in source code. Do not add localStorage, platform-data calls, sign-in, save forms, or upload controls for that entity. Decorative or built-in story/game images are rendered assets or code-native visuals, not user file-upload workflows.
- src/app/api/ai/route.ts, src/app/api/data/route.ts, src/app/api/files/route.ts, src/app/api/notifications/route.ts, and src/app/api/integrations/route.ts are LOCKED platform files — never modify, overwrite, or reimplement them, and never create any other file under src/app/api/.
- For platform data, import from src/lib/platform-data.ts. Call listPlatformRecords, createPlatformRecord, updatePlatformRecord, and deletePlatformRecord from client components. For apps that require sign-in or roles, also call getPlatformSession, signInToPlatform, and signOutPlatformSession; show signed-out, no-access, current-user, and read-only viewer states, and hide/disable write controls when session.canWrite is false. Prefer usePlatformSessionState from src/components/voiceforge-reusable.tsx for route-stable session state. In sign-in-required apps, ALWAYS call getPlatformSession first and store the returned session before calling listPlatformRecords/listPlatformFiles; if session.status is "signed_out" or "no_access", do not fetch records/files yet. During initial auth loading, render a neutral loading state and DO NOT render the sign-in screen while session is null/unknown; this prevents a login flash on every route change. Render a visible sign-in action on every route only after getPlatformSession resolves to signed_out, preferably PlatformSignInGate from src/components/voiceforge-reusable.tsx. If the root route is a sign-in page, redirect or render the main app/dashboard once session.status is "signed_in"; never continue rendering a sign-in button to an already signed-in user. Never fetch session and records/files in the same Promise.all for sign-in-required apps because the data call can fail before the app preserves session.loginUrl. Use the exact platform entity keys and field keys from PLATFORM DATA SCHEMA KEYS, not display labels, plural guesses, PascalCase names, or camelCase aliases. Platform data records are small JSON records (64 KB max): NEVER put raw base64, data URLs, imageBase64, generatedImage, PDF/file bytes, or uploaded file contents in createPlatformRecord/updatePlatformRecord payloads. For generated images and uploads in shared/platform apps, use uploadPlatformFile or uploadPlatformFileData from src/lib/platform-files.ts, then store only the returned file id/reference plus small metadata in platform data. Always show loading and error states. NEVER reference VOICEFORGE_APP_TOKEN, VOICEFORGE_PUBLIC_URL, or the VoiceForge platform URL in browser code.
- Validation helpers must distinguish a field's value from its validation error. Name required-field errors with an Error suffix (for example, recipeIdError = required(draft.recipeId, "Choose a saved recipe.")); never name that error recipeId or use it as though it were the selected id. For related-record validation, only check membership after the required check passes: const recipeError = !recipeIdError && !recipeIds.has(draft.recipeId) ? "Choose an existing saved recipe." : undefined. Add regression tests proving a valid saved relation id is accepted and an unknown relation id is rejected; the valid save test must reach createPlatformRecord.
- Advanced apps must implement the planned workflows as usable UI, not placeholder explanation pages. Every editable planned entity needs role-aware visible create/edit controls, real save/update/delete wiring where the role allows it, and generated unit/workflow or browser tests that exercise that entity. Every planned workflow needs a reachable action path and a generated test that proves the core workflow.
- UI AFFORDANCE CONTRACT: Every user_action workflow start route must be reachable from / through visible, role-appropriate navigation or a clearly labeled contextual control. A generated page file or hidden URL does not make a workflow discoverable. Render every workflow contract control on its exact contract route with the contract accessibleName (minor punctuation differences are fine). Contract controls represent deliberate user gestures only; automatic/result steps are postconditions of the preceding gesture and must not become extra hidden links, buttons, or sentence-length aria-labels. One concise control such as "Play again" may clear state, generate a new round, navigate, and reveal the next question. Every user-managed entity needs a reachable view/list path plus the create/update/delete paths promised by its contract. Do not generate placeholder-only workflow pages. Never use vague standalone action labels such as Submit, Save, Go, Open, Continue, or OK; name the object and action, such as "Save recipe" or "Open GPS tracking". Icon-only controls need an action-specific aria-label. Keep navigation available in both desktop and mobile layouts. When rendering shared navigation with .map(), define its entries as static objects with literal href and label fields, for example { href: "/equipment", label: "Equipment" }; do not hide destinations behind computed functions or opaque runtime-only structures. Data-driven repeated fields must keep each input inside a real label or give it an explicit aria-label. Loading-state buttons must preserve the contracted accessible name, for example aria-label="Save book" while their visible text changes to "Saving book...".
- PERSISTENCE AND HANDOFF CONTRACT: Every expectedSaves transition must call the architecture-selected durable storage with the exact entity key and exact field keys, await the write, retain the returned stable record/file reference, and show success only after the write succeeds. The workflow success route must reload its durable records on fresh mount or screen entry; React state alone is never proof of persistence. Every handoff consumer must load the producer's saved entity from durable storage, use the saved record id and required relationship ids, and expose the loaded record through the contracted downstream control. Calculated, generated, mapped, uploaded, or integration results that a later workflow needs must have an explicit save action or automatic save before navigation. Add focused tests that assert the exact write payload, preserve entered values after a failed save, remount or refresh and see the record again, and save in the producer then select/display that same record in the consumer. For platform files, upload bytes first and persist only the returned file id/reference in platform data.
- For platform search/reports over shared platform records, use the Stage 12B helpers from src/lib/platform-data.ts: searchPlatformRecords, listPlatformRecordSearchConfigs, listPlatformSavedFilters, savePlatformRecordFilter, deletePlatformSavedFilter, runPlatformRecordReport, and exportPlatformRecordsCsv. When the architecture marks the search service required, searchPlatformRecords is mandatory for the promised server-side search/filter/sort workflow; fetching a limited record list and filtering it only in React does not satisfy that requirement. When reports are required, use runPlatformRecordReport or exportPlatformRecordsCsv for the report/export workflow. Saved-filter write controls must be hidden when session.canWrite is false; delete saved filters only when session.canManage is true.
- Generated apps can enforce the current user's VoiceForge owner/editor/viewer role, but they cannot currently invite new VoiceForge users, resend real access invitations, or revoke actual app access from inside the generated app. Do not create fake Invite/Remove-access workflows that imply access changes. If the spec asks for member access management, show an owner-only note that access is managed from the VoiceForge app dashboard, or build clearly labeled app-local contact/member records that do not claim to grant/revoke sign-in access.
- For platform files, import from src/lib/platform-files.ts. Call listPlatformFiles, uploadPlatformFile, downloadPlatformFile, downloadPlatformFileToBrowser, and deletePlatformFile from client components. Link files to records by passing recordId when an attachment belongs to a saved record. Show file type/size/upload errors, preview images from downloadPlatformFile dataUrl when appropriate, and hide upload/delete controls when session.canWrite is false. Do NOT store uploaded files or images in localStorage for shared/platform apps.
- For platform notifications, import from src/lib/platform-notifications.ts. Call sendPlatformNotification only with templateKey "app_reminder" or "app_update", channel "in_app", "email", or "both", and recipientGroup "owner", "editors", "members", or "current_user". Never ask for or store arbitrary recipient email addresses, API keys, SMTP settings, webhook URLs, or provider tokens. For scheduled reminders, call upsertPlatformScheduledJob with a stable jobKey and intervalMinutes of at least 60; do not use setInterval/setTimeout/background loops to simulate cron. Provide notification preferences using getPlatformNotificationPreferences/updatePlatformNotificationPreferences and in-app inbox views using listPlatformNotifications/markPlatformNotificationRead when the workflow calls for them. Hide send/manage controls when session.canWrite or session.canManage is false.
- For platform integrations, import from src/lib/platform-integrations.ts. Prefer typed helpers from that file over raw invokePlatformIntegration calls. Approved providers/actions: providerKey "demo_directory" with actions "list_contacts", "lookup_contact", and "record_contact_note"; providerKey "google_maps" with helpers/actions searchGoogleMapsPlaces/"search_places", getGoogleMapsPlaceDetails/"get_place_details", geocodeGoogleMapsAddress/"geocode_address", computeGoogleMapsRoute/"compute_route", getGoogleMapsElevationProfile/"get_elevation_profile", and getGoogleMapsElevationProfileForRoute for route-aware fallback. For Google Maps trip-planning apps, render place/route results as lists, cards, itinerary timelines, tables, saved records, and an interactive map by importing GoogleMapsTripMap and GooglePlaceAutocomplete from src/components/voiceforge-google-map.tsx. Use GooglePlaceAutocomplete for origin/destination/via waypoint picking when the workflow has location entry; store selected placeId/name/address/location in app state or platform records, never credentials. Pass places, route, routes, selectedRouteIndex/onSelectRoute, and elevationProfile to GoogleMapsTripMap when available. For bicycle trip planners, call computeGoogleMapsRoute with travelMode:"BICYCLE", computeAlternativeRoutes:true only when there are no intermediate waypoints, polylineQuality:"HIGH_QUALITY" for saved bike routes, and do not pass routingPreference. Use intermediate waypoints with via:true for pass-through shaping points and via:false/omitted for actual stops; never combine via:true with optimizeWaypointOrder. After a bicycle route is returned, call getGoogleMapsElevationProfileForRoute(route, {samples:64}) and show climb/descent plus the locked elevation profile card when available; if elevation fails, keep route cards/map visible and show a non-blocking note instead of failing the whole route workflow. Keep returned route warnings/safetyNotice/routeNotice visible. Do not write Google Maps script tags, direct Maps JavaScript calls, API key handling, external map URLs, or custom credential UI; the locked map component loads real tiles/pins/routes/autocomplete and falls back safely when browser maps are unavailable. Never call external URLs directly, never request or store API keys/tokens/webhook URLs in generated app state, and never create credential-management UI inside generated apps. Hide editor-only integration actions when session.canWrite is false and owner-only integration actions when session.canManage is false.
- For built-in device GPS/location, import typed helpers from src/lib/device-location.ts and the reusable DeviceLocationTracker from src/components/voiceforge-reusable.tsx. Use getCurrentDeviceLocation for a single "use my location" action, watchDeviceLocation for active ride/location tracking, summarizeDeviceTrack/formatLocationDistance/formatLocationSpeed for summaries, and exportDeviceTrackGpx for GPX export. Device location is browser-only, requires user permission, and works while the app is active; never promise reliable background tracking when the phone is locked or browser is closed. Save GPS fixes/track points to platform data only when the app needs persistence and session.canWrite is true. Do not call navigator.geolocation directly in generated files; the locked helper owns browser permission/error handling.
- Prefer the locked PlatformFileUploadInput from src/components/voiceforge-reusable.tsx for attachment uploads. If you write a custom <input type="file"> handler, capture const input = event.currentTarget and const file = input.files?.[0] before any await; after the await, reset input.value in finally. Never read event.currentTarget after an awaited upload because React clears it and tests will fail.
- Stage 10/11 reusable modules are available in the locked template. Prefer importing from src/lib/voiceforge-modules.ts and src/components/voiceforge-reusable.tsx for common CRUD helpers, search/filter/sort, comments, activity history, dashboard charts, CSV import/export, simple PDF export, date/calendar controls, drag/drop lists, platform file upload controls, DeviceLocationTracker, usePlatformSessionState, PlatformSignInGate, and role-aware shells.
- For PDF export, generate real PDF bytes with downloadSimplePdf/downloadRecordsPdf from src/lib/voiceforge-modules.ts or with the approved jsPDF package. NEVER create a plain text/HTML/CSV Blob and set type:"application/pdf"; Adobe will reject it as damaged. CSV/text exports may use downloadTextFile or text/csv Blobs, but .pdf files must come from a PDF generator.
- You may import only approved packages from the catalogue below. Never ask to add a package, never edit package.json, and never use CDN/external script URLs.
${APPROVED_DEPENDENCY_GUIDANCE}
- CRITICAL: every page is prerendered on the server at build time, where window/localStorage do not exist. Never touch window or localStorage at module scope, in useState initializers, or during render — ONLY inside useEffect. Initialize state to defaults, then load saved data in a useEffect after mount.
- If a component uses useSearchParams, wrap that component in a React <Suspense> boundary from every page that renders it, with a simple fallback. This prevents Next.js prerender build failures. Keep useSearchParams inside client components only.
- Do not create pages/, src/pages/, 404.tsx, 500.tsx, _document, or _app files — this is App Router only (use not-found.tsx / error.tsx if genuinely needed).
- NEVER reference static asset files (mp3, images, fonts, videos) — you cannot create them, so any such path will 404. And NEVER reference EXTERNAL media URLs either: no stock-photo sites, no Unsplash, no placeholder services (placehold.co etc.), no CDNs, no invented hostnames. The only allowed external browser traffic is from locked platform components such as GoogleMapsTripMap; generated app code must not create those external URLs itself. For sound, synthesize it with the Web Audio API. For graphics and decoration, use inline SVG, CSS gradients, or emoji. For photos/files the user mentions, build an upload feature; use platform files for shared/platform apps, and use small localStorage data URLs only for personal browser-only apps. For generated pictures, use the AI image mode if this app has AI features.
- Style with Tailwind utility classes only. Mobile-first, readable, generous touch targets. The app is used by non-technical family members.
- Accessibility: semantic HTML, labels on inputs, alt text, keyboard operability, and WCAG AA color contrast. Normal-size text needs at least 4.5:1 contrast. In particular, do not put normal or text-lg white text on Tailwind emerald-600, green-600, cyan-600, amber-500, or similarly bright backgrounds; choose a demonstrably darker background (commonly a 700/800 utility) or dark text. Large-text exceptions begin at 24px regular or about 18.7px bold, not 18px bold.
- Write unit/workflow tests under src/ using vitest + @testing-library/react (both installed; jest-dom matchers like toBeInTheDocument are set up). Tests must not rely on localStorage persisting between tests.
- Write browser acceptance tests only under e2e/generated/*.spec.ts. Never edit e2e/smoke.spec.ts.
- STAGE 14H DETERMINISTIC ACCEPTANCE CONTRACT: VoiceForge compiles the acceptance-test manifest and Playwright spec; agents must never create or edit e2e/generated/voiceforge-acceptance-manifest.ts or e2e/generated/voiceforge-compiled.spec.ts. During the acceptance-adapter phase, write only e2e/generated/voiceforge-acceptance-adapters.ts and only when the supplied manifest declares an adapter id. Every required adapter key must be quoted exactly, use visible UI plus the locked acceptance helpers, and finish with a meaningful assertion. Do not duplicate the compiled journey, bypass the UI with storage/API calls, add skips or arbitrary waits, or weaken the original promise. In debug, a failing standard compiled primitive normally indicates the application does not satisfy its workflow contract; repair the named app control/save/handoff. If the interaction is genuinely app-specific, add or repair the named adapter instead of modifying compiler output.
- STAGE 14I ISOLATED FIXTURES: Every compiled journey is a self-contained test. Never transfer records, ids, filenames, emails, or browser-local values through mutable module variables or earlier tests. Implement prerequisite create/edit flows through their visible contract controls so VoiceForge can replay them inside each dependent journey. Keep record labels and relation selectors compatible with run-scoped fixture values. Platform-data requests are isolated by a locked attempt namespace, and parallel-safe journeys run concurrently; application code must not cache test-specific state outside the active browser/session.
- STAGE 14G STABLE CONTRACT CONTROLS: Every rendered user-action contract control MUST place a permanent workflow id and control id from the architecture on the actual interactive element as data-vf-workflow="<workflowId>" and data-vf-control="<controlId>". A shared add/edit component may choose between a finite, code-declared set of literal contract ids, and one physical navigation/filter control reused by equivalent workflows may keep one canonical contract pair; inspect the rendered source and use that same canonical pair in each Playwright journey. Keep ids unchanged when labels, styling, or layout change; never derive ids from visible text, array indexes, record titles, or arbitrary runtime strings. Preserve a concise visible label or accessible name because data attributes do not replace accessibility. For controls repeated inside a map/list/table, put data-vf-entity="<exact entityKey>" and data-vf-record={record.id} on the nearest repeated row/card/container, then keep the shared workflow/control pair on its Edit/Delete/Open action. Do not put workflow/control attributes on a decorative wrapper. Loading and disabled variants retain the same binding. In new Playwright journeys, import vfControl, vfRecord, vfRecords, vfRecordControl, and expectContractControl as needed from ../voiceforge-acceptance; locate contracted actions by the actual rendered workflow/control identity first, scope repeated actions to their record, and use accessible names as assertions rather than primary identity. Accessible-name fallback is only for unchanged legacy apps.
- HUMAN-LANGUAGE PRODUCT COMPLETENESS: The final generated app, generated tests, architecture, approved specification, and original user request are reviewed together. A route, helper, type, test title, or phase note is not evidence by itself. Implement the visible outcome a non-technical user was promised, preserve existing approved capabilities during changes, and make generated acceptance journeys prove those outcomes instead of merely checking that pages or headings render.
- Tests must be deterministic: NEVER use vi.useFakeTimers, real delays, or arbitrary waits. Never use setTimeout/setInterval in components for game or app logic — apply state updates synchronously (skip artificial "thinking" pauses; they break tests and add nothing). In tests use fireEvent from @testing-library/react (@testing-library/user-event is NOT installed) then findBy*/waitFor.
- Write robust test assertions: query by role or aria-label on unique interactive elements, never by text that appears in more than one place or is split across elements (e.g. "0:13 / 0:37" rendered from multiple spans). Prefer getByRole(..., {name}) over getByLabelText when labels may be duplicated by helper text. Visible text inside role="status" does not automatically become that status element's accessible name: unless the element has an explicit aria-label, locate the record by its unique fixture and assert the status with within(record).getByText(...), not getByRole("status", { name: ... }). When repeated records expose data-vf-entity/data-vf-record but no data-testid, query those real attributes with document.querySelector<HTMLElement>(selector), throw if the result is null, and then use within(record); never invent getByTestId locators or pass Element | null into within. In Playwright, accessible-name matching is substring-based by default: use exact: true for literal control names such as "Title", "Name", "Route", or "Save", or use an anchored regular expression, so a locator cannot also match "Search title", "Route name", or another longer label. When a form or dialog shares field names with page filters, first locate the named form/dialog and query its fields from that locator; exact: true alone cannot distinguish two controls with the same accessible name. Scope repeated status text such as Open, Completed, Active, or High to the card/list item containing the test's unique fixture name, so hidden select options cannot satisfy or conflict with the assertion. If a Vitest vi.mock factory references mock functions, define them with vi.hoisted. Fewer, stronger assertions beat many brittle ones. Don't assert on intermediate states that depend on effect timing. For controlled form component tests, pass a complete valid draft or rerender with the changed draft before expecting onSubmit; do not expect a child component to mutate parent props synchronously. For drag/drop tests using fireEvent.dragStart/drop, mock DataTransfer as a MIME-keyed store, e.g. const transferStore = new Map<string, string>(); const dataTransfer = { setData: vi.fn((type, value) => transferStore.set(type, value)), getData: vi.fn((type) => transferStore.get(type) ?? "") }; Real DataTransfer stores values separately by MIME type, so never use one shared string that lets a text/plain fallback overwrite application-specific JSON.
- For TypeScript literal unions in record data, explicitly type payload helper return values and use typed constants or "as const" for literal fields such as status, role, priority, invitation_status, channel, and templateKey. Never let required select/literal fields widen to plain string before passing them to createPlatformRecord, updatePlatformRecord, or React state setters.
- A locked BROWSER TEST runs against every build: it loads /, presses visible buttons, and fails on any JavaScript error, any 404'd resource, or any serious axe accessibility violation. Therefore: the home page must render standalone with sensible defaults, every button must be safe to press in any order without crashing, and accessibility must be real — labels on all inputs and icon-only buttons (aria-label), alt text, sufficient color contrast (no light gray on white backgrounds usually fails), and one h1 per page. During VoiceForge's local browser tests, /api/data, /api/files, /api/notifications, and /api/integrations use safe local fallbacks so platform workflows can be tested before deployment.
- src/app/layout.tsx already exists with correct metadata; only rewrite it if the app truly needs a different shell, and keep the import of "./globals.css".
- Every page must compile under strict TypeScript and pass eslint (next/core-web-vitals). No unused variables, no explicit any.`;

export type GenerationPhaseResult = {
  id: string;
  label: string;
  agentKey: GenerationPhase["agentKey"];
  filesWritten: string[];
  filesDeleted: string[];
  notes: string;
  turnContinuations: number;
  turnLimit: number;
};

export type CodegenResult = {
  files: FileMap; // newly written or changed files only
  deletedFiles: string[];
  notes: string;
  filesWritten: string[];
  phases: GenerationPhaseResult[];
  operations: FileOperation[];
};

export type DebugDiagnostics = {
  failedDomain?: string;
  domainLabel?: string;
  focus?: string;
  responsiblePhase?: PhaseAwareDebugContext["responsiblePhase"];
  scopeLabel?: string;
  scopeReason?: string;
  limitedScope?: boolean;
  visibleFileCount?: number;
  fullFileCount?: number;
  preferredInspectionPaths: string[];
  visibleFilePaths: string[];
  filesInspected: string[];
  inspectionOperations: FileInspection[];
  suspectedRootCause: string;
  strategyChangedFromPriorAttempts: boolean;
};

export type DebugResult = CodegenResult & {
  debugDiagnostics: DebugDiagnostics;
};

/** Extra guidance injected only when the spec includes AI features. */
export function aiUsageNote(spec: AppSpec): string {
  if (spec.aiFeatures.length === 0) return "";
  return `

THIS APP HAS AI FEATURES. Use the locked platform endpoint for ALL of them:
- TEXT: POST /api/ai with JSON {prompt: string, system?: string} → responds {text: string}, or {error: string} with status 400/429/502/503.
- IMAGES: POST /api/ai with JSON {mode: "image", prompt: string} → responds {imageBase64: string} — a REAL PNG. Render it as <img src={\`data:image/png;base64,\${imageBase64}\`} alt="…" />. Image generation takes 5–20 seconds: show a clear loading state. Images have a SMALLER daily limit than text.
- NEVER ask the text mode to produce an image, base64, SVG-as-text, or any binary data — language models cannot generate valid images; always use mode:"image" for pictures.
- Do NOT store generated images in localStorage or platform-data JSON records. A single imageBase64 value can exceed storage quotas or the 64 KB platform-record limit. For shared/platform apps that need saved generated images, call uploadPlatformFileData({fileName, contentType:"image/png", dataBase64:imageBase64}) and save only the returned file id/reference in platform data; use downloadPlatformFile to render it later. For personal browser-only apps, keep at most the latest image in component state and offer a download link (anchor with the data URL and a download attribute).
- Call the endpoint with fetch from client components; always show a loading state while waiting.
- If the response is not ok, display the error message to the user politely (daily limits exist — 429 means "come back tomorrow").
- Keep prompts under 4000 characters. Craft a good "system" string so text answers fit this app's purpose and audience.
- NEVER call OpenAI or any external AI service directly, never reference API keys, and never modify src/app/api/ai/route.ts.
- In tests, mock global.fetch for /api/ai calls — never let tests hit the network.`;
}

export function architectureNote(architecture?: ArchitecturePlan): string {
  if (!architecture) return "";
  return `

ARCHITECTURE PLAN TO FOLLOW:
${JSON.stringify(architecture, null, 2)}

Use the architecture plan as the source of implementation structure: routes, components, data model, file plan, workflow coverage, and tests. Do not implement services marked unavailable or future-platform. If a detail conflicts with the shared rules, the shared rules win.

WORKFLOW CONTRACTS ARE MANDATORY. Implement every contract's starting route, visible controls, ordered steps, exact data operations, persistent saves, visible result, and downstream handoffs. For every user-action control, bind permanent architecture workflow/control ids to the rendered interactive element with data-vf-workflow and data-vf-control. Shared add/edit branches may select between finite literal contract ids; equivalent workflows that deliberately reuse one physical navigation or filter control may use one canonical contract pair, which generated tests must locate consistently. Use each control's accessibleName as the visible label or accessible name, but preserve the permanent ids if friendly wording changes. Repeated record actions also require a nearest data-vf-entity/data-vf-record container. A workflow is not complete when it only calculates or displays transient data if its contract requires a save or a downstream screen to reload that record. In phase notes, name the workflow contract ids completed and call out any contract that remains incomplete.`;
}

export function workflowAcceptancePlanNote(
  spec: AppSpec,
  architecture: ArchitecturePlan | undefined,
  phaseId: string,
): string {
  if (!architecture || !phaseId.includes("browser")) return "";
  const plan = synthesizeWorkflowAcceptancePlan(spec, architecture);
  const manifest = createAcceptanceTestManifest({ spec, architecture });
  return `

STAGE 14D WORKFLOW ACCEPTANCE PLAN (MANDATORY):
${JSON.stringify(plan, null, 2)}

STAGE 14H ACCEPTANCE MANIFEST (VOICEFORGE COMPILES THE SPEC):
${JSON.stringify(manifest, null, 2)}

Do not write a Playwright spec. VoiceForge will compile every journey, step, save, reload, handoff, role context, download, upload, and GPS setup. Implement only the exact adapter ids in manifest.adapters, if any, in e2e/generated/voiceforge-acceptance-adapters.ts. Each adapter is a small app-specific interaction, not a replacement journey. If manifest.adapters is empty, do not create acceptance test code.`;
}

export function platformDataSchemaNote(spec: AppSpec): string {
  if (spec.dataEntities.length === 0) return "";
  const entities = spec.dataEntities.map((entity) =>
    platformEntityFromSpec(entity, spec),
  );
  return `

PLATFORM DATA SCHEMA KEYS:
${JSON.stringify(entities, null, 2)}

When using platform data, every list/create/update/delete call must use entity.key exactly, and every record payload must contain only field.key properties exactly. UI labels may be friendly, but persisted data must use these keys. Payload helper functions should declare the exact app data return type, and select/status fields should stay as literal unions instead of widening to string. Add tests around save workflows that assert createPlatformRecord receives these exact schema keys; local browser tests validate against this schema.`;
}

export async function runCodeAgent(input: {
  spec: AppSpec;
  architecture?: ArchitecturePlan;
  baseFiles?: FileMap;
}): Promise<CodegenResult> {
  const workspaceFiles: FileMap = { ...(input.baseFiles ?? {}) };
  const operations: FileOperation[] = [];
  const phaseResults: GenerationPhaseResult[] = [];

  for (const phase of CODE_GENERATION_PHASES) {
    const phaseResult = await runGenerationPhase({
      mode: "new",
      phase,
      spec: input.spec,
      architecture: input.architecture,
      workspaceFiles,
      operations,
      previousPhases: phaseResults,
    });
    phaseResults.push(phaseResult);
  }

  return collectCodegenResult(workspaceFiles, operations, phaseResults);
}

/** Change mode: modify an existing app's source instead of regenerating. */
export async function runChangeCodeAgent(input: {
  spec: AppSpec; // the UPDATED spec
  changeSummary: string;
  currentFiles: FileMap; // current generated-app files from the live app
  architecture?: ArchitecturePlan;
  forceDeepDiagnostic?: boolean;
  previousFailedChangeCount?: number;
}): Promise<CodegenResult> {
  const workspaceFiles: FileMap = { ...input.currentFiles };
  const operations: FileOperation[] = [];
  const phaseResults: GenerationPhaseResult[] = [];
  const changeWorkflow = selectChangeWorkflow({
    changeSummary: input.changeSummary,
    forceDeepDiagnostic: input.forceDeepDiagnostic,
    previousFailedChangeCount: input.previousFailedChangeCount,
  });
  const phases =
    changeWorkflow.mode === "deep-diagnostic"
      ? DEEP_DIAGNOSTIC_CHANGE_PHASES
      : CHANGE_GENERATION_PHASES;

  for (const phase of phases) {
    const phaseResult = await runGenerationPhase({
      mode: "change",
      phase,
      spec: input.spec,
      architecture: input.architecture,
      workspaceFiles,
      operations,
      previousPhases: phaseResults,
      changeSummary: input.changeSummary,
      changeWorkflow,
    });
    phaseResults.push(phaseResult);
  }

  return collectCodegenResult(workspaceFiles, operations, phaseResults);
}

export async function runDebugAgent(input: {
  spec: AppSpec;
  currentFiles: FileMap; // generated-app files only
  failedStep: string;
  errorOutput: string;
  previousAttempts: string[]; // notes from earlier debug rounds this build
  debugContext?: PhaseAwareDebugContext;
  workflowRepair?: WorkflowRepairPackage;
}): Promise<DebugResult> {
  const workspaceFiles: FileMap = { ...input.currentFiles };
  const operations: FileOperation[] = [];
  const inspections: FileInspection[] = [];
  const diagnostics: DiagnosticsContext = {
    failedStep: input.failedStep,
    errorOutput: input.errorOutput,
    typeErrors: input.failedStep === "typecheck" ? input.errorOutput : undefined,
    testResults: ["lint", "test", "build"].includes(input.failedStep)
      ? input.errorOutput
      : undefined,
    browserFailure: input.failedStep === "e2e" ? input.errorOutput : undefined,
  };

  const agent = new Agent({
    name: "VoiceForge Debug Agent",
    model: CODER_MODEL,
    instructions: `You are an expert Next.js developer fixing a broken generated app. Use list_files, read_file, search_code, and the inspect_* diagnostic tools to identify the root cause. Rewrite or patch ONLY the files that need to change. Keep changes minimal. When finished, reply with one short paragraph explaining the suspected root cause, the fix, and whether this strategy changed from earlier attempts.

PHASE-AWARE DEBUG CONTEXT:
${formatDebugContext(input.debugContext)}

WORKFLOW-AWARE REPAIR RULES:
- When a workflow repair package is supplied, its classification, promise, graph scope, and mutation paths are authoritative. Inspect the producer, save, consumer, and targeted journey named there before editing.
- The file tools enforce the package's mutation allowlist. Do not create a parallel page, component, storage helper, or test outside that scope.
- For targetSurface "generated_test", repair only the generated Playwright journey. Do not modify working application source to satisfy a brittle locator, missing test prerequisite, state-capture mistake, or navigation race.
- For a Playwright strict-mode locator failure, use the browser error's candidate list to make the locator unique. Literal accessible names are substring matches unless exact: true is supplied; prefer exact: true or an anchored regular expression instead of changing the working UI. If exact matching still finds a form field and a page filter with the same name, scope the locator to the named form or dialog. Scope record-state assertions to the card/list item containing the unique fixture, and audit the rest of that journey for the same unscoped locator pattern in the same repair. Text content inside role="status" is not that role's accessible name unless aria-label/aria-labelledby supplies one; repair a getByRole("status", { name: ... }) failure by asserting visible text within the correct record, not by rewriting a working save path.
- For targetSurface "application_source", repair the named control, route, save, refresh, handoff, field-key, or permission path. Do not rewrite unrelated screens, styling, maps, or entities.
- Never disguise a failure by skipping a journey, weakening its promised assertion, bypassing visible UI, or changing labels solely to satisfy a test.
- A contract_control finding names the permanent workflow/control pair. Put finite literal data-vf-workflow and data-vf-control values on the real interactive element in the named workflow route. A shared add/edit component may select between declared literal pairs, and an equivalent shared navigation/filter control may retain its existing canonical pair. Preserve its accessible name. For actions rendered in a record map, add data-vf-entity and data-vf-record={record.id} to the nearest row/card. Do not move the binding to a wrapper or derive an id from current wording.
- An acceptance_test:control finding is a generated-test defect when the application already has the named binding. Replace the brittle wording-based locator with vfControl or a record-scoped vfRecordControl inside that exact workflow step; do not rename or rewrite the working UI.
- An acceptance_test:handoff repair must preserve every existing workflowStepTitle block with its original visible action and assertion. Add the workflowHandoffTitle as an outer block containing that complete step, or as a separate consumer assertion after the complete step. Never move the action out of the workflow step, leave an empty step marker, or trade the missing handoff finding for a missing-step finding.
- An acceptance_compiler: finding may be repaired only in the named application workflow or e2e/generated/voiceforge-acceptance-adapters.ts. Never patch the protected manifest or compiled spec. A missing adapter finding requires the exact quoted adapter id and a visible UI action plus assertion.

Known failure signatures:
- "next build" failing while prerendering /404, /500, or /_error with "<Html> should not be imported outside of pages/_document": a component threw during server prerendering — almost always window or localStorage accessed at module scope, in a useState initializer, or during render. Find that component and move the access into useEffect. Do NOT create 404.tsx/500.tsx/_document/_error files; they are not valid in the App Router and will not fix this.
- "useSearchParams() should be wrapped in a suspense boundary": find every page that renders the client component using useSearchParams and wrap that component in <Suspense fallback={...}> from React. Prefer a small page-level wrapper over forcing the page dynamic.
- "Cannot set properties of null (setting 'value')" from a file input handler: the code read event.currentTarget after an awaited upload. Capture const input = event.currentTarget before await, capture the File before await, and reset input.value in finally.
- "Please sign in" renders with no working sign-in button/link, flashes briefly on every route change, disabled sign-in forever, or returns to the sign-in button immediately after authorization: load getPlatformSession first, store session.loginUrl, keep cached route-stable session state with usePlatformSessionState or equivalent module-level cache, stop fetching records/files while signed_out/no_access, render a neutral loading state while session is null/unknown, render PlatformSignInGate or a visible button that calls signInToPlatform(session) only after signed_out/no_access resolves, and redirect/render the dashboard when session.status is signed_in on the sign-in route.
- "Type 'string' is not assignable to type '<SomeLiteralUnion>'" or platform record state setters reject a PlatformRecord because fields like status/role/priority/invitation_status widened to string: add explicit data/payload return types, typed constants, or "as const" on those literal fields. Preserve the exact union type before createPlatformRecord/updatePlatformRecord/setState.
- A form displays a valid related record (recipe, trip, route, member, project, or similar) but refuses to save it: inspect the validation helper for a field-value/error-variable collision. Required helpers commonly return an error string or undefined, not the selected id. Rename the result to fieldNameError, run the unknown-id membership check only when fieldNameError is absent, and verify both the valid-id save path and unknown-id rejection. Do not patch only the test or mock.
- A drag/drop unit test keeps failing even though the component writes multiple DataTransfer payloads: inspect the test's DataTransfer mock. It must be a MIME-keyed store such as Map<string, string>; one shared string is wrong because setData("text/plain", id) can overwrite setData("application/...", json) in the test even though real browsers store both values.
- The "e2e" step failing: this is the locked browser test plus generated acceptance tests. Its failure messages name the exact problem: JavaScript errors, missing files, external URLs, accessibility violations, or brittle generated acceptance assertions. Prefer fixing the component. If a generated acceptance test is brittle, simplify it under e2e/generated/; never edit e2e/smoke.spec.ts.
- For an axe color-contrast failure, use the diagnostic's exact target, rendered html, foreground/background colors, ratio, font size, and required ratio. Edit that named element's foreground or background utility. Do not infer a nearby tagline or heading when the diagnostic identifies a different element.
- If an earlier attempt already rewrote the SAME test for the same failure, change strategy: fix the component or simplify the test.

${SHARED_RULES}`,
    tools: createAgentFileTools(workspaceFiles, {
      mutationLog: operations,
      inspectionLog: inspections,
      diagnostics,
      allowedMutationPaths: input.workflowRepair?.scope.mutationPaths,
    }),
  });

  const previousSection =
    input.previousAttempts.length > 0
      ? `\nEARLIER FIX ATTEMPTS THIS BUILD (they did NOT resolve the failure):\n${input.previousAttempts
          .map((n, i) => `Attempt ${i + 1}: ${n}`)
          .join("\n")}\n`
      : "";

  const message = `The step "${input.failedStep}" failed.
${previousSection}
Use inspect_test_results, inspect_type_errors, or inspect_browser_failure as appropriate.
${debugContextMessage(input.debugContext)}
${
  input.workflowRepair
    ? `\nWORKFLOW REPAIR PACKAGE (classification is complete; stay inside its mutation scope):\n${workflowRepairAgentContext(input.workflowRepair)}\n`
    : ""
}

APP SPECIFICATION:
${JSON.stringify(input.spec, null, 2)}
${platformDataSchemaNote(input.spec)}

ERROR OUTPUT TAIL:
${input.errorOutput}

Current files are available through list_files/read_file/search_code. Fix the problem. If you identify an actionable source or generated-test repair, you MUST apply it with patch_file or write_file before replying; do not stop after merely describing the edit. Keep inspection focused on the failing file and its directly responsible source path.${aiUsageNote(input.spec)}`;

  const result = await run(agent, [user(message)], { maxTurns: 25 });
  const notes = extractText(result.output);
  const phaseResult = makePhaseResult({
    phase: {
      id: "debug",
      label: `Debug ${input.failedStep}`,
      agentKey: "debug_agent",
      specialistRole:
        "Debug agent: diagnose the failing gauntlet step, inspect the relevant files and diagnostics, and make the smallest source/test patch that addresses the root cause.",
      objective: "Fix the failing build step.",
      maxTurns: 25,
    },
    operations,
    operationStart: 0,
    workspaceFiles,
    notes,
  });

  return {
    ...collectCodegenResult(workspaceFiles, operations, [phaseResult]),
    debugDiagnostics: {
      failedDomain: input.debugContext?.failedDomain,
      domainLabel: input.debugContext?.domainLabel,
      focus: input.debugContext?.focus,
      responsiblePhase: input.debugContext?.responsiblePhase,
      scopeLabel: input.debugContext?.scopeLabel,
      scopeReason: input.debugContext?.scopeReason,
      limitedScope: input.debugContext?.limitedScope,
      visibleFileCount: input.debugContext?.visibleFileCount,
      fullFileCount: input.debugContext?.fullFileCount,
      preferredInspectionPaths: input.debugContext?.preferredInspectionPaths ?? [],
      visibleFilePaths: input.debugContext?.visibleFilePaths ?? [],
      filesInspected: inspectedFiles(inspections),
      inspectionOperations: inspections.slice(0, 100),
      suspectedRootCause: suspectedRootCauseFromNotes(notes, input.errorOutput),
      strategyChangedFromPriorAttempts: strategyChangedFromPriorAttempts({
        previousAttempts: input.previousAttempts,
        notes,
        filesWritten: pathsWithContent(workspaceFiles, operations),
      }),
    },
  };
}

function formatDebugContext(context?: PhaseAwareDebugContext): string {
  if (!context) {
    return "No phase-aware context was supplied; diagnose from the failed step and visible files.";
  }
  const preferred =
    context.preferredInspectionPaths.length > 0
      ? context.preferredInspectionPaths.slice(0, 20).join(", ")
      : "none";
  return [
    `- Failed domain: ${context.domainLabel} (${context.failedDomain})`,
    `- Failure focus: ${context.focus}`,
    `- Original responsible phase: ${context.responsiblePhase.label} [${context.responsiblePhase.agentKey}] (${context.responsiblePhase.id})`,
    `- Responsible phase reason: ${context.responsiblePhase.reason}`,
    `- Visible scope: ${context.scopeLabel}; ${context.visibleFileCount}/${context.fullFileCount} file(s) visible`,
    `- Scope reason: ${context.scopeReason}`,
    `- Preferred inspection files: ${preferred}`,
    ...context.instructions.map((instruction) => `- ${instruction}`),
  ].join("\n");
}

function debugContextMessage(context?: PhaseAwareDebugContext): string {
  if (!context) return "";
  return `
DEBUG DOMAIN: ${context.domainLabel}
ORIGINAL RESPONSIBLE PHASE: ${context.responsiblePhase.label} [${context.responsiblePhase.agentKey}]
VISIBLE DEBUG SCOPE: ${context.scopeLabel} (${context.visibleFileCount}/${context.fullFileCount} files)
PREFERRED FILES TO INSPECT FIRST:
${context.preferredInspectionPaths.map((path) => `- ${path}`).join("\n") || "- none"}
DEBUG INSTRUCTIONS:
${context.instructions.map((instruction) => `- ${instruction}`).join("\n")}
`;
}

function inspectedFiles(inspections: readonly FileInspection[]): string[] {
  const paths = new Set<string>();
  for (const inspection of inspections) {
    if (inspection.path) paths.add(inspection.path);
    for (const path of inspection.matchedPaths ?? []) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

function suspectedRootCauseFromNotes(notes: string, errorOutput: string): string {
  const normalized = notes.trim().replace(/\s+/g, " ");
  if (normalized) {
    const firstSentence = normalized.match(/^(.{1,280}?[.!?])(\s|$)/)?.[1];
    return firstSentence ?? normalized.slice(0, 280);
  }
  const errorTail = errorOutput.trim().replace(/\s+/g, " ").slice(-280);
  return errorTail || "The debug agent did not return a root-cause summary.";
}

function strategyChangedFromPriorAttempts(input: {
  previousAttempts: readonly string[];
  notes: string;
  filesWritten: readonly string[];
}): boolean {
  if (input.previousAttempts.length === 0) return false;
  const currentTokens = tokenSet(
    `${input.notes} ${input.filesWritten.join(" ")}`.toLowerCase(),
  );
  if (currentTokens.size === 0) return false;
  return input.previousAttempts.every((attempt) => {
    const previousTokens = tokenSet(attempt.toLowerCase());
    return jaccardSimilarity(currentTokens, previousTokens) < 0.55;
  });
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .split(/[^a-z0-9_/-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : overlap / union;
}

async function runGenerationPhase(input: {
  mode: "new" | "change";
  phase: GenerationPhase;
  spec: AppSpec;
  architecture?: ArchitecturePlan;
  workspaceFiles: FileMap;
  operations: FileOperation[];
  previousPhases: GenerationPhaseResult[];
  changeSummary?: string;
  changeWorkflow?: ChangeWorkflow;
}): Promise<GenerationPhaseResult> {
  const operationStart = input.operations.length;
  const agent = new Agent({
    name: `VoiceForge ${input.phase.agentKey} - ${input.phase.label}`,
    model: CODER_MODEL,
    instructions: `${input.mode === "new" ? "You are building a new generated app" : "You are modifying an existing generated app"} in a controlled multi-agent pipeline. Complete only the current specialist phase. Use list_files, read_file, and search_code to understand existing files before importing from or patching them. Reply with a concise phase summary and any limitations.

Current phase: ${input.phase.label}
Specialist identity: ${input.phase.agentKey}
Specialist role: ${input.phase.specialistRole}
Objective: ${input.phase.objective}
${changeWorkflowInstruction(input.changeWorkflow)}

${SHARED_RULES}`,
    tools: createAgentFileTools(input.workspaceFiles, {
      mutationLog: input.operations,
      allowMutations: input.phase.allowMutations,
    }),
  });

  const previous =
    input.previousPhases.length > 0
      ? `\nPREVIOUS PHASE NOTES:\n${input.previousPhases
          .map(
            (phase) =>
              `- ${phase.label} [${phase.agentKey}]: ${phase.notes || "no notes"} (${phase.filesWritten.length} changed, ${phase.filesDeleted.length} deleted)`,
          )
          .join("\n")}\n`
      : "";
  const change =
    input.mode === "change"
      ? `\nREQUESTED CHANGE:\n${input.changeSummary ?? "Apply the approved specification update."}\n${changeWorkflowMessage(input.changeWorkflow)}`
      : "";

  const message = `${input.mode === "new" ? "Build" : "Update"} this app through the current phase only.
${change}${previous}
APP SPECIFICATION:
${JSON.stringify(input.spec, null, 2)}
${architectureNote(input.architecture)}
${workflowAcceptancePlanNote(input.spec, input.architecture, input.phase.id)}
${platformDataSchemaNote(input.spec)}

Use the file tools instead of assuming file contents. ${
    input.mode === "change"
      ? input.changeWorkflow?.mode === "deep-diagnostic"
        ? "Deep diagnostic mode is active: start with inspect_app_map when mapping or tracing, then read every file that participates in the requested workflow. You may inspect broadly to understand cross-file behavior, but keep edits scoped to the root cause."
        : "Standard change mode is active: search and inspect the files likely impacted by the targeted change."
      : "List files first if you need to know what earlier phases created."
  }
${aiUsageNote(input.spec)}`;

  let result: { output: unknown[] };
  let turnContinuations = 0;
  let turnLimit = input.phase.maxTurns;
  try {
    result = await run(agent, [user(message)], {
      maxTurns: turnLimit,
    });
  } catch (error) {
    if (!(error instanceof MaxTurnsExceededError) || !error.state) {
      throw error;
    }
    turnContinuations = 1;
    turnLimit += GENERATION_PHASE_CONTINUATION_TURNS;
    try {
      result = await run(agent, error.state, { maxTurns: turnLimit });
    } catch (continuationError) {
      if (continuationError instanceof MaxTurnsExceededError) {
        throw new Error(
          `Generation phase "${input.phase.label}" exceeded ${turnLimit} turns after one automatic continuation.`,
          { cause: continuationError },
        );
      }
      throw continuationError;
    }
  }

  return makePhaseResult({
    phase: input.phase,
    operations: input.operations,
    operationStart,
    workspaceFiles: input.workspaceFiles,
    notes: extractText(result.output),
    turnContinuations,
    turnLimit,
  });
}

function changeWorkflowInstruction(workflow?: ChangeWorkflow): string {
  if (!workflow || workflow.mode !== "deep-diagnostic") return "";
  return `

DEEP DIAGNOSTIC CHANGE MODE:
- Trigger reasons: ${workflow.reasons.join("; ")}.
- Follow the seven-step workflow across the phases: classify, map, trace, reproduce with tests, fix root cause, add browser coverage, and stabilize repeated-change fixes.
- Treat Save/Submit bugs as cross-cutting until proven otherwise: trace form state, validation, payload shape, platform-data/localStorage calls, state refresh, rendering, and persistence.
- Do not only rewrite tests to pass. A reproduction test may be updated for robustness, but the source workflow must be repaired when behavior is broken.
- If this mode was triggered after failed changes, change strategy and explicitly avoid repeating a symptom-only patch.`;
}

function changeWorkflowMessage(workflow?: ChangeWorkflow): string {
  if (!workflow) return "";
  const focus = workflow.acceptanceFocus
    .map((item) => `- ${item}`)
    .join("\n");
  return `
CHANGE WORKFLOW MODE: ${workflow.mode}
MODE REASONS: ${workflow.reasons.join("; ")}
ACCEPTANCE FOCUS:
${focus}
`;
}

function makePhaseResult(input: {
  phase: GenerationPhase;
  operations: FileOperation[];
  operationStart: number;
  workspaceFiles: FileMap;
  notes: string;
  turnContinuations?: number;
  turnLimit?: number;
}): GenerationPhaseResult {
  const phaseOperations = input.operations.slice(input.operationStart);
  const filesWritten = pathsWithContent(input.workspaceFiles, phaseOperations);
  const filesDeleted = deletedPaths(phaseOperations);
  return {
    id: input.phase.id,
    label: input.phase.label,
    agentKey: input.phase.agentKey,
    filesWritten,
    filesDeleted,
    notes: input.notes,
    turnContinuations: input.turnContinuations ?? 0,
    turnLimit: input.turnLimit ?? input.phase.maxTurns,
  };
}

function collectCodegenResult(
  workspaceFiles: FileMap,
  operations: FileOperation[],
  phases: GenerationPhaseResult[],
): CodegenResult {
  const filesWritten = pathsWithContent(workspaceFiles, operations);
  const deletedFiles = deletedPaths(operations);
  const files: FileMap = {};
  for (const filePath of filesWritten) {
    const content = workspaceFiles[filePath];
    if (content !== undefined) files[filePath] = content;
  }
  const notes = phases
    .map(
      (phase) =>
        `${phase.label} [${phase.agentKey}]: ${phase.notes || "No notes."}`,
    )
    .join("\n");

  return {
    files,
    deletedFiles,
    notes,
    filesWritten,
    phases,
    operations,
  };
}

function pathsWithContent(
  workspaceFiles: FileMap,
  operations: FileOperation[],
): string[] {
  const paths = new Set<string>();
  for (const operation of operations) {
    const filePath =
      operation.operation === "rename" ? operation.targetPath : operation.path;
    if (filePath && workspaceFiles[filePath] !== undefined) {
      paths.add(filePath);
    }
  }
  return [...paths].sort();
}

function deletedPaths(operations: FileOperation[]): string[] {
  const paths = new Set<string>();
  for (const operation of operations) {
    if (operation.operation === "delete" || operation.operation === "rename") {
      paths.add(operation.path);
    }
  }
  return [...paths].sort();
}

/** Collect non-empty assistant text (same reasoning-model quirk as planner). */
function extractText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    const msg = item as {
      type?: string;
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (msg.type === "message" && msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === "output_text" && c.text?.trim()) parts.push(c.text.trim());
      }
    }
  }
  return parts.join("\n\n");
}
