import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listTemplateFiles,
  TEMPLATE_IGNORED_DIRECTORIES,
} from "./template";

describe("template loader", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("excludes dependencies and generated output from template traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "voiceforge-template-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src", "app"), { recursive: true });
    await writeFile(path.join(root, "src", "app", "page.tsx"), "export default 1;");

    for (const ignoredDirectory of TEMPLATE_IGNORED_DIRECTORIES) {
      const ignoredPath = path.join(root, ignoredDirectory);
      await mkdir(ignoredPath, { recursive: true });
      await writeFile(path.join(ignoredPath, "should-not-load.ts"), "ignored");
    }

    await expect(listTemplateFiles(root)).resolves.toEqual(["src/app/page.tsx"]);
  });
});
