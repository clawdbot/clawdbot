import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeOwnedTempFile } from "./owned-temp-file.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["parent", "workspace"] as const)(
  "preserves replacement content when the producer's %s directory changes",
  async (scope) => {
    const dir = tempDirs.make("openclaw-owned-output-");
    const parent = path.join(dir, "output");
    await fs.mkdir(parent);
    const stagedPath = path.join(parent, "staged.bin");
    const displaced = path.join(dir, "displaced");
    let replacementPath = "";
    let retainedPath = "";

    await expect(
      writeOwnedTempFile(stagedPath, async (filePath) => {
        await fs.writeFile(filePath, "owned output");
        const replaced = scope === "parent" ? parent : path.dirname(filePath);
        const relativeFile = path.relative(replaced, filePath);
        retainedPath = path.join(displaced, relativeFile);
        replacementPath = path.join(replaced, relativeFile);
        await fs.rename(replaced, displaced);
        await fs.mkdir(path.dirname(replacementPath), { recursive: true });
        await fs.writeFile(replacementPath, "replacement must remain");
      }),
    ).rejects.toMatchObject({ code: "path-mismatch" });

    await expect(fs.readFile(replacementPath, "utf8")).resolves.toBe("replacement must remain");
    await expect(fs.readFile(retainedPath, "utf8")).resolves.toBe("owned output");
    await expect(fs.lstat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("rejects parent identities that collide when rounded to numbers", async () => {
  const dir = tempDirs.make("openclaw-owned-output-identity-");
  const parentPath = path.join(dir, "output");
  await fs.mkdir(parentPath);
  const parent = await fs.realpath(parentPath);
  const stagedPath = path.join(parent, "staged.bin");
  const displaced = path.join(dir, "displaced");
  const originalLstat = fs.lstat;
  const originalStat = fs.stat;
  const firstIdentity = 9_007_199_254_740_992n;
  let replaced = false;
  const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stat = await originalLstat(...args);
    if (args[0] === parent) {
      const identity = firstIdentity + (replaced ? 1n : 0n);
      stat.ino = typeof stat.ino === "bigint" ? identity : Number(identity);
    }
    return stat;
  });
  const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
    const stat = await originalStat(...args);
    if (stat && args[0] === parent) {
      const identity = firstIdentity + (replaced ? 1n : 0n);
      stat.ino = typeof stat.ino === "bigint" ? identity : Number(identity);
    }
    return stat;
  });
  try {
    await expect(
      writeOwnedTempFile(stagedPath, async (filePath) => {
        await fs.writeFile(filePath, "owned output");
        await fs.rename(parent, displaced);
        await fs.mkdir(parent);
        // Keep the original workspace so only the changed parent can reject the handoff.
        await fs.rename(
          path.join(displaced, path.basename(path.dirname(filePath))),
          path.dirname(filePath),
        );
        replaced = true;
      }),
    ).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.lstat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    lstatSpy.mockRestore();
    statSpy.mockRestore();
  }
});
