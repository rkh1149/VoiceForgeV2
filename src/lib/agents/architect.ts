import { Agent, run, tool, user } from "@openai/agents";
import type { AppSpec, ComplexityResult } from "@/lib/spec";
import {
  architecturePlanSchema,
  createFallbackArchitecturePlan,
  type ArchitecturePlan,
} from "@/lib/architecture";
import { APPROVED_DEPENDENCY_GUIDANCE } from "../build/dependencies";

const ARCHITECT_MODEL =
  process.env.OPENAI_ARCHITECT_MODEL ??
  process.env.OPENAI_PLANNER_MODEL ??
  "gpt-5.6-terra";

const ARCHITECT_INSTRUCTIONS = `You are VoiceForge's Solution Architect. Convert an approved product specification into an implementation architecture before any code is written.

Current platform capabilities available to generated apps:
- Client-side Next.js/React/Tailwind app
- localStorage persistence for personal/browser-only data
- Locked /api/ai endpoint for AI text and image features
- Locked /api/data endpoint for shared/public platform JSONB records, with optional VoiceForge member sign-in
- Locked /api/files endpoint for generated app uploads, attachments, downloads, metadata, and delete/archive
- Locked /api/notifications endpoint for approved in-app/email notification templates, preferences, and scheduled notification job metadata
- Locked /api/integrations endpoint for approved integration catalogue providers and actions only. Stage 12A approved provider: demo_directory (Demo Directory) with actions list_contacts, lookup_contact, and record_contact_note.
- VoiceForge member sign-in for generated apps, including owner/editor/viewer role enforcement
- Real app membership access is managed from the VoiceForge app dashboard. Generated apps can enforce the current user's role but cannot invite new VoiceForge users or revoke actual app access from inside the generated app yet.
- Anonymous shared-link apps can allow collaboration; anonymous public apps are read-only
- Approved dependency profiles for richer UI, charts, tables, calendars, drag/drop, and CSV/PDF export
- Unit tests, build tests, and locked browser/accessibility smoke tests

Current platform capabilities NOT available yet:
- External integrations outside the approved Stage 12A catalogue. Google Calendar, Gmail/Outlook, Slack, Stripe, Airtable, Notion, webhooks, and arbitrary APIs are still not available until their provider adapters are added.
- Arbitrary background workers, custom cron code, custom email templates, custom recipient email addresses, or direct email provider/API calls
- Arbitrary dependencies or generated API routes

Rules:
- Produce a concrete file-level and component-level plan.
- Select dependencyProfile entries only from the approved catalogue below.
- Be honest about unsupported capabilities. If the approved spec cannot be built faithfully with the current platform, set capabilityValidation.canBuildNow=false and list blockingIssues.
- If a personal/browser-only approximation would be misleading for the user, block instead of downgrading silently.
- Use empty arrays where a section does not apply.
- Do not invent new platform capabilities.
- Notifications must use the locked platform notification service only. Mark email/jobs available when the need fits approved templates, recipient groups, preferences, and platform-managed scheduled notification metadata.
- Integrations must use the locked platform integration service only. Mark integrations available only when every required external provider is in the approved catalogue. For Stage 12A, only demo_directory is approved; all other providers must stay blocked.
- Do not treat VoiceForge's own sign-in, roles, platform data, platform files, platform notifications, or platform scheduled notification jobs as external integrations.
- If a spec asks for generated-app invite/remove-access flows, plan a safe dashboard-managed access note instead of generating fake membership-management UI.

${APPROVED_DEPENDENCY_GUIDANCE}`;

export async function runArchitectAgent(input: {
  spec: AppSpec;
  complexity: ComplexityResult;
}): Promise<ArchitecturePlan> {
  let plan: ArchitecturePlan | null = null;

  const recordArchitecture = tool({
    name: "record_architecture",
    description:
      "Record the complete solution architecture plan for this approved app specification.",
    parameters: architecturePlanSchema,
    execute: async (architecture: ArchitecturePlan) => {
      plan = architecture;
      return "Architecture plan recorded.";
    },
  });

  const agent = new Agent({
    name: "VoiceForge Solution Architect",
    model: ARCHITECT_MODEL,
    instructions: ARCHITECT_INSTRUCTIONS,
    tools: [recordArchitecture],
  });

  const message = `Approved app specification:\n${JSON.stringify(
    input.spec,
    null,
    2,
  )}\n\nComplexity result:\n${JSON.stringify(input.complexity, null, 2)}`;

  await run(agent, [user(message)], { maxTurns: 8 });

  return plan ?? createFallbackArchitecturePlan(input.spec, input.complexity);
}
