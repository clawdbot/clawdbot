import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "./install-package-dir.js";
import {
  createExistingInstallFixture,
  listMatchingDirs,
  normalizeComparablePath,
} from "./install-package-dir.test-support.js";

describe("installPackageDir rollback", () => {
  const fixtureRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-install-package-dir-rollback-",
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixtureRootTracker.cleanup();
  });

  it("preserves the Windows EPERM backup copy fallback", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("windows-backup-eperm");
    const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
    let denied = false;
    const denyInitialBackupRename = (from: fsSync.PathLike, to: fsSync.PathLike) => {
      if (
        !denied &&
        normalizeComparablePath(String(from)) === normalizeComparablePath(targetDir) &&
        path.basename(path.dirname(String(to))) === ".openclaw-install-backups"
      ) {
        denied = true;
        throw Object.assign(new Error("Windows sharing violation"), { code: "EPERM" });
      }
    };
    const realRename = fs.rename.bind(fs);
    const realRenameSync = fsSync.renameSync.bind(fsSync);
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const rename = vi.spyOn(fs, "rename").mockImplementation((from, to) => {
      denyInitialBackupRename(from, to);
      return realRename(from, to);
    });
    const renameSync = vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      denyInitialBackupRename(from, to);
      return realRenameSync(from, to);
    });
    let result;
    try {
      result = await installPackageDir({
        sourceDir,
        targetDir,
        mode: "update",
        timeoutMs: 1_000,
        copyErrorPrefix: "failed to copy plugin",
        hasDeps: false,
        sourceHardlinks: "package-manager",
        depsLogMessage: "",
      });
    } finally {
      rename.mockRestore();
      renameSync.mockRestore();
      platform.mockRestore();
    }
    expect(denied).toBe(true);
    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");
  });

  it("preserves the canonical tree when ownership closes after backup copy publication", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("backup-copy-owner");
    const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
    const expired = new Error("install owner expired after backup publication");
    let ownerActive = true;
    let revoked = false;
    let treeAtRevocation: Record<string, string> | undefined;
    const readTargetTree = async () => {
      const entries = await fs.readdir(targetDir, { recursive: true, withFileTypes: true });
      return Object.fromEntries(
        await Promise.all(
          entries
            .filter((entry) => entry.isFile())
            .map(async (entry) => {
              const file = path.join(entry.parentPath, entry.name);
              return [path.relative(targetDir, file), await fs.readFile(file, "utf8")];
            }),
        ),
      );
    };
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      await realRename(...args);
      if (
        !revoked &&
        path.basename(String(args[0])).startsWith(".fs-safe-move-") &&
        path.basename(path.dirname(String(args[1]))) === ".openclaw-install-backups"
      ) {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, "successor.txt"), "successor-owned");
        treeAtRevocation = await readTargetTree();
        ownerActive = false;
        revoked = true;
      }
    });

    const result = await installPackageDir(
      requestDeferredPackageDirInstall(
        {
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 1_000,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: false,
          depsLogMessage: "",
        },
        () => {
          if (!ownerActive) {
            throw expired;
          }
        },
      ),
    );

    expect(revoked).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(expired.message);
    }
    expect(await readTargetTree()).toEqual(treeAtRevocation);
  });

  it.each(["install", "update"] as const)(
    "preserves a successor when an earlier %s rollback finishes delayed removal",
    async (mode) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("rollback-removal-owner");
      const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
      if (mode === "install") {
        await fs.rm(targetDir, { recursive: true });
      }
      const leaseOptions = {
        path: path.join(fixtureRoot, "leases.sqlite"),
        leaseMs: 300_000,
        waitMs: 0,
      };
      const installOptions = {
        sourceDir,
        targetDir,
        mode,
        timeoutMs: 1_000,
        copyErrorPrefix: "failed to copy plugin",
        hasDeps: false,
        depsLogMessage: "",
      };
      const paused = createDeferred();
      const release = createDeferred();
      const realRm = fs.rm.bind(fs);
      let originalBackup = "";
      let rollback = Promise.resolve();

      const original = withPluginLifecycleLease(leaseOptions, async (lease) => {
        const assertOwned = lease.assertOwned.bind(lease);
        const result = await installPackageDir(
          requestDeferredPackageDirInstall(
            {
              ...installOptions,
              afterBackup: async (backupDir: string) => {
                originalBackup = backupDir;
                return { ok: true as const };
              },
            },
            assertOwned,
          ),
        );
        expect(result.ok).toBe(true);
        const transaction = resolvePackageDirInstallTransaction(result);
        if (!transaction) {
          throw new Error("Expected a retained package transaction");
        }
        const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
        let pauseConsumed = false;
        vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
          const candidate = fsSync.lstatSync(args[0], { bigint: true, throwIfNoEntry: false });
          if (
            !pauseConsumed &&
            args[1]?.recursive &&
            candidate?.dev === publishedIdentity.dev &&
            candidate.ino === publishedIdentity.ino
          ) {
            pauseConsumed = true;
            paused.resolve();
            await release.promise;
          }
          return await realRm(...args);
        });
        rollback = transaction.rollback();
        void rollback.catch(() => undefined);
        await Promise.race([
          paused.promise,
          rollback.then(() => {
            throw new Error("rollback completed before recursive removal paused");
          }),
        ]);
        // A retained operation can outlive its lease; B must never inherit A's cleanup.
        return { assertOwned };
      });
      try {
        const closed = await original;
        expect(closed.assertOwned).toThrow();
        await fs.writeFile(path.join(sourceDir, "marker.txt"), "successor");
        await withPluginLifecycleLease(leaseOptions, async (lease) => {
          const successor = await installPackageDir({
            ...installOptions,
            mode: "update",
            beforePersistentApply: lease.assertOwned.bind(lease),
          });
          expect(successor.ok).toBe(true);
          const successorIdentity = await fs.lstat(targetDir, { bigint: true });
          release.resolve();
          await rollback.catch(() => undefined);
          lease.assertOwned();
          await expect(fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).resolves.toBe(
            "successor",
          );
          await expect(fs.lstat(targetDir, { bigint: true })).resolves.toMatchObject({
            dev: successorIdentity.dev,
            ino: successorIdentity.ino,
          });
          if (mode === "update") {
            await expect(
              fs.readFile(path.join(originalBackup, "marker.txt"), "utf8"),
            ).resolves.toBe("old");
          }
        });
      } finally {
        release.resolve();
        await original.catch(() => undefined);
        await rollback.catch(() => undefined);
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

  it.each(["removal", "restoration"] as const)(
    "retains rollback progress for a retry after %s fails",
    async (failure) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("rollback-retry");
      const { installBaseDir, sourceDir, targetDir } =
        await createExistingInstallFixture(fixtureRoot);
      let backupDir = "";
      const result = await installPackageDir(
        requestDeferredPackageDirInstall({
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 1_000,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: false,
          depsLogMessage: "",
          afterBackup: async (directory: string) => {
            backupDir = directory;
            return { ok: true as const };
          },
        }),
      );
      expect(result.ok).toBe(true);
      const transaction = resolvePackageDirInstallTransaction(result);
      if (!transaction) {
        throw new Error("Expected a retained package transaction");
      }
      const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
      const ioError = Object.assign(new Error(`${failure} failed`), { code: "EIO" });
      let injected = false;
      const realRm = fs.rm.bind(fs);
      const realRename = fs.rename.bind(fs);
      if (failure === "removal") {
        vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
          if (!injected && args[1]?.recursive) {
            const current = fsSync.lstatSync(args[0], { bigint: true, throwIfNoEntry: false });
            if (current?.dev === publishedIdentity.dev && current.ino === publishedIdentity.ino) {
              injected = true;
              throw ioError;
            }
          }
          return await realRm(...args);
        });
      } else {
        vi.spyOn(fs, "rename").mockImplementation((...args: Parameters<typeof fs.rename>) => {
          if (
            !injected &&
            normalizeComparablePath(String(args[1])) === normalizeComparablePath(targetDir)
          ) {
            injected = true;
            return Promise.reject(ioError);
          }
          return realRename(...args);
        });
      }

      const rollback = transaction.rollback();
      if (failure === "restoration") {
        await expect(rollback).rejects.toMatchObject({
          cause: ioError,
          message: expect.stringContaining(backupDir),
        });
      } else {
        await expect(rollback).rejects.toBe(ioError);
      }
      expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
      await transaction.rollback();
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("old");
      expect(await fs.readdir(path.dirname(backupDir))).toEqual([]);
      expect(await listMatchingDirs(installBaseDir, ".openclaw-install-rollback-")).toEqual([]);
    },
  );

  it.each([
    { action: "commit", sourceHardlinks: "package-manager" },
    { action: "rollback", sourceHardlinks: "package-manager" },
    { action: "commit", sourceHardlinks: "reject" },
    { action: "rollback", sourceHardlinks: "reject" },
  ] as const)(
    "preserves a substituted $sourceHardlinks backup when $action is requested",
    async ({ action, sourceHardlinks }) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("substituted-backup");
      const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
      let backupDir = "";
      const result = await installPackageDir(
        requestDeferredPackageDirInstall({
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 1_000,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: false,
          sourceHardlinks,
          depsLogMessage: "",
          afterBackup: async (directory: string) => {
            backupDir = directory;
            return { ok: true as const };
          },
        }),
      );
      expect(result.ok).toBe(true);
      const transaction = resolvePackageDirInstallTransaction(result);
      if (!transaction) {
        throw new Error("Expected a retained package transaction");
      }
      const retainedBackup = path.join(fixtureRoot, "retained-backup");
      await fs.rename(backupDir, retainedBackup);
      await fs.mkdir(backupDir);
      await fs.writeFile(path.join(backupDir, "marker.txt"), "foreign backup");

      await expect(transaction[action]()).rejects.toThrow("install directory changed");
      expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("foreign backup");
      expect(await fs.readFile(path.join(retainedBackup, "marker.txt"), "utf8")).toBe("old");
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");

      await fs.rm(backupDir, { recursive: true });
      await fs.rename(retainedBackup, backupDir);
      await transaction[action]();
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe(
        action === "commit" ? "new" : "old",
      );
    },
  );

  it.each(["dev", "ino"] as const)(
    "preserves the published tree when Windows reports an unknown %s during rollback",
    async (field) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("rollback-unknown-identity");
      const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
      let backupDir = "";
      const result = await installPackageDir(
        requestDeferredPackageDirInstall({
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 1_000,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: false,
          sourceHardlinks: "package-manager",
          depsLogMessage: "",
          afterBackup: async (directory: string) => {
            backupDir = directory;
            return { ok: true as const };
          },
        }),
      );
      expect(result.ok).toBe(true);
      const transaction = resolvePackageDirInstallTransaction(result);
      if (!transaction) {
        throw new Error("Expected a retained package transaction");
      }
      const realLstat = fsSync.lstatSync.bind(fsSync);
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
        const current = realLstat(candidate, options);
        if (
          normalizeComparablePath(String(candidate)) === normalizeComparablePath(targetDir) &&
          current &&
          typeof current.dev === "bigint"
        ) {
          Object.defineProperty(current, field, { value: 0n });
        }
        return current;
      });
      try {
        await expect(transaction.rollback()).rejects.toThrow("install directory changed");
      } finally {
        lstat.mockRestore();
        platform.mockRestore();
      }
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");
      expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
      await transaction.rollback();
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("old");
    },
  );

  it("preserves a replacement inode while the original rollback owner remains live", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("rollback-inode");
    const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
    const preservedDir = path.join(fixtureRoot, "preserved-install");
    let backupDir = "";
    try {
      await withPluginLifecycleLease(
        { path: path.join(fixtureRoot, "leases.sqlite"), leaseMs: 300_000, waitMs: 0 },
        async (lease) => {
          const result = await installPackageDir(
            requestDeferredPackageDirInstall(
              {
                sourceDir,
                targetDir,
                mode: "update",
                timeoutMs: 1_000,
                copyErrorPrefix: "failed to copy plugin",
                hasDeps: false,
                depsLogMessage: "",
                afterBackup: async (directory: string) => {
                  backupDir = directory;
                  return { ok: true as const };
                },
              },
              lease.assertOwned.bind(lease),
            ),
          );
          expect(result.ok).toBe(true);
          const transaction = resolvePackageDirInstallTransaction(result);
          if (!transaction) {
            throw new Error("Expected a retained package transaction");
          }
          await fs.rename(targetDir, preservedDir);
          await fs.mkdir(targetDir);
          await fs.writeFile(path.join(targetDir, "marker.txt"), "replacement");
          const replacementIdentity = await fs.lstat(targetDir, { bigint: true });
          lease.assertOwned();

          await expect(transaction.rollback()).rejects.toThrow("install directory changed");
          expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("replacement");
          expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
            dev: replacementIdentity.dev,
            ino: replacementIdentity.ino,
          });
          expect(await fs.readFile(path.join(preservedDir, "marker.txt"), "utf8")).toBe("new");
          expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
        },
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });
});
