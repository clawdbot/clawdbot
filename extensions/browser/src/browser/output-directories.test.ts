// Browser tests cover output directories plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureOutputDirectory } from "./output-directories.js";

const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

async function withTempDir<T>(run: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-output-dir-test-"));
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let error: unknown;
  try {
    await fs.access(targetPath);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
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

  it("rejects symlinked output directory ancestors", async ({ skip }) => {
    await withTempDir(async (tempDir) => {
      const outsideDir = path.join(tempDir, "outside");
      await fs.mkdir(outsideDir);
      const symlinkDir = path.join(tempDir, "downloads");
      try {
        await fs.symlink(outsideDir, symlinkDir, directorySymlinkType);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM" || code === "ENOTSUP") {
          skip("directory links are unavailable on this host");
          return;
        }
        throw error;
      }

      await expect(ensureOutputDirectory(path.join(symlinkDir, "nested"))).rejects.toThrow(
        /symlink|output directory/i,
      );
      await expectPathMissing(path.join(outsideDir, "nested"));
    });
  });
});
