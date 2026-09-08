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
  normalizeComparablePath,
} from "./install-package-dir.test-support.js";

describe("installPackageDir publication failure", () => {
  const fixtureRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-install-package-dir-publication-",
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixtureRootTracker.cleanup();
  });

  it.each([
    { mode: "install", failure: "source cleanup" },
    { mode: "update", failure: "source cleanup" },
    { mode: "install", failure: "caller revocation" },
    { mode: "update", failure: "caller revocation" },
  ] as const)(
    "reverses an $mode publication when $failure fails with the lifecycle owner still active",
    async ({ mode, failure }) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("owned-publication-failure");
      const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
      if (mode === "install") {
        await fs.rm(targetDir, { recursive: true });
      }
      let stageDir = "";
      let published = false;
      let injected = false;
      let callerActive = true;
      const sourceCleanupError = Object.assign(new Error("published source cleanup failed"), {
        code: "EIO",
      });
      const callerError = new Error("initiating caller closed after publication");
      const realRename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
        await realRename(...args);
        if (
          !published &&
          normalizeComparablePath(String(args[1])) === normalizeComparablePath(targetDir)
        ) {
          published = true;
          if (failure === "caller revocation") {
            callerActive = false;
            injected = true;
          }
        }
      });
      const realUnlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
        if (
          failure === "source cleanup" &&
          published &&
          !injected &&
          normalizeComparablePath(String(args[0])) ===
            normalizeComparablePath(path.join(stageDir, "marker.txt"))
        ) {
          injected = true;
          throw sourceCleanupError;
        }
        await realUnlink(...args);
      });

      const result = await installPackageDir(
        requestDeferredPackageDirInstall(
          {
            sourceDir,
            targetDir,
            mode,
            timeoutMs: 1_000,
            copyErrorPrefix: "failed to copy plugin",
            hasDeps: false,
            sourceHardlinks: "reject",
            depsLogMessage: "",
            afterCopy: (directory: string) => {
              stageDir = directory;
            },
            beforePersistentApply: () => {
              if (!callerActive) {
                throw callerError;
              }
            },
          },
          // Caller cancellation must not revoke the transaction owner's rollback authority.
          () => {},
        ),
      );

      expect(published).toBe(true);
      expect(injected).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          failure === "source cleanup" ? sourceCleanupError.message : callerError.message,
        ),
      });
      if (mode === "update") {
        expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("old");
      } else {
        await expect(fs.lstat(targetDir)).rejects.toHaveProperty("code", "ENOENT");
      }
      expect(await fs.readFile(path.join(sourceDir, "marker.txt"), "utf8")).toBe("new");
    },
  );

  it.each(["unchanged", "replaced"] as const)(
    "retries backup cleanup after restoration publication with the %s canonical target",
    async (targetState) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("restoration-cleanup-retry");
      const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
      await fs.writeFile(path.join(targetDir, "settings.json"), '{"original":true}\n');
      let backupDir = "";
      const installed = await installPackageDir(
        requestDeferredPackageDirInstall({
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 1_000,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: false,
          sourceHardlinks: "reject",
          depsLogMessage: "",
          afterBackup: async (directory: string) => {
            backupDir = directory;
            return { ok: true as const };
          },
        }),
      );
      expect(installed.ok).toBe(true);
      const transaction = resolvePackageDirInstallTransaction(installed);
      if (!transaction) {
        throw new Error("expected a retained update transaction");
      }
      let restored = false;
      let injected = false;
      const cleanupError = Object.assign(new Error("restored backup cleanup failed"), {
        code: "EIO",
      });
      const realRename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
        await realRename(...args);
        if (normalizeComparablePath(String(args[1])) === normalizeComparablePath(targetDir)) {
          restored = true;
        }
      });
      const realUnlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
        if (
          restored &&
          !injected &&
          normalizeComparablePath(String(args[0])) ===
            normalizeComparablePath(path.join(backupDir, "marker.txt"))
        ) {
          injected = true;
          throw cleanupError;
        }
        await realUnlink(...args);
      });

      const rollbackError = await transaction.rollback().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(restored).toBe(true);
      expect(injected).toBe(true);
      expect(String(rollbackError)).toContain(cleanupError.message);
      expect(String(rollbackError)).toContain("published");
      expect(String(rollbackError)).toContain(targetDir);
      expect(String(rollbackError)).toContain(backupDir);
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("old");
      expect(await fs.readFile(path.join(targetDir, "settings.json"), "utf8")).toBe(
        '{"original":true}\n',
      );

      if (targetState === "replaced") {
        await fs.rename(targetDir, path.join(fixtureRoot, "retained-original"));
        await fs.mkdir(targetDir);
        await fs.writeFile(path.join(targetDir, "marker.txt"), "successor");
      }
      const targetIdentity = await fs.lstat(targetDir, { bigint: true });
      if (targetState === "unchanged") {
        await transaction.rollback();
        await expect(fs.lstat(backupDir)).rejects.toHaveProperty("code", "ENOENT");
        expect(await fs.readFile(path.join(targetDir, "settings.json"), "utf8")).toBe(
          '{"original":true}\n',
        );
      } else {
        await expect(transaction.rollback()).rejects.toThrow();
        expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
      }
      expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe(
        targetState === "unchanged" ? "old" : "successor",
      );
      expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
        dev: targetIdentity.dev,
        ino: targetIdentity.ino,
      });
    },
  );

  it.each(["install", "update"] as const)(
    "retains and reports an %s publication after the original lifecycle lease closes",
    async (mode) => {
      await fixtureRootTracker.setup();
      const fixtureRoot = await fixtureRootTracker.make("revoked-publication-owner");
      const { sourceDir, targetDir } = await createExistingInstallFixture(fixtureRoot);
      if (mode === "install") {
        await fs.rm(targetDir, { recursive: true });
      }
      const reachedPublication = createDeferred();
      const resumeCleanup = createDeferred();
      let published = false;
      let backupDir = "";
      let pendingInstall: ReturnType<typeof installPackageDir> | undefined;
      const realRename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
        await realRename(...args);
        if (
          !published &&
          normalizeComparablePath(String(args[1])) === normalizeComparablePath(targetDir)
        ) {
          published = true;
          reachedPublication.resolve();
          await resumeCleanup.promise;
        }
      });

      const lifecycle = withPluginLifecycleLease(
        { path: path.join(fixtureRoot, "leases.sqlite"), leaseMs: 300_000, waitMs: 0 },
        async (lease) => {
          const assertOwned = lease.assertOwned.bind(lease);
          pendingInstall = installPackageDir(
            requestDeferredPackageDirInstall(
              {
                sourceDir,
                targetDir,
                mode,
                timeoutMs: 1_000,
                copyErrorPrefix: "failed to copy plugin",
                hasDeps: false,
                sourceHardlinks: "reject",
                depsLogMessage: "",
                afterBackup: async (directory: string) => {
                  backupDir = directory;
                  return { ok: true as const };
                },
              },
              assertOwned,
            ),
          );
          await Promise.race([
            reachedPublication.promise,
            pendingInstall.then(() => {
              throw new Error("install finished before publication paused");
            }),
          ]);
          return assertOwned;
        },
      );

      try {
        const assertClosedOwner = await lifecycle;
        expect(assertClosedOwner).toThrow();
        const publishedIdentity = await fs.lstat(targetDir, { bigint: true });
        resumeCleanup.resolve();
        if (!pendingInstall) {
          throw new Error("expected an in-flight install");
        }
        const result = await pendingInstall;
        expect(published).toBe(true);
        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected closed lifecycle ownership to reject source cleanup");
        }
        expect.soft(result.error).toContain("published");
        expect.soft(result.error).toContain(targetDir);
        expect(await fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).toBe("new");
        expect(await fs.lstat(targetDir, { bigint: true })).toMatchObject({
          dev: publishedIdentity.dev,
          ino: publishedIdentity.ino,
        });
        if (mode === "update") {
          expect(backupDir).not.toBe("");
          expect.soft(result.error).toContain(backupDir);
          expect(await fs.readFile(path.join(backupDir, "marker.txt"), "utf8")).toBe("old");
        }
      } finally {
        resumeCleanup.resolve();
        await lifecycle.catch(() => undefined);
        await pendingInstall?.catch(() => undefined);
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});
