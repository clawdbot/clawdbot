import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "./stage-sandbox-media.test-support.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stage-prune-"));
  tempRoots.push(root);
  return root;
}

describe("pruneEmptyStagedMediaDirs", () => {
  it("removes empty openclaw-staged-* dirs and keeps non-empty and unrelated dirs", async () => {
    const root = await makeWorkspace();
    const inbound = path.join(root, "media", "inbound");
    const emptyStaged = path.join(inbound, "openclaw-staged-00000000-0000-4000-8000-000000000001");
    const nonEmptyStaged = path.join(inbound, "openclaw-staged-00000000-0000-4000-8000-000000000002");
    const unrelated = path.join(inbound, "keep-me");
    await fs.mkdir(emptyStaged, { recursive: true });
    await fs.mkdir(nonEmptyStaged, { recursive: true });
    await fs.writeFile(path.join(nonEmptyStaged, "file.bin"), "x");
    await fs.mkdir(unrelated, { recursive: true });

    await testing.pruneEmptyStagedMediaDirs(root);

    await expect(fs.stat(emptyStaged)).rejects.toThrow();
    await expect(fs.stat(nonEmptyStaged)).resolves.toBeDefined();
    await expect(fs.stat(unrelated)).resolves.toBeDefined();
  });

  it("tolerates a missing inbound directory", async () => {
    const root = await makeWorkspace();
    await expect(testing.pruneEmptyStagedMediaDirs(root)).resolves.toBeUndefined();
  });
});
