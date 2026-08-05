import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkMemoryWikiDirectory } from "./bounded-walk.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-walk-"));
  tempDirs.push(dir);
  return dir;
}

describe("walkMemoryWikiDirectory", () => {
  it("fails instead of truncating at the entry budget", async () => {
    const root = await createTempDir();
    await Promise.all([
      fs.writeFile(path.join(root, "one.md"), "one"),
      fs.writeFile(path.join(root, "two.md"), "two"),
    ]);

    await expect(walkMemoryWikiDirectory(root, "", { maxEntries: 1 })).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("treats a missing optional directory as empty", async () => {
    const root = await createTempDir();

    await expect(walkMemoryWikiDirectory(root, "missing")).resolves.toEqual([]);
  });

  it("prunes ignored subtrees before their descendants consume the budget", async () => {
    const root = await createTempDir();
    await fs.mkdir(path.join(root, "node_modules"));
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fs.writeFile(path.join(root, "node_modules", `ignored-${index}.md`), "ignored"),
      ),
    );
    await fs.writeFile(path.join(root, "visible.md"), "visible");

    await expect(
      walkMemoryWikiDirectory(root, "", {
        maxEntries: 2,
        entryFilter: (entry) =>
          entry.kind === "directory" && path.basename(entry.relativePath) === "node_modules"
            ? "skip-subtree"
            : "include",
      }),
    ).resolves.toEqual([expect.objectContaining({ relativePath: "visible.md", kind: "file" })]);
  });

  it("reports directory failures when partial scans are requested", async () => {
    const root = await createTempDir();

    await expect(
      walkMemoryWikiDirectory(root, "missing", { onDirectoryError: "skip-and-report" }),
    ).resolves.toEqual([
      expect.objectContaining({ relativePath: "missing", kind: "directory-error" }),
    ]);
  });
});
