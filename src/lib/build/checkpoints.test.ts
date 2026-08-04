import { describe, expect, it } from "vitest";
import {
  decodeFileMapFromCheckpoint,
  encodeFileMapForCheckpoint,
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
});
