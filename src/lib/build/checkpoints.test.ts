import { describe, expect, it } from "vitest";
import {
  BUILD_CHECKPOINT_SCHEMA_VERSION,
  BUILD_CHECKPOINT_MAX_FILE_COUNT,
  BUILD_CHECKPOINT_MAX_SOURCE_BYTES,
  decodeFileMapFromCheckpoint,
  encodeFileMapForCheckpoint,
  getBuildPipelineIdentity,
  isBuildCheckpointCompatible,
} from "./checkpoints";

describe("build checkpoints", () => {
  it("round-trips generated source without storing raw file JSON", () => {
    const files = {
      "package.json": "{\"scripts\":{\"build\":\"next build\"}}",
      "src/app/page.tsx": "export default function Page() { return <main />; }",
    };

    const archive = encodeFileMapForCheckpoint(files);

    expect(archive.encoding).toBe("gzip+base64");
    expect(archive.fileCount).toBe(2);
    expect(archive.data).not.toContain("src/app/page.tsx");
    expect(decodeFileMapFromCheckpoint(archive)).toEqual(files);
  });

  it("rejects unsupported checkpoint archives", () => {
    expect(() =>
      decodeFileMapFromCheckpoint({ encoding: "plain", data: "{}" }),
    ).toThrow("unsupported source archive");
  });

  it("rejects checkpoint file maps containing dependency-sized file counts", () => {
    const files = Object.fromEntries(
      Array.from(
        { length: BUILD_CHECKPOINT_MAX_FILE_COUNT + 1 },
        (_, index) => [`node_modules/package-${index}/index.js`, "module.exports = {}"],
      ),
    );

    expect(() => encodeFileMapForCheckpoint(files)).toThrow(
      `the limit is ${BUILD_CHECKPOINT_MAX_FILE_COUNT}`,
    );
  });

  it("rejects oversized checkpoint source before JSON serialization", () => {
    const files = {
      "src/app/page.tsx": "x".repeat(BUILD_CHECKPOINT_MAX_SOURCE_BYTES + 1),
    };

    expect(() => encodeFileMapForCheckpoint(files)).toThrow(
      "checkpoints may contain source files only",
    );
  });

  it("rejects checkpoints that predate pipeline identity metadata", () => {
    expect(isBuildCheckpointCompatible({ generated: {} })).toBe(false);
  });

  it("accepts checkpoints from the same pipeline deployment", () => {
    const identity = getBuildPipelineIdentity({
      VERCEL_GIT_COMMIT_SHA: "current-commit",
    });

    expect(
      isBuildCheckpointCompatible({ pipelineIdentity: identity }, identity),
    ).toBe(true);
  });

  it("rejects checkpoints from another pipeline deployment", () => {
    expect(
      isBuildCheckpointCompatible(
        {
          pipelineIdentity: {
            checkpointSchemaVersion: BUILD_CHECKPOINT_SCHEMA_VERSION,
            deploymentRevision: "old-commit",
          },
        },
        {
          checkpointSchemaVersion: BUILD_CHECKPOINT_SCHEMA_VERSION,
          deploymentRevision: "current-commit",
        },
      ),
    ).toBe(false);
  });
});
