import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runExec } from "../process/exec.js";
import {
  ensureDurableSqliteDirectory,
  syncSqliteDirectoryForDurability,
} from "./sqlite-path-durability.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

function isDirectoryOpen(flags: string | number | undefined): boolean {
  return (
    flags === "r" || (typeof flags === "number" && (flags & fsSync.constants.O_DIRECTORY) !== 0)
  );
}

describe("SQLite path durability", () => {
  it.runIf(process.platform !== "win32")(
    "syncs every newly created parent edge through the nearest existing ancestor",
    async () => {
      const rootPath = await fs.realpath(tempDirs.make("openclaw-sqlite-durable-parent-"));
      const directoryPath = path.join(rootPath, "one", "two", "three");
      const syncedPaths: string[] = [];
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (isDirectoryOpen(flags)) {
          const resolvedPath = path.resolve(String(filePath));
          const originalSync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            syncedPaths.push(resolvedPath);
            await originalSync();
          });
        }
        return handle;
      });

      const receipt = await ensureDurableSqliteDirectory({
        directoryPath,
        label: "test directory",
        create: async (targetPath) => {
          await fs.mkdir(targetPath, { recursive: true });
        },
      });

      expect(receipt).toMatchObject({ path: directoryPath, parentSync: "synced" });
      expect(syncedPaths).toEqual([
        path.join(rootPath, "one", "two"),
        path.join(rootPath, "one"),
        rootPath,
      ]);
    },
  );

  it("fails when a newly created parent edge cannot be synced", async () => {
    const rootPath = await fs.realpath(tempDirs.make("openclaw-sqlite-durable-failure-"));
    const directoryPath = path.join(rootPath, "one", "two");
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (isDirectoryOpen(flags) && path.resolve(String(filePath)) === rootPath) {
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          throw Object.assign(new Error("parent sync failed"), { code: "EIO" });
        });
      }
      return handle;
    });

    await expect(
      ensureDurableSqliteDirectory({
        directoryPath,
        label: "test directory",
        create: async (targetPath) => {
          await fs.mkdir(targetPath, { recursive: true });
        },
      }),
    ).rejects.toThrow(/could not sync created directory edge/u);
    expect((await fs.stat(directoryPath)).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "detects a created directory replaced while its parent edge is synced",
    async () => {
      const rootPath = await fs.realpath(tempDirs.make("openclaw-sqlite-durable-race-"));
      const directoryPath = path.join(rootPath, "one", "two");
      const displacedPath = path.join(rootPath, "displaced-two");
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (
          isDirectoryOpen(flags) &&
          path.resolve(String(filePath)) === path.join(rootPath, "one")
        ) {
          const originalSync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            replaced = true;
            await fs.rename(directoryPath, displacedPath);
            await fs.mkdir(directoryPath);
            await originalSync();
          });
        }
        return handle;
      });

      await expect(
        ensureDurableSqliteDirectory({
          directoryPath,
          label: "test directory",
          create: async (targetPath) => {
            await fs.mkdir(targetPath, { recursive: true });
          },
        }),
      ).rejects.toThrow(/changed during durable directory operation/u);
      expect(replaced).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects an expected existing target replaced before it can be pinned",
    async () => {
      const directoryPath = await fs.realpath(
        tempDirs.make("openclaw-sqlite-durable-existing-race-"),
      );
      const displacedPath = `${directoryPath}.displaced`;
      const expectedIdentity = await fs.lstat(directoryPath);
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      let createCalled = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        if (
          !replaced &&
          isDirectoryOpen(flags) &&
          path.resolve(String(filePath)) === directoryPath
        ) {
          replaced = true;
          await fs.rename(directoryPath, displacedPath);
          await fs.mkdir(directoryPath);
        }
        return await originalOpen(filePath, flags, mode);
      });

      try {
        await expect(
          ensureDurableSqliteDirectory({
            directoryPath,
            label: "test directory",
            expectedExistingIdentity: expectedIdentity,
            create: async () => {
              createCalled = true;
            },
          }),
        ).rejects.toThrow(/changed during directory sync/u);
        expect(replaced).toBe(true);
        expect(createCalled).toBe(false);
      } finally {
        await fs.rm(directoryPath, { recursive: true, force: true });
        await fs.rename(displacedPath, directoryPath).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a FIFO swapped into a directory path without blocking",
    async () => {
      const directoryPath = await fs.realpath(tempDirs.make("openclaw-sqlite-durable-fifo-race-"));
      const displacedPath = `${directoryPath}.displaced`;
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      let createCalled = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        if (
          !replaced &&
          isDirectoryOpen(flags) &&
          path.resolve(String(filePath)) === directoryPath
        ) {
          expect(typeof flags).toBe("number");
          const numericFlags = flags as number;
          expect(numericFlags & fsSync.constants.O_DIRECTORY).toBe(fsSync.constants.O_DIRECTORY);
          expect(numericFlags & fsSync.constants.O_NOFOLLOW).toBe(fsSync.constants.O_NOFOLLOW);
          expect(numericFlags & fsSync.constants.O_NONBLOCK).toBe(fsSync.constants.O_NONBLOCK);
          replaced = true;
          await fs.rename(directoryPath, displacedPath);
          await runExec("mkfifo", [directoryPath], { logOutput: false });
        }
        return await originalOpen(filePath, flags, mode);
      });

      try {
        await expect(
          ensureDurableSqliteDirectory({
            directoryPath,
            label: "test directory",
            create: async () => {
              createCalled = true;
            },
          }),
        ).rejects.toBeDefined();
        expect(replaced).toBe(true);
        expect(createCalled).toBe(false);
      } finally {
        await fs.unlink(directoryPath).catch(() => undefined);
        await fs.rename(displacedPath, directoryPath).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "syncs the pinned parent when its path is transiently replaced",
    async () => {
      const rootPath = await fs.realpath(tempDirs.make("openclaw-sqlite-durable-parent-race-"));
      const directoryPath = path.join(rootPath, "one", "two");
      const parentPath = path.dirname(directoryPath);
      const displacedParentPath = path.join(rootPath, "owned-parent");
      const replacementParentPath = path.join(rootPath, "replacement-parent");
      const originalOpen = fs.open.bind(fs);
      let swapped = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (isDirectoryOpen(flags) && path.resolve(String(filePath)) === parentPath) {
          const originalSync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            swapped = true;
            await fs.rename(parentPath, displacedParentPath);
            await fs.mkdir(parentPath);
            await originalSync();
            await fs.rename(parentPath, replacementParentPath);
            await fs.rename(displacedParentPath, parentPath);
          });
        }
        return handle;
      });

      await expect(
        ensureDurableSqliteDirectory({
          directoryPath,
          label: "test directory",
          create: async (targetPath) => {
            await fs.mkdir(targetPath, { recursive: true });
          },
        }),
      ).resolves.toMatchObject({ path: directoryPath, parentSync: "synced" });
      expect(swapped).toBe(true);
      expect((await fs.stat(directoryPath)).isDirectory()).toBe(true);
      expect((await fs.stat(replacementParentPath)).isDirectory()).toBe(true);
    },
  );

  it.each(["EINVAL", "ENOSYS", "ENOTSUP"] as const)(
    "propagates %s directory sync failures outside Windows",
    async (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const directoryPath = tempDirs.make("openclaw-sqlite-posix-sync-");
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error(code), { code }));
        return handle;
      });

      await expect(syncSqliteDirectoryForDurability(directoryPath)).rejects.toMatchObject({
        code,
      });
    },
  );

  it.each(["EACCES", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"] as const)(
    "reports %s directory sync failures as unsupported on Windows",
    async (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const directoryPath = tempDirs.make("openclaw-sqlite-windows-sync-");
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error(code), { code }));
        return handle;
      });

      await expect(syncSqliteDirectoryForDurability(directoryPath)).resolves.toBe("unsupported");
    },
  );
});
