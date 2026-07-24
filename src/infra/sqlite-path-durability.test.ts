import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  ensureDurableSqliteDirectory,
  syncSqliteDirectoryForDurability,
} from "./sqlite-path-durability.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

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
        if (flags === "r") {
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
    let rootOpenCount = 0;
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (flags === "r" && path.resolve(String(filePath)) === rootPath) {
        rootOpenCount += 1;
        if (rootOpenCount > 1) {
          throw Object.assign(new Error("parent sync failed"), { code: "EIO" });
        }
      }
      return await originalOpen(filePath, flags, mode);
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

  it("detects a created directory replaced while its parent edge is synced", async () => {
    const rootPath = await fs.realpath(tempDirs.make("openclaw-sqlite-durable-race-"));
    const directoryPath = path.join(rootPath, "one", "two");
    const displacedPath = path.join(rootPath, "displaced-two");
    const originalOpen = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (
        !replaced &&
        flags === "r" &&
        path.resolve(String(filePath)) === path.join(rootPath, "one")
      ) {
        replaced = true;
        await fs.rename(directoryPath, displacedPath);
        await fs.mkdir(directoryPath);
      }
      return await originalOpen(filePath, flags, mode);
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
  });

  it.runIf(process.platform !== "win32")(
    "rejects an existing ancestor replaced before the create callback",
    async () => {
      const directoryPath = await fs.realpath(
        tempDirs.make("openclaw-sqlite-durable-existing-race-"),
      );
      const displacedPath = `${directoryPath}.displaced`;
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      let createCalled = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        if (!replaced && flags === "r" && path.resolve(String(filePath)) === directoryPath) {
          replaced = true;
          await fs.rename(directoryPath, displacedPath);
          await fs.mkdir(directoryPath);
        }
        return await originalOpen(filePath, flags, mode);
      });

      await expect(
        ensureDurableSqliteDirectory({
          directoryPath,
          label: "test directory",
          create: async () => {
            createCalled = true;
          },
        }),
      ).rejects.toThrow(/handle changed during directory sync/u);
      expect(replaced).toBe(true);
      expect(createCalled).toBe(false);
    },
  );

  it("rejects a parent swapped out only for the directory sync", async () => {
    const rootPath = await fs.realpath(tempDirs.make("openclaw-sqlite-durable-parent-race-"));
    const directoryPath = path.join(rootPath, "one", "two");
    const parentPath = path.dirname(directoryPath);
    const displacedParentPath = path.join(rootPath, "owned-parent");
    const replacementParentPath = path.join(rootPath, "replacement-parent");
    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (!swapped && flags === "r" && path.resolve(String(filePath)) === parentPath) {
        swapped = true;
        await fs.rename(parentPath, displacedParentPath);
        await fs.mkdir(parentPath);
        const handle = await originalOpen(filePath, flags, mode);
        await fs.rename(parentPath, replacementParentPath);
        await fs.rename(displacedParentPath, parentPath);
        return handle;
      }
      return await originalOpen(filePath, flags, mode);
    });

    await expect(
      ensureDurableSqliteDirectory({
        directoryPath,
        label: "test directory",
        create: async (targetPath) => {
          await fs.mkdir(targetPath, { recursive: true });
        },
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/could not sync created directory edge/u),
      cause: expect.objectContaining({
        message: expect.stringMatching(/handle changed during directory sync/u),
      }),
    });
    expect(swapped).toBe(true);
    expect((await fs.stat(directoryPath)).isDirectory()).toBe(true);
    expect((await fs.stat(replacementParentPath)).isDirectory()).toBe(true);
  });

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
