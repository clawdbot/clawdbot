import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkMemoryWikiDirectory } from "./walk.js";

describe("Memory Wiki bounded walk", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("fails instead of silently omitting entries beyond the depth budget", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-wiki-walk-"));
    tempDirs.push(root);
    let nested = root;
    for (let depth = 0; depth < 256; depth += 1) {
      nested = path.join(nested, "d");
    }
    await fs.mkdir(nested, { recursive: true });

    await expect(walkMemoryWikiDirectory(root)).rejects.toThrow(/scan exceeded/u);
  });
});
