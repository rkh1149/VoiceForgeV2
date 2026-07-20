import { getDb } from "@/db";
import { buildAgentArtifacts } from "@/db/schema";
import type { BuildAgentArtifactStatus } from "./agent-artifact-utils";

export type { BuildAgentArtifactStatus } from "./agent-artifact-utils";

export type RecordBuildAgentArtifactInput = {
  appId: string;
  buildRunId: string;
  agentKey: string;
  phaseKey: string;
  artifactType: string;
  status?: BuildAgentArtifactStatus;
  summary: string;
  payload?: Record<string, unknown>;
};

export async function recordBuildAgentArtifact(
  input: RecordBuildAgentArtifactInput,
): Promise<void> {
  const db = getDb();
  await db.insert(buildAgentArtifacts).values({
    appId: input.appId,
    buildRunId: input.buildRunId,
    agentKey: input.agentKey,
    phaseKey: input.phaseKey,
    artifactType: input.artifactType,
    status: input.status ?? "passed",
    summary: input.summary,
    payload: input.payload ?? {},
  });
}
