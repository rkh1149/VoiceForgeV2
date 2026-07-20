export const BUILD_AGENT_ARTIFACT_STATUSES = [
  "passed",
  "warning",
  "failed",
  "skipped",
] as const;

export type BuildAgentArtifactStatus =
  (typeof BUILD_AGENT_ARTIFACT_STATUSES)[number];

export function artifactStatusFromIssues(input: {
  failed?: boolean;
  skipped?: boolean;
  warnings?: readonly unknown[];
}): BuildAgentArtifactStatus {
  if (input.failed) return "failed";
  if (input.skipped) return "skipped";
  if ((input.warnings?.length ?? 0) > 0) return "warning";
  return "passed";
}

export function summarizeArtifactFiles(input: {
  label: string;
  filesWritten: readonly string[];
  filesDeleted?: readonly string[];
  limit?: number;
}): string {
  const limit = input.limit ?? 6;
  const changed = input.filesWritten.length;
  const deleted = input.filesDeleted?.length ?? 0;
  const examples = [...input.filesWritten, ...(input.filesDeleted ?? [])].slice(
    0,
    limit,
  );
  const suffix =
    examples.length > 0
      ? `: ${examples.join(", ")}${changed + deleted > examples.length ? ", ..." : ""}`
      : ".";

  return `${input.label} completed with ${changed} changed file${
    changed === 1 ? "" : "s"
  } and ${deleted} deleted file${deleted === 1 ? "" : "s"}${suffix}`;
}
