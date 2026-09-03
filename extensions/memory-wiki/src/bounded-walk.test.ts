import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isMemoryWikiRepositoryOrDependencyDirectory,
  walkMemoryWikiDirectory,
} from "./bounded-walk.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const tempDirs = createMemoryWikiTestHarness();

describe("walkMemoryWikiDirectory", () => {
  it("fails instead of truncating at the entry budget", async () => {
    const root = await tempDirs.createTempDir("memory-wiki-walk-");
    await Promise.all([
      fs.writeFile(path.join(root, "one.md"), "one"),
      fs.writeFile(path.join(root, "two.md"), "two"),
    ]);

    await expect(walkMemoryWikiDirectory(root, "", { maxEntries: 1 })).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("treats a missing optional directory as empty", async () => {
    const root = await tempDirs.createTempDir("memory-wiki-walk-");

    await expect(walkMemoryWikiDirectory(root, "missing")).resolves.toEqual([]);
  });

  it("prunes case-insensitive ignored subtrees before descendants consume the budget", async () => {
    const root = await tempDirs.createTempDir("memory-wiki-walk-");
    const ignoredDirectories = [".GIT", "Node_Modules"];
    await Promise.all(ignoredDirectories.map((directory) => fs.mkdir(path.join(root, directory))));
    await Promise.all(
      ignoredDirectories.flatMap((directory) =>
        Array.from({ length: 10 }, (_, index) =>
          fs.writeFile(path.join(root, directory, `ignored-${index}.md`), "ignored"),
        ),
      ),
    );
    await fs.writeFile(path.join(root, "visible.md"), "visible");

    await expect(
      walkMemoryWikiDirectory(root, "", {
        maxEntries: ignoredDirectories.length + 1,
        entryFilter: (entry) =>
          isMemoryWikiRepositoryOrDependencyDirectory(entry) ? "skip-subtree" : "include",
      }),
    ).resolves.toEqual([expect.objectContaining({ relativePath: "visible.md", kind: "file" })]);
  });

  it("reports directory failures when partial scans are requested", async () => {
    const root = await tempDirs.createTempDir("memory-wiki-walk-");

    await expect(
      walkMemoryWikiDirectory(root, "missing", { onDirectoryError: "skip-and-report" }),
    ).resolves.toEqual([
      expect.objectContaining({ relativePath: "missing", kind: "directory-error" }),
    ]);
  });
});
