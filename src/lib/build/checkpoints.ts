import { gzipSync, gunzipSync } from "zlib";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { buildAgentArtifacts } from "../../db/schema";
import type { FileMap } from "./template";

export const BUILD_CHECKPOINT_ARTIFACT_TYPE = "checkpoint";
export const BUILD_CHECKPOINT_AGENT_KEY = "pipeline_checkpoint";
export const BUILD_CHECKPOINT_MAX_FILE_COUNT = 2_000;
export const BUILD_CHECKPOINT_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const BUILD_CHECKPOINT_SCHEMA_VERSION = 2;

type BuildPipelineIdentity = {
  checkpointSchemaVersion: number;
  deploymentRevision: string | null;
};

export type BuildCheckpointStage =
  | "reviewing"
  | "testing"
  | "publish_pending";

type EncodedFileMap = {
  encoding: "gzip+base64";
  data: string;
  fileCount: number;
  byteLength: number;
};

type BuildCheckpointPayload = {
  version: 1;
  stage: BuildCheckpointStage;
  archive: EncodedFileMap;
  metadata: Record<string, unknown>;
  savedAt: string;
};

export type LoadedBuildCheckpoint<TMetadata = Record<string, unknown>> = {
  id: string;
  stage: BuildCheckpointStage;
  files: FileMap;
  metadata: TMetadata;
  createdAt: Date;
};

export function getBuildPipelineIdentity(
  env: Record<string, string | undefined> = process.env,
): BuildPipelineIdentity {
  return {
    checkpointSchemaVersion: BUILD_CHECKPOINT_SCHEMA_VERSION,
    deploymentRevision: env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
  };
}

export function isBuildCheckpointCompatible(
  metadata: unknown,
  currentIdentity: BuildPipelineIdentity = getBuildPipelineIdentity(),
): boolean {
  if (!isRecord(metadata) || !isRecord(metadata.pipelineIdentity)) {
    return false;
  }
  const savedIdentity = metadata.pipelineIdentity;
  if (
    savedIdentity.checkpointSchemaVersion !==
    currentIdentity.checkpointSchemaVersion
  ) {
    return false;
  }
  if (
    currentIdentity.deploymentRevision &&
    savedIdentity.deploymentRevision !== currentIdentity.deploymentRevision
  ) {
    return false;
  }
  return true;
}

export function encodeFileMapForCheckpoint(files: FileMap): EncodedFileMap {
  const paths = Object.keys(files);
  if (paths.length > BUILD_CHECKPOINT_MAX_FILE_COUNT) {
    throw new Error(
      `Build checkpoint contains ${paths.length} files; the limit is ${BUILD_CHECKPOINT_MAX_FILE_COUNT}. ` +
        "Dependency or build-output directories must not be included in generated app source.",
    );
  }

  let sourceBytes = 0;
  for (const path of paths) {
    sourceBytes +=
      Buffer.byteLength(path, "utf8") + Buffer.byteLength(files[path], "utf8");
    if (sourceBytes > BUILD_CHECKPOINT_MAX_SOURCE_BYTES) {
      throw new Error(
        `Build checkpoint source exceeds ${formatMegabytes(BUILD_CHECKPOINT_MAX_SOURCE_BYTES)}. ` +
          "Generated app checkpoints may contain source files only, not dependencies or build output.",
      );
    }
  }

  const json = JSON.stringify(files);
  return {
    encoding: "gzip+base64",
    data: gzipSync(Buffer.from(json, "utf8")).toString("base64"),
    fileCount: paths.length,
    byteLength: Buffer.byteLength(json, "utf8"),
  };
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function decodeFileMapFromCheckpoint(archive: unknown): FileMap {
  if (!isRecord(archive)) {
    throw new Error("Build checkpoint is missing its source archive.");
  }
  if (archive.encoding !== "gzip+base64" || typeof archive.data !== "string") {
    throw new Error("Build checkpoint uses an unsupported source archive.");
  }

  const json = gunzipSync(Buffer.from(archive.data, "base64")).toString("utf8");
  const parsed = JSON.parse(json) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Build checkpoint source archive is invalid.");
  }

  const files: FileMap = {};
  for (const [path, content] of Object.entries(parsed)) {
    if (typeof path === "string" && typeof content === "string") {
      files[path] = content;
    }
  }
  return files;
}

