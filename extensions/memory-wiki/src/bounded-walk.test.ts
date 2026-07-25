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
});
