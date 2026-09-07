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

  it.each(["external link", "linked root", "oversized file", "unavailable inode"] as const)(
    "refuses an unverifiable %s before service preparation or live mutation",
    async (shape) => {
      await withTestDir({ prefix: "openclaw-rollback-admission-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        if (shape === "external link") {
          await fs.symlink(base, path.join(packageRoot, "external"));
        }
        if (shape === "linked root") {
          const external = path.join(base, "external");
          await fs.rename(packageRoot, external);
          await fs.symlink(
            external,
            packageRoot,
            process.platform === "win32" ? "junction" : "dir",
          );
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