export async function saveBuildCheckpoint(input: {
  appId: string;
  buildRunId: string;
  stage: BuildCheckpointStage;
  files: FileMap;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const db = getDb();
  const archive = encodeFileMapForCheckpoint(input.files);
  const payload: BuildCheckpointPayload = {
    version: 1,
    stage: input.stage,
    archive,
    metadata: {
      ...(input.metadata ?? {}),
      pipelineIdentity: getBuildPipelineIdentity(),
    },
    savedAt: new Date().toISOString(),
  };

  const [saved] = await db
    .insert(buildAgentArtifacts)
    .values({
      appId: input.appId,
      buildRunId: input.buildRunId,
      agentKey: BUILD_CHECKPOINT_AGENT_KEY,
      phaseKey: input.stage,
      artifactType: BUILD_CHECKPOINT_ARTIFACT_TYPE,
      status: "passed",
      summary:
        input.stage === "publish_pending"
          ? `Saved durable source checkpoint for publishing (${archive.fileCount} files).`
          : input.stage === "reviewing"
            ? `Saved durable source checkpoint for workflow review (${archive.fileCount} files).`
            : `Saved durable source checkpoint for testing (${archive.fileCount} files).`,
      payload: payload as unknown as Record<string, unknown>,
    })
    .returning({ id: buildAgentArtifacts.id });
  if (!saved) throw new Error("Build checkpoint could not be persisted.");
  return saved.id;
}

export async function loadBuildCheckpointById<
  TMetadata = Record<string, unknown>,
>(
  checkpointId: string,
  buildRunId: string,
): Promise<LoadedBuildCheckpoint<TMetadata> | null> {
  const db = getDb();
  const rows = await db
    .select({
      id: buildAgentArtifacts.id,
      phaseKey: buildAgentArtifacts.phaseKey,
      payload: buildAgentArtifacts.payload,
      createdAt: buildAgentArtifacts.createdAt,
    })
    .from(buildAgentArtifacts)
    .where(
      and(
        eq(buildAgentArtifacts.id, checkpointId),
        eq(buildAgentArtifacts.buildRunId, buildRunId),
        eq(buildAgentArtifacts.agentKey, BUILD_CHECKPOINT_AGENT_KEY),
        eq(buildAgentArtifacts.artifactType, BUILD_CHECKPOINT_ARTIFACT_TYPE),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const payload = row.payload as unknown;
  if (!isCheckpointPayload(payload)) {
    throw new Error("Build checkpoint payload is invalid.");
  }
  return {
    id: row.id,
    stage: payload.stage,
    files: decodeFileMapFromCheckpoint(payload.archive),
    metadata: payload.metadata as TMetadata,
    createdAt: row.createdAt,
  };
}

export async function loadLatestBuildCheckpoint<TMetadata = Record<string, unknown>>(
  buildRunId: string,
  stage?: BuildCheckpointStage,
): Promise<LoadedBuildCheckpoint<TMetadata> | null> {
  const db = getDb();
  const rows = await db
    .select({
      id: buildAgentArtifacts.id,
      phaseKey: buildAgentArtifacts.phaseKey,
      payload: buildAgentArtifacts.payload,
      createdAt: buildAgentArtifacts.createdAt,
    })
    .from(buildAgentArtifacts)
    .where(
      and(
        eq(buildAgentArtifacts.buildRunId, buildRunId),
        eq(buildAgentArtifacts.agentKey, BUILD_CHECKPOINT_AGENT_KEY),
        eq(buildAgentArtifacts.artifactType, BUILD_CHECKPOINT_ARTIFACT_TYPE),
        ...(stage ? [eq(buildAgentArtifacts.phaseKey, stage)] : []),
      ),
    )
    .orderBy(desc(buildAgentArtifacts.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const payload = row.payload as unknown;
  if (!isCheckpointPayload(payload)) {
    throw new Error("Build checkpoint payload is invalid.");
  }
  return {
    id: row.id,
    stage: payload.stage,
    files: decodeFileMapFromCheckpoint(payload.archive),
    metadata: payload.metadata as TMetadata,
    createdAt: row.createdAt,
  };
}

export async function getLatestBuildCheckpointStage(
  buildRunId: string,
): Promise<BuildCheckpointStage | null> {
  const checkpoint = await loadLatestBuildCheckpoint(buildRunId);
  return checkpoint?.stage ?? null;
}

export async function getBuildRunsWithCheckpoints(
  buildRunIds: string[],
): Promise<Set<string>> {
  if (buildRunIds.length === 0) return new Set();
  const db = getDb();
  const rows = await db
    .select({ buildRunId: buildAgentArtifacts.buildRunId })
    .from(buildAgentArtifacts)
    .where(
      and(
        inArray(buildAgentArtifacts.buildRunId, buildRunIds),
        eq(buildAgentArtifacts.agentKey, BUILD_CHECKPOINT_AGENT_KEY),
        eq(buildAgentArtifacts.artifactType, BUILD_CHECKPOINT_ARTIFACT_TYPE),
      ),
    );
  return new Set(rows.map((row) => row.buildRunId));
}

function isCheckpointPayload(value: unknown): value is BuildCheckpointPayload {
  return (
    isRecord(value) &&
    value.version === 1 &&
    (value.stage === "reviewing" ||
      value.stage === "testing" ||
      value.stage === "publish_pending") &&
    isRecord(value.archive) &&
    isRecord(value.metadata) &&
    typeof value.savedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
