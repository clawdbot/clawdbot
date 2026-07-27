// Tests atomic file replacement helpers and permission handling.
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ReplaceFileAtomicFileSystem,
  ReplaceFileAtomicSyncFileSystem,
} from "@openclaw/fs-safe/atomic";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  movePathWithCopyFallback,
  replaceFileAtomic,
  replaceFileAtomicSync,
} from "./replace-file.js";

describe("movePathWithCopyFallback", () => {
  it.runIf(process.platform !== "win32")(
    "rejects hardlinked source files when requested",
    async () => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const sourceDir = path.join(root, "source");
        const targetDir = path.join(root, "target");
        const sourceFile = path.join(sourceDir, "file.txt");
        const linkedFile = path.join(root, "linked.txt");
        await fs.mkdir(sourceDir);
        await fs.writeFile(sourceFile, "hello", "utf8");
        await fs.link(sourceFile, linkedFile);

        await expect(
          movePathWithCopyFallback({
            from: sourceDir,
            sourceHardlinks: "reject",
            to: targetDir,
          }),
        ).rejects.toThrow("Hardlinked source file is not allowed");

        await expect(fs.readFile(sourceFile, "utf8")).resolves.toBe("hello");
        let statError: NodeJS.ErrnoException | undefined;
        try {
          await fs.stat(targetDir);
        } catch (error) {
          statError = error as NodeJS.ErrnoException;
        }
        expect(statError).toBeInstanceOf(Error);
        expect(statError?.code).toBe("ENOENT");
        expect(statError?.path).toBe(targetDir);
        expect(statError?.syscall).toBe("stat");
      });
    },
  );
});

