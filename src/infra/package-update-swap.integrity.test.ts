import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function retain(params: Parameters<typeof swapStagedPackageInstall>[0]) {
  let transaction: PackageUpdateTransaction | undefined;
  const result = await swapStagedPackageInstall({
    ...params,
    onTransaction: (value) => {
      transaction = value;
    },
  });
  expect(result.status, result.step.stderrTail ?? "").toBe("committed");
  if (!transaction) {
    throw new Error("missing retained transaction");
  }
  return transaction;
}

async function expectCandidateIntact(packageRoot: string, launcher: string) {
  await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
    '"version":"2.0.0"',
  );
  await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
}

async function createLinkedPackageSwapFixture(base: string, relative = false) {
  const fixture = await createPackageSwapFixture(base);
  const checkout = path.join(base, "checkout");
  await fs.rename(fixture.packageRoot, checkout);
  await fs.writeFile(path.join(checkout, "operator.txt"), "operator-owned checkout\n");
  // A linked checkout can reference dependencies outside the package root.
  await fs.symlink(
    base,
    path.join(checkout, "external"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await fs.symlink(
    relative ? path.relative(path.dirname(fixture.packageRoot), checkout) : checkout,
    fixture.packageRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  return {
    ...fixture,
    checkout,
    target: await fs.readlink(fixture.packageRoot),
    linkIdentity: (await fs.lstat(fixture.packageRoot)).ino,
    checkoutIdentity: (await fs.stat(checkout)).ino,
  };
}

describe("retained npm package integrity", () => {
  it.each(["changed launcher", "unchanged launcher", "verified activation"] as const)(
    "handles an absent old package with %s",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-rollback-absent-package-" }, async (base) => {
        const { params, packageRoot, launcher, globalRoot } = await createPackageSwapFixture(base);
        await fs.rm(packageRoot, { recursive: true });
        const transaction = await retain(params);
        if (outcome === "verified activation") {
          expect(await transaction.complete({ activationVerified: true })).toBeUndefined();
          await expectCandidateIntact(packageRoot, launcher);
          expect((await fs.readdir(globalRoot)).filter((name) => name.startsWith("."))).toEqual([]);
          return;
        }
        if (outcome === "changed launcher") {
          const backup = (await fs.readdir(globalRoot)).find((name) =>
            name.startsWith(".openclaw.shim-backup-"),
          )!;
          await fs.writeFile(path.join(globalRoot, backup, "openclaw"), "altered launcher\n");
          expect(await transaction.rollback()).toMatchObject({
            exitCode: 1,
            activePackageRoot: packageRoot,
          });
          await expectCandidateIntact(packageRoot, launcher);
          await expect(fs.stat(path.join(globalRoot, backup))).resolves.toBeDefined();
        } else {
          // Restoring package absence is not a verified previous runtime.
          expect(await transaction.rollback()).toMatchObject({
            exitCode: 1,
            activePackageRoot: null,
          });
          await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        }
      });
    },
  );

  it.each([false, true])(
    "activates a package over an owned npm dev link (relative=%s)",
    async (relative) => {
      await withTestDir({ prefix: "openclaw-linked-package-activate-" }, async (base) => {
        const fixture = await createLinkedPackageSwapFixture(base, relative);
        const transaction = await retain(fixture.params);
        await expectCandidateIntact(fixture.packageRoot, fixture.launcher);
        expect((await fs.lstat(transaction.backupRoot)).ino).toBe(fixture.linkIdentity);
        expect(await fs.readlink(transaction.backupRoot)).toBe(fixture.target);
        await fs.writeFile(
          path.join(fixture.checkout, "operator.txt"),
          "independent operator edit\n",
        );
        expect(await transaction.complete({ activationVerified: true })).toBeUndefined();
        await expect(fs.lstat(transaction.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.stat(fixture.checkout)).ino).toBe(fixture.checkoutIdentity);
        expect(await fs.readFile(path.join(fixture.checkout, "operator.txt"), "utf8")).toBe(
          "independent operator edit\n",
        );
        expect(await fs.readFile(path.join(fixture.checkout, "package.json"), "utf8")).toContain(
          '"version":"1.0.0"',
        );
      });
    },
  );

  it.each([false, true])(
    "restores only the owned npm link without granting runtime recovery (relative=%s)",
    async (relative) => {
      await withTestDir({ prefix: "openclaw-linked-package-rollback-" }, async (base) => {
        const fixture = await createLinkedPackageSwapFixture(base, relative);
        const transaction = await retain(fixture.params);
        await fs.writeFile(
          path.join(fixture.checkout, "operator.txt"),
          "independent operator edit\n",
        );
        const rollback = await transaction.rollback();
        expect(rollback).toMatchObject({ exitCode: 1, activePackageRoot: fixture.packageRoot });
        expect(rollback.stderrTail).toContain("external checkout runtime integrity is unverified");
        expect(rollback.stdoutTail).toBeNull();
        expect((await fs.lstat(fixture.packageRoot)).ino).toBe(fixture.linkIdentity);
        expect(await fs.readlink(fixture.packageRoot)).toBe(fixture.target);
        expect(await fs.readFile(fixture.launcher, "utf8")).toBe("old launcher\n");
        expect(await fs.readFile(path.join(fixture.checkout, "operator.txt"), "utf8")).toBe(
          "independent operator edit\n",
        );
        expect((await fs.stat(fixture.checkout)).ino).toBe(fixture.checkoutIdentity);
        expect(await transaction.complete({ activationVerified: false })).toMatchObject({
          exitCode: 1,
        });
        await expect(fs.stat(`${transaction.backupRoot}.candidate`)).resolves.toBeDefined();
        expect(await transaction.rollback()).toEqual(rollback);
      });
    },
  );

  it.each(["before observation", "after observation"] as const)(
    "retains a directory substituted for the backup link %s",
    async (when) => {
      await withTestDir({ prefix: "openclaw-linked-package-retirement-" }, async (base) => {
        const fixture = await createLinkedPackageSwapFixture(base);
        const transaction = await retain(fixture.params);
        let replaced = false;
        const replaceLink = async () => {
          replaced = true;
          await fs.rename(transaction.backupRoot, `${transaction.backupRoot}.original`);
          await fs.rename(fixture.checkout, transaction.backupRoot);
        };
        if (when === "before observation") {
          await replaceLink();
        } else {
          const readlink = fs.readlink.bind(fs);
          const lstat = fs.lstat.bind(fs);
          let targetRead = false;
          vi.spyOn(fs, "readlink").mockImplementation(async (...args) => {
            const target = await readlink(...args);
            if (String(args[0]) === transaction.backupRoot) {
              targetRead = true;
            }
            return target;
          });
          vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
            const stat = await lstat(...args);
            if (String(args[0]) === transaction.backupRoot && targetRead && !replaced) {
              // The check observes the old link; only non-recursive removal is safe afterward.
              await replaceLink();
            }
            return stat;
          });
        }
        expect(await transaction.complete({ activationVerified: true })).toMatchObject({
          name: "global install backup retention",
          exitCode: 1,
        });
        expect(replaced).toBe(true);
        const retained = await fs.lstat(transaction.backupRoot);
        expect(retained.isDirectory()).toBe(true);
        expect(retained.ino).toBe(fixture.checkoutIdentity);
        expect(await fs.readFile(path.join(transaction.backupRoot, "operator.txt"), "utf8")).toBe(
          "operator-owned checkout\n",
        );
        await expectCandidateIntact(fixture.packageRoot, fixture.launcher);
      });
    },
  );

  it("retains an unexpected backup directory after nonretained activation", async () => {
    await withTestDir({ prefix: "openclaw-linked-package-direct-cleanup-" }, async (base) => {
      const fixture = await createLinkedPackageSwapFixture(base);
      let backupRoot = "";
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (String(args[0]) === fixture.packageRoot) {
          backupRoot = String(args[1]);
        }
        return rename(...args);
      });
      const result = await swapStagedPackageInstall({
        ...fixture.params,
        postVerifyStep: async () => {
          await rename(backupRoot, `${backupRoot}.original`);
          await rename(fixture.checkout, backupRoot);
          return { name: "verified", command: "verify", cwd: base, durationMs: 0, exitCode: 0 };
        },
      });
      expect(result.status).toBe("committed");
      expect(result.step.stdoutTail).toContain("Could not retire retained npm package link");
      expect((await fs.stat(backupRoot)).ino).toBe(fixture.checkoutIdentity);
      expect(await fs.readFile(path.join(backupRoot, "operator.txt"), "utf8")).toBe(
        "operator-owned checkout\n",
      );
      await expectCandidateIntact(fixture.packageRoot, fixture.launcher);
    });
  });

  it("reports failed activation after link restoration as unverified package recovery", async () => {
    await withTestDir({ prefix: "openclaw-linked-package-rejected-" }, async (base) => {
      const fixture = await createLinkedPackageSwapFixture(base);
      const result = await swapStagedPackageInstall({
        ...fixture.params,
        postVerifyStep: async () => ({
          name: "candidate verification",
          command: "verify candidate",
          cwd: fixture.packageRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: "candidate rejected",
        }),
      });
      expect(result).toMatchObject({
        status: "failed",
        activePackageRoot: fixture.packageRoot,
        packageRollbackVerified: false,
        step: { exitCode: 1 },
      });
      expect(result.step.stderrTail).toContain(
        "Restored the npm package link and affected launchers",
      );
      expect(result.step.stderrTail).toContain("external checkout runtime integrity is unverified");
      expect(await fs.readlink(fixture.packageRoot)).toBe(fixture.target);
      expect((await fs.lstat(fixture.packageRoot)).ino).toBe(fixture.linkIdentity);
      expect(await fs.readFile(fixture.launcher, "utf8")).toBe("old launcher\n");
      expect(await fs.readFile(path.join(fixture.checkout, "operator.txt"), "utf8")).toBe(
        "operator-owned checkout\n",
      );
    });
  });

  it.each(["identity", "target"] as const)(
    "refuses a changed retained npm link %s before displacing the candidate",
    async (change) => {
      await withTestDir({ prefix: "openclaw-linked-package-tamper-" }, async (base) => {
        const fixture = await createLinkedPackageSwapFixture(base);
        const transaction = await retain(fixture.params);
        await fs.rename(transaction.backupRoot, `${transaction.backupRoot}.original`);
        await fs.symlink(
          change === "identity" ? fixture.target : base,
          transaction.backupRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
        const rollback = await transaction.rollback();
        expect(rollback).toMatchObject({ exitCode: 1, activePackageRoot: fixture.packageRoot });
        expect(rollback.stderrTail).toContain("retained package");
        await expectCandidateIntact(fixture.packageRoot, fixture.launcher);
        expect(await fs.readFile(path.join(fixture.checkout, "operator.txt"), "utf8")).toBe(
          "operator-owned checkout\n",
        );
        expect(await transaction.complete({ activationVerified: false })).toMatchObject({
          exitCode: 1,
        });
      });
    },
  );

  it.each([false, true])(
    "retains a substituted backup directory (new live entry=%s)",
    async (blocked) => {
      await withTestDir({ prefix: "openclaw-linked-package-acquire-" }, async (base) => {
        const fixture = await createLinkedPackageSwapFixture(base);
        const rename = fs.rename.bind(fs);
        let movedRoot = "";
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (String(args[0]) === fixture.packageRoot && !movedRoot) {
            movedRoot = String(args[1]);
            await rename(fixture.packageRoot, `${fixture.packageRoot}.original`);
            await rename(fixture.checkout, fixture.packageRoot);
            await rename(...args);
            if (blocked) {
              await fs.mkdir(fixture.packageRoot);
              await fs.writeFile(path.join(fixture.packageRoot, "new-owner.txt"), "preserve me");
            }
            return;
          }
          return rename(...args);
        });
        const result = await swapStagedPackageInstall(fixture.params);
        expect(result).toMatchObject({
          status: "failed",
          packageRollbackVerified: false,
          activePackageRoot: null,
        });
        expect(movedRoot).not.toBe("");
        expect(result.step.stderrTail).toContain("link backup refused");
        const preservedRoot = movedRoot;
        expect((await fs.lstat(preservedRoot)).isDirectory()).toBe(true);
        expect((await fs.stat(preservedRoot)).ino).toBe(fixture.checkoutIdentity);
        expect(await fs.readFile(path.join(preservedRoot, "operator.txt"), "utf8")).toBe(
          "operator-owned checkout\n",
        );
        if (blocked) {
          expect(result.step.stderrTail).toContain("moved entry retained");
          expect(await fs.readFile(path.join(fixture.packageRoot, "new-owner.txt"), "utf8")).toBe(
            "preserve me",
          );
        } else {
          await expect(fs.lstat(fixture.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await fs.readFile(fixture.launcher, "utf8")).toBe("old launcher\n");
      });
    },
  );

  it("refuses an npm root link replaced during service preparation", async () => {
    await withTestDir({ prefix: "openclaw-linked-package-preparation-" }, async (base) => {
      const fixture = await createLinkedPackageSwapFixture(base);
      const onLiveMutation = vi.fn();
      const result = await swapStagedPackageInstall({
        ...fixture.params,
        onLiveMutation,
        beforeActivate: async () => {
          await fs.rename(fixture.packageRoot, `${fixture.packageRoot}.original`);
          await fs.symlink(
            base,
            fixture.packageRoot,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      });
      expect(result).toMatchObject({ status: "failed", packageRollbackVerified: false });
      expect(onLiveMutation).not.toHaveBeenCalled();
      expect(await fs.readlink(fixture.packageRoot)).toBe(base);
      expect(await fs.readFile(path.join(fixture.checkout, "operator.txt"), "utf8")).toBe(
        "operator-owned checkout\n",
      );
    });
  });

  it("accepts a hardlinked launcher using copy-preserved metadata", async () => {
    await withTestDir({ prefix: "openclaw-rollback-linked-launcher-" }, async (base) => {
      const { params, launcher } = await createPackageSwapFixture(base);
      const alias = `${launcher}.alias`;
      await fs.link(launcher, alias);
      const transaction = await retain(params);
      expect(await transaction.rollback()).toMatchObject({ exitCode: 0 });
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
      await expect(fs.readFile(alias, "utf8")).resolves.toBe("old launcher\n");
    });
  });

  it.each([
    "contents",
    "manifest",
    "inventory",
    "root identity",
    "descendant identity",
    "mtime",
    "mode",
    "hardlink",
    "symlink",
    "launcher",
  ] as const)("refuses changed %s before replacing the candidate", async (change) => {
    await withTestDir({ prefix: "openclaw-rollback-integrity-" }, async (base) => {
      const { params, packageRoot, launcher, globalRoot } = await createPackageSwapFixture(base);
      const oldEntry = path.join(packageRoot, "dist", "index.js");
      if (change === "hardlink") {
        await fs.link(oldEntry, path.join(packageRoot, "dist", "peer.js"));
      }
      const transaction = await retain(params);
      const backup = transaction.backupRoot;
      const entry = path.join(backup, "dist", "index.js");
      if (change === "contents") {
        await fs.writeFile(entry, "altered retained package\n");
      }
      if (change === "manifest") {
        await fs.writeFile(
          path.join(backup, "package.json"),
          '{"name":"different","version":"1.0.0"}',
        );
      }
      if (change === "inventory") {
        await fs.writeFile(path.join(backup, "unexpected.js"), "extra");
      }
      if (change === "root identity") {
        await fs.rename(backup, `${backup}.original`);
        await fs.cp(`${backup}.original`, backup, { recursive: true, preserveTimestamps: true });
      }
      if (change === "descendant identity" || change === "hardlink") {
        await fs.copyFile(entry, `${entry}.replacement`);
        await fs.rename(`${entry}.replacement`, entry);
      }
      if (change === "mtime") {
        await fs.utimes(entry, new Date(1), new Date(1));
      }
      if (change === "mode") {
        await fs.chmod(entry, 0o400);
      }
      if (change === "symlink") {
        await fs.unlink(entry);
        await fs.symlink("missing.js", entry);
      }
      if (change === "launcher") {
        const shimBackup = (await fs.readdir(globalRoot)).find((name) =>
          name.startsWith(".openclaw.shim-backup-"),
        )!;
        await fs.writeFile(path.join(globalRoot, shimBackup, "openclaw"), "altered launcher\n");
      }
      const result = await transaction.rollback();
      expect(result).toMatchObject({ exitCode: 1, activePackageRoot: packageRoot });
      await expectCandidateIntact(packageRoot, launcher);
      expect(await transaction.complete({ activationVerified: false })).toMatchObject({
        exitCode: 1,
      });
      await expect(fs.stat(backup)).resolves.toBeDefined();
    });
  });

  it("restores exact identity, internal links and launchers, then cleans up", async () => {
    await withTestDir({ prefix: "openclaw-rollback-unchanged-" }, async (base) => {
      const { params, packageRoot, launcher, globalRoot } = await createPackageSwapFixture(base);
      const entry = path.join(packageRoot, "dist", "index.js");
      await fs.link(entry, path.join(packageRoot, "peer.js"));
      await fs.symlink("dist/index.js", path.join(packageRoot, "relative"));
      await fs.symlink(entry, path.join(packageRoot, "absolute"));
      await fs.symlink(`${entry}/missing`, path.join(packageRoot, "dangling"));
      const transaction = await retain(params);
      const retained = await fs.stat(transaction.backupRoot);
      expect(await transaction.rollback()).toMatchObject({
        exitCode: 0,
        activePackageRoot: packageRoot,
      });
      const restored = await fs.stat(packageRoot);
      expect([restored.dev, restored.ino]).toEqual([retained.dev, retained.ino]);
      expect((await fs.stat(entry)).ino).toBe(
        (await fs.stat(path.join(packageRoot, "peer.js"))).ino,
      );
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
      expect(await transaction.complete({ activationVerified: false })).toBeUndefined();
      expect((await fs.readdir(globalRoot)).filter((name) => name.startsWith("."))).toEqual([]);
      expect(await transaction.rollback()).toMatchObject({ exitCode: 1 });
    });
  });

  it.each(["EXDEV", "EACCES"])(
    "restores the candidate if exact rollback rename fails with %s",
    async (code) => {
      await withTestDir({ prefix: "openclaw-rollback-rename-" }, async (base) => {
        const { transaction, packageRoot, launcher } = await createRetainedPackageSwap(base);
        const rename = fs.rename.bind(fs);
        const copy = vi.spyOn(fs, "cp");
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (String(args[0]) === transaction.backupRoot) {
            throw Object.assign(new Error("rollback rename denied"), { code });
          }
          return rename(...args);
        });
        expect(await transaction.rollback()).toMatchObject({
          exitCode: 1,
          activePackageRoot: packageRoot,
        });
        expect(copy).not.toHaveBeenCalled();
        await expectCandidateIntact(packageRoot, launcher);
        await expect(fs.stat(transaction.backupRoot)).resolves.toBeDefined();
        expect(await transaction.complete({ activationVerified: true })).toMatchObject({
          exitCode: 1,
        });
      });
    },
  );

  it("reports unverified when a pre-opened writer changes bytes after prevalidation", async () => {
    await withTestDir({ prefix: "openclaw-rollback-open-fd-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const entry = path.join(packageRoot, "dist", "index.js");
      const writer = await fs.open(entry, "r+");
      try {
        const transaction = await retain(params);
        const rename = fs.rename.bind(fs);
        let wrote = false;
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (String(args[0]) === transaction.backupRoot) {
            await writer.write("changed", 0, "utf8");
            wrote = true;
          }
          return rename(...args);
        });
        expect(await transaction.rollback()).toMatchObject({ exitCode: 1 });
        expect(wrote).toBe(true);
        // Observation is not exclusion: the same-principal fd survives rename.
        // Never call this result verified or discard the retained candidate.
        await expect(fs.readFile(entry, "utf8")).resolves.toContain("changed");
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        await expect(fs.stat(`${transaction.backupRoot}.candidate`)).resolves.toBeDefined();
        expect(await transaction.complete({ activationVerified: false })).toMatchObject({
          exitCode: 1,
        });
      } finally {
        await writer.close();
      }
    });
  });

  it.each(["external link", "oversized file", "unavailable inode"] as const)(
    "refuses an unverifiable %s before service preparation or live mutation",
    async (shape) => {
      await withTestDir({ prefix: "openclaw-rollback-admission-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        if (shape === "external link") {
          await fs.symlink(base, path.join(packageRoot, "external"));
        }
        if (shape === "oversized file") {
          const file = path.join(packageRoot, "oversized.bin");
          await fs.writeFile(file, "");
          await fs.truncate(file, 1024 * 1024 * 1024 + 1);
        }
        if (shape === "unavailable inode") {
          const lstat = fs.lstat.bind(fs);
          vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
            const stat = await lstat(...args);
            if (typeof stat.ino === "bigint") {
              Object.assign(stat, { ino: 0n });
            }
            return stat;
          });
        }
        const beforeActivate = vi.fn();
        const onLiveMutation = vi.fn();
        const result = await swapStagedPackageInstall({
          ...params,
          beforeActivate,
          onLiveMutation,
        });
        expect(result.status).toBe("failed");
        expect(beforeActivate).not.toHaveBeenCalled();
        expect(onLiveMutation).not.toHaveBeenCalled();
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
      });
    },
  );
});
