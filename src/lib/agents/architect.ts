import { Agent, run, tool, user } from "@openai/agents";
import type { AppSpec, ComplexityResult } from "@/lib/spec";
import {
  architecturePlanSchema,
  createFallbackArchitecturePlan,
  type ArchitecturePlan,
} from "@/lib/architecture";

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
- VoiceForge member sign-in for generated apps, including owner/editor/viewer role enforcement
- Anonymous shared-link apps can allow collaboration; anonymous public apps are read-only
- Unit tests, build tests, and locked browser/accessibility smoke tests

Current platform capabilities NOT available yet:
- File/blob storage
- Email notifications
- Scheduled jobs
- External integrations
- Arbitrary dependencies or generated API routes

Rules:
- Produce a concrete file-level and component-level plan.
- Be honest about unsupported capabilities. If the approved spec cannot be built faithfully with the current platform, set capabilityValidation.canBuildNow=false and list blockingIssues.
- If a personal/browser-only approximation would be misleading for the user, block instead of downgrading silently.
- Use empty arrays where a section does not apply.
- Do not invent new platform capabilities.`;

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