describe("replaceFileAtomic", () => {
  it.runIf(process.platform !== "win32")(
    "does not chmod a swapped symlink target after async rename",
    async () => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const target = path.join(root, "secret.json");
        const victim = path.join(root, "victim-secret.json");
        const chmodPaths: string[] = [];
        await fs.writeFile(victim, "secret", "utf8");
        await fs.chmod(victim, 0o644);

        const fileSystem: ReplaceFileAtomicFileSystem = {
          promises: {
            chmod: async (targetPath, mode) => {
              chmodPaths.push(String(targetPath));
              await fs.chmod(targetPath, mode);
            },
            copyFile: fs.copyFile,
            lstat: fs.lstat,
            mkdir: fs.mkdir,
            open: fs.open,
            rename: async (source, destination) => {
              await fs.rename(source, destination);
              await fs.rm(destination, { force: true });
              await fs.symlink(victim, destination);
            },
            rm: fs.rm,
            stat: fs.stat,
            unlink: fs.unlink,
            writeFile: fs.writeFile,
          },
        };

        await replaceFileAtomic({
          filePath: target,
          content: "{}",
          dirMode: 0o755,
          fileSystem,
          mode: 0o600,
          tempPrefix: "secret.json",
        });

        expect(chmodPaths).toEqual([root]);
        expect((await fs.stat(victim)).mode & 0o777).toBe(0o644);
        expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not chmod a swapped symlink target after sync rename",
    async () => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const target = path.join(root, "secret.json");
        const victim = path.join(root, "victim-secret.json");
        const chmodPaths: string[] = [];
        await fs.writeFile(victim, "secret", "utf8");
        await fs.chmod(victim, 0o644);

        const fileSystem: ReplaceFileAtomicSyncFileSystem = {
          chmodSync: (targetPath, mode) => {
            chmodPaths.push(String(targetPath));
            syncFs.chmodSync(targetPath, mode);
          },
          closeSync: syncFs.closeSync,
          copyFileSync: syncFs.copyFileSync,
          fsyncSync: syncFs.fsyncSync,
          lstatSync: syncFs.lstatSync,
          mkdirSync: syncFs.mkdirSync,
          openSync: syncFs.openSync,
          readFileSync: syncFs.readFileSync,
          renameSync: (source, destination) => {
            syncFs.renameSync(source, destination);
            syncFs.rmSync(destination, { force: true });
            syncFs.symlinkSync(victim, destination);
          },
          rmSync: syncFs.rmSync,
          statSync: syncFs.statSync,
          unlinkSync: syncFs.unlinkSync,
          writeFileSync: syncFs.writeFileSync,
        };

        replaceFileAtomicSync({
          filePath: target,
          content: "{}",
          dirMode: 0o755,
          fileSystem,
          mode: 0o600,
          tempPrefix: "secret.json",
        });

        expect(chmodPaths).toEqual([root]);
        expect((await fs.stat(victim)).mode & 0o777).toBe(0o644);
        expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves async requested mode without final-path chmod",
    async () => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const target = path.join(root, "public.json");
        const chmodPaths: string[] = [];
        const fileSystem: ReplaceFileAtomicFileSystem = {
          promises: {
            chmod: async (targetPath, mode) => {
              chmodPaths.push(String(targetPath));
              await fs.chmod(targetPath, mode);
            },
            copyFile: fs.copyFile,
            lstat: fs.lstat,
            mkdir: fs.mkdir,
            open: fs.open,
            rename: fs.rename,
            rm: fs.rm,
            stat: fs.stat,
            unlink: fs.unlink,
            writeFile: fs.writeFile,
          },
        };

        const previousUmask = process.umask(0o077);
        try {
          await replaceFileAtomic({
            filePath: target,
            content: "{}",
            dirMode: 0o755,
            fileSystem,
            mode: 0o644,
            tempPrefix: "public.json",
          });
        } finally {
          process.umask(previousUmask);
        }

        expect(chmodPaths).toEqual([root]);
        expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves async copy-fallback requested mode without final-path chmod",
    async () => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const target = path.join(root, "public.json");
        const chmodPaths: string[] = [];
        const fileSystem: ReplaceFileAtomicFileSystem = {
          promises: {
            chmod: async (targetPath, mode) => {
              chmodPaths.push(String(targetPath));
              await fs.chmod(targetPath, mode);
            },
            copyFile: fs.copyFile,
            lstat: fs.lstat,
            mkdir: fs.mkdir,
            open: fs.open,
            rename: async () => {
              throw Object.assign(new Error("rename blocked"), { code: "EPERM" });
            },
            rm: fs.rm,
            stat: fs.stat,
            unlink: fs.unlink,
            writeFile: fs.writeFile,
          },
        };

        const previousUmask = process.umask(0o077);
        try {
          await expect(
            replaceFileAtomic({
              filePath: target,
              content: "{}",
              copyFallbackOnPermissionError: true,
              dirMode: 0o755,
              fileSystem,
              mode: 0o644,
              tempPrefix: "public.json",
            }),
          ).resolves.toEqual({ method: "copy-fallback" });
        } finally {
          process.umask(previousUmask);
        }

        expect(chmodPaths).toEqual([root]);
        expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves async same-path mode after an earlier queued replacement",
    async () => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const target = path.join(root, "shared.json");
        let releaseFirst: (() => void) | undefined;
        let enteredFirst: (() => void) | undefined;
        const firstEntered = new Promise<void>((resolve) => {
          enteredFirst = resolve;
        });
        const firstRelease = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        await fs.writeFile(target, "old", { mode: 0o600 });

        const first = replaceFileAtomic({
          filePath: target,
          beforeRename: async () => {
            enteredFirst?.();
            await firstRelease;
          },
          content: "first",
          mode: 0o644,
          tempPrefix: "shared.json",
        });
        await firstEntered;

        const second = replaceFileAtomic({
          filePath: target,
          content: "second",
          preserveExistingMode: true,
          tempPrefix: "shared.json",
        });

        releaseFirst?.();
        await Promise.all([first, second]);

        expect(await fs.readFile(target, "utf8")).toBe("second");
        expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves sync requested mode without final-path chmod",
    async () => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const target = path.join(root, "public.json");
        const chmodPaths: string[] = [];
        const fileSystem: ReplaceFileAtomicSyncFileSystem = {
          chmodSync: (targetPath, mode) => {
            chmodPaths.push(String(targetPath));
            syncFs.chmodSync(targetPath, mode);
          },
          closeSync: syncFs.closeSync,
          copyFileSync: syncFs.copyFileSync,
          fsyncSync: syncFs.fsyncSync,
          lstatSync: syncFs.lstatSync,
          mkdirSync: syncFs.mkdirSync,
          openSync: syncFs.openSync,
          readFileSync: syncFs.readFileSync,
          renameSync: syncFs.renameSync,
          rmSync: syncFs.rmSync,
          statSync: syncFs.statSync,
          unlinkSync: syncFs.unlinkSync,
          writeFileSync: syncFs.writeFileSync,
        };

        const previousUmask = process.umask(0o077);
        try {
          replaceFileAtomicSync({
            filePath: target,
            content: "{}",
            dirMode: 0o755,
            fileSystem,
            mode: 0o644,
            tempPrefix: "public.json",
          });
        } finally {
          process.umask(previousUmask);
        }

        expect(chmodPaths).toEqual([root]);
        expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves sync copy-fallback requested mode without final-path chmod",
    async () => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const target = path.join(root, "public.json");
        const chmodPaths: string[] = [];
        const fileSystem: ReplaceFileAtomicSyncFileSystem = {
          chmodSync: (targetPath, mode) => {
            chmodPaths.push(String(targetPath));
            syncFs.chmodSync(targetPath, mode);
          },
          closeSync: syncFs.closeSync,
          copyFileSync: syncFs.copyFileSync,
          fsyncSync: syncFs.fsyncSync,
          lstatSync: syncFs.lstatSync,
          mkdirSync: syncFs.mkdirSync,
          openSync: syncFs.openSync,
          readFileSync: syncFs.readFileSync,
          renameSync: () => {
            throw Object.assign(new Error("rename blocked"), { code: "EPERM" });
          },
          rmSync: syncFs.rmSync,
          statSync: syncFs.statSync,
          unlinkSync: syncFs.unlinkSync,
          writeFileSync: syncFs.writeFileSync,
        };

        const previousUmask = process.umask(0o077);
        try {
          expect(
            replaceFileAtomicSync({
              filePath: target,
              content: "{}",
              copyFallbackOnPermissionError: true,
              dirMode: 0o755,
              fileSystem,
              mode: 0o644,
              tempPrefix: "public.json",
            }),
          ).toEqual({ method: "copy-fallback" });
        } finally {
          process.umask(previousUmask);
        }

        expect(chmodPaths).toEqual([root]);
        expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
      });
    },
  );
});
