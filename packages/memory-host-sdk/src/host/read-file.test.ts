// Memory Host SDK tests cover read file behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readAgentMemoryFile, readMemoryFile } from "./read-file.js";

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
  it("returns not found for absent extra paths and rejects non-directory parents", async () => {
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
        status: "not_found",
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
      ).rejects.toThrow("path required");
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it.each(["EACCES", "EIO"] as const)(
    "scopes extra-path %s errors to the requested file",
    async (code) => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-file-"));
      try {
        const workspaceDir = path.join(tmpRoot, "workspace");
        const extraDir = path.join(tmpRoot, "extra");
        const target = path.join(extraDir, "note.md");
        const healthyDir = path.join(tmpRoot, "healthy");
        const healthyTarget = path.join(healthyDir, "note.md");
        const blockedTarget = path.join(healthyDir, "blocked.md");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(extraDir, { recursive: true });
        await fs.mkdir(healthyDir, { recursive: true });
        await fs.writeFile(target, "secret", "utf-8");
        await fs.writeFile(healthyTarget, "healthy", "utf-8");
        await fs.writeFile(blockedTarget, "blocked", "utf-8");

        const scanError = Object.assign(new Error(`${code}: extra path unreadable`), { code });
        const realLstat = fs.lstat;
        const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          if ([extraDir, blockedTarget].includes(path.resolve(String(args[0])))) {
            throw scanError;
          }
          return await realLstat(...args);
        });
        // fs-safe checks child metadata synchronously; configured-root admission remains async.
        const realLstatSync = fsSync.lstatSync;
        const lstatSyncSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
          if (path.resolve(String(args[0])) === blockedTarget) {
            throw scanError;
          }
          return realLstatSync(...args);
        });
        try {
          await expect(
            readMemoryFile({
              workspaceDir,
              extraPaths: [extraDir, healthyDir],
              relPath: target,
            }),
          ).rejects.toMatchObject({
            code,
            message: `${code}: extra path unreadable`,
          });
          await expect(
            readMemoryFile({
              workspaceDir,
              extraPaths: [extraDir, healthyDir],
              relPath: healthyTarget,
            }),
          ).resolves.toMatchObject({ text: "healthy" });
          await expect(
            readMemoryFile({
              workspaceDir,
              extraPaths: [extraDir, healthyDir],
              relPath: blockedTarget,
            }),
          ).rejects.toMatchObject({ code, message: `${code}: extra path unreadable` });
          await expect(
            readMemoryFile({
              workspaceDir,
              extraPaths: [extraDir, target],
              relPath: target,
            }),
          ).resolves.toMatchObject({ text: "secret" });
          for (const relPath of [
            path.join(tmpRoot, "outside.md"),
            path.join(extraDir, "note.txt"),
          ]) {
            await expect(
              readMemoryFile({ workspaceDir, extraPaths: [extraDir], relPath }),
            ).rejects.toThrow("path required");
          }
          await expect(
            readMemoryFile({
              workspaceDir,
              extraPaths: [{ path: extraDir, pattern: "runbooks/**/*.md" }],
              relPath: target,
            }),
          ).rejects.toThrow("path required");
        } finally {
          lstatSyncSpy.mockRestore();
          lstatSpy.mockRestore();
        }
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    },
  );

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

  it.each(["runbooks", "..notes", "...notes"])(
    "enforces %s glob patterns through agent reads",
    async (directory) => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-file-"));
      try {
        const workspaceDir = path.join(tmpRoot, "workspace");
        const extraDir = path.join(tmpRoot, "extra");
        const allowedPath = path.join(extraDir, directory, "team", "allowed.md");
        const excludedPath = path.join(extraDir, "private.md");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(path.dirname(allowedPath), { recursive: true });
        await fs.writeFile(allowedPath, "allowed", "utf-8");
        await fs.writeFile(excludedPath, "private", "utf-8");

        const extraPaths = [{ path: extraDir, pattern: `${directory}/**/*.md` }];
        const cfg = {
          agents: { entries: { main: { workspace: workspaceDir } } },
          memory: { search: { extraPaths } },
        };
        await expect(
          readAgentMemoryFile({ cfg, agentId: "main", relPath: allowedPath }),
        ).resolves.toMatchObject({ text: "allowed" });
        await expect(
          readAgentMemoryFile({ cfg, agentId: "main", relPath: excludedPath }),
        ).rejects.toThrow("path required");
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    },
  );

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
          status: "ok",
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
