import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureOutputDirectory } from "./output-directories.js";

async function withTempDir<T>(run: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-output-dir-test-"));
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("ensureOutputDirectory", () => {
  it("creates nested missing output directories", async () => {
    await withTempDir(async (tempDir) => {
      const outputDir = path.join(tempDir, "reports", "downloads");

      await ensureOutputDirectory(outputDir);

      const stat = await fs.stat(outputDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked output directory ancestors",
    async () => {
      await withTempDir(async (tempDir) => {
        const outsideDir = path.join(tempDir, "outside");
        await fs.mkdir(outsideDir);
        const symlinkDir = path.join(tempDir, "downloads");
        await fs.symlink(outsideDir, symlinkDir);

        await expect(ensureOutputDirectory(path.join(symlinkDir, "nested"))).rejects.toThrow(
          /symlink|output directory/i,
        );
        await expectPathMissing(path.join(outsideDir, "nested"));
      });
    },
  );
});
