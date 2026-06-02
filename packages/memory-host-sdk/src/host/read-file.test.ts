import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readMemoryFile } from "./read-file.js";

async function createDirectorySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, "dir");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return false;
    }
    throw err;
  }
}

describe("readMemoryFile", () => {
  it("returns empty text for missing files under extra path directories", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-file-"));
    try {
      const workspaceDir = path.join(tmpRoot, "workspace");
      const extraDir = path.join(tmpRoot, "extra");
      const missingPath = path.join(extraDir, "missing.md");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(extraDir, { recursive: true });

      const result = await readMemoryFile({
        workspaceDir,
        extraPaths: [extraDir],
        relPath: missingPath,
      });

      expect(result).toEqual({
        text: "",
        path: path.relative(workspaceDir, missingPath).replace(/\\/g, "/"),
      });

      const nonDirectoryParentPath = path.join(extraDir, "note.md", "child.md");
      await fs.writeFile(path.join(extraDir, "note.md"), "note", "utf-8");
      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [extraDir],
          relPath: nonDirectoryParentPath,
        }),
      ).resolves.toEqual({
        text: "",
        path: path.relative(workspaceDir, nonDirectoryParentPath).replace(/\\/g, "/"),
      });
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("rejects extra path reads through symlinked directory components", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-file-"));
    try {
      const workspaceDir = path.join(tmpRoot, "workspace");
      const extraDir = path.join(tmpRoot, "extra");
      const outsideDir = path.join(tmpRoot, "outside");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(extraDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(extraDir, "inside.md"), "inside", "utf-8");
      await fs.writeFile(path.join(outsideDir, "private.md"), "private", "utf-8");

      const inside = await readMemoryFile({
        workspaceDir,
        extraPaths: [extraDir],
        relPath: path.join(extraDir, "inside.md"),
      });
      expect(inside.text).toBe("inside");

      const insideLinkPath = path.join(extraDir, "inside-link");
      if (!(await createDirectorySymlink(extraDir, insideLinkPath))) {
        return;
      }
      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [extraDir],
          relPath: path.join(insideLinkPath, "inside.md"),
        }),
      ).rejects.toThrow("path required");

      const outsideLinkPath = path.join(extraDir, "link");
      if (!(await createDirectorySymlink(outsideDir, outsideLinkPath))) {
        return;
      }

      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [extraDir],
          relPath: path.join(outsideLinkPath, "private.md"),
        }),
      ).rejects.toThrow("path required");
      await expect(
        readMemoryFile({
          workspaceDir,
          extraPaths: [extraDir],
          relPath: path.join(outsideLinkPath, "missing.md"),
        }),
      ).rejects.toThrow("path required");
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("retries transient read errors for workspace memory files", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-file-"));
    try {
      const workspaceDir = path.join(tmpRoot, "workspace");
      const relPath = "memory/retry.md";
      const absPath = path.join(workspaceDir, relPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, "alpha\nbeta", "utf-8");

      const realOpen = fs.open;
      let attempts = 0;
      const openSpy = vi
        .spyOn(fs, "open")
        .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
          const [target, flags, mode] = args;
          if (typeof target === "string" && path.resolve(target) === absPath && attempts++ === 0) {
            const err = new Error(
              "Unknown system error -11: Unknown system error -11, open",
            ) as NodeJS.ErrnoException;
            err.code = "UNKNOWN";
            err.errno = -11;
            throw err;
          }
          return await realOpen(target, flags, mode);
        });

      try {
        await expect(
          readMemoryFile({
            workspaceDir,
            extraPaths: [],
            relPath,
          }),
        ).resolves.toEqual({
          text: "alpha\nbeta",
          path: relPath,
          from: 1,
          lines: 2,
        });
        expect(attempts).toBe(2);
      } finally {
        openSpy.mockRestore();
      }
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
