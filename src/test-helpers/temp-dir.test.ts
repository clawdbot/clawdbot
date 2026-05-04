import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempDir, withTempDirSync } from "./temp-dir.js";

const parentRoots: string[] = [];

async function makeParentRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-temp-dir-helper-test-"));
  parentRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    parentRoots.splice(0).map((root) =>
      fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      }),
    ),
  );
});

describe("withTempDir", () => {
  it("removes the cached async prefix root when the case finishes", async () => {
    const parentDir = await makeParentRoot();

    await withTempDir({ prefix: "openclaw-leak-check-", parentDir }, async (dir) => {
      await fs.writeFile(path.join(dir, "marker.txt"), "ok");
    });

    await expect(fs.readdir(parentDir)).resolves.toEqual([]);
  });

  it("keeps the cached async prefix root while another case is active", async () => {
    const parentDir = await makeParentRoot();
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withTempDir({ prefix: "openclaw-shared-root-", parentDir }, async (dir) => {
      await fs.writeFile(path.join(dir, "first.txt"), "ok");
      await firstCanFinish;
    });

    await withTempDir({ prefix: "openclaw-shared-root-", parentDir }, async (dir) => {
      await fs.writeFile(path.join(dir, "second.txt"), "ok");
      await expect(fs.readdir(parentDir)).resolves.toHaveLength(1);
    });

    expect(releaseFirst).toBeDefined();
    releaseFirst?.();
    await first;

    await expect(fs.readdir(parentDir)).resolves.toEqual([]);
  });

  it("removes the cached sync prefix root when the case finishes", async () => {
    const parentDir = await makeParentRoot();

    withTempDirSync({ prefix: "openclaw-leak-check-sync-", parentDir }, (dir) => {
      fsSync.writeFileSync(path.join(dir, "marker.txt"), "ok");
    });

    await expect(fs.readdir(parentDir)).resolves.toEqual([]);
  });
});
