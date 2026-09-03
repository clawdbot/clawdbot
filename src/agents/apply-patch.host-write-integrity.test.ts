/**
 * Regression tests for apply_patch host (workspaceOnly: false) write integrity.
 * Mirrors agent-tools.read.host-write-integrity.test.ts: a failed update-hunk
 * write must not truncate the original host file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyPatch } from "./apply-patch.test-support.js";

describe("apply_patch unrestricted host writes", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createHostFile(content: string) {
    const tempDir = tempDirs.make("openclaw-patch-host-write-");
    const filePath = path.join(tempDir, "important.txt");
    await fs.writeFile(filePath, content);
    return filePath;
  }

  function failPrefixWrites(filePath: string, originalByteLength: number) {
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags as never, mode as never);
      if (String(target) === filePath && flags === "r+") {
        const realWrite = handle.write.bind(handle);
        let failed = false;
        handle.write = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          if (!failed && position < originalByteLength) {
            failed = true;
            await realWrite(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          }
          return realWrite(buffer, offset, length, position);
        }) as typeof handle.write;
      }
      return handle;
    });
  }

  function failExtensionWrites(filePath: string, originalByteLength: number) {
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags as never, mode as never);
      if (String(target) === filePath && flags === "r+") {
        const realWrite = handle.write.bind(handle);
        handle.write = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          const result = await realWrite(buffer, offset, length, position);
          if (position >= originalByteLength) {
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          }
          return result;
        }) as typeof handle.write;
      }
      return handle;
    });
  }

  function buildUpdatePatch(filePath: string): string {
    return `*** Begin Patch
*** Update File: ${filePath}
@@
-original
+replacement
*** End Patch`;
  }

  it("keeps the original host file when an update hunk fails partway through the write", async () => {
    const originalContent = `original\n${"important content\n".repeat(64)}`;
    const filePath = await createHostFile(originalContent);
    failPrefixWrites(filePath, Buffer.byteLength(originalContent));

    await expect(
      applyPatch(buildUpdatePatch(filePath), { cwd: path.dirname(filePath), workspaceOnly: false }),
    ).rejects.toThrow("disk full");

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(["important.txt"]);
  });

  it("keeps the original host file when an update hunk cannot extend the file", async () => {
    const originalContent = "original\n";
    const filePath = await createHostFile(originalContent);
    failExtensionWrites(filePath, Buffer.byteLength(originalContent));

    await expect(
      applyPatch(buildUpdatePatch(filePath), { cwd: path.dirname(filePath), workspaceOnly: false }),
    ).rejects.toThrow("disk full");

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(originalContent);
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(["important.txt"]);
  });

  it.runIf(process.platform !== "win32")("applies host update hunks in place", async () => {
    const filePath = await createHostFile("original\n");
    await fs.chmod(filePath, 0o640);
    const before = await fs.stat(filePath);

    const result = await applyPatch(buildUpdatePatch(filePath), {
      cwd: path.dirname(filePath),
      workspaceOnly: false,
    });

    expect(result.summary.modified).toEqual(["important.txt"]);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement\n");
    const after = await fs.stat(filePath);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o640);
  });
});
