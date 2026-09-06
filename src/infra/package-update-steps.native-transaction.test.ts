import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory.js";
import {
  runGlobalPackageUpdateSteps,
  type PackageUpdateTransaction,
} from "./package-update-steps.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";

function readPnpmStageArgs(argv: string[]) {
  return {
    projectRoot: argv
      .find((arg) => arg.startsWith("--config.global-dir="))
      ?.slice("--config.global-dir=".length),
    binDir: argv
      .find((arg) => arg.startsWith("--config.global-bin-dir="))
      ?.slice("--config.global-bin-dir=".length),
  };
}

describe.runIf(process.platform !== "win32")("native package transactions", () => {
  it.each([
    ...(["pnpm10", "pnpm11", "bun"] as const).flatMap((layout) =>
      (["none", "before", "after", "upgrade", "remove"] as const).map((siblingChange) => ({
        layout,
        siblingChange,
        shimFailure: false,
        rollbackFailure: "none" as const,
      })),
    ),
    {
      layout: "pnpm11",
      siblingChange: "none",
      shimFailure: true,
      rollbackFailure: "none",
    } as const,
    ...(["shim", "package", "backup-cleanup"] as const).map((rollbackFailure) => ({
      layout: "pnpm11" as const,
      siblingChange: "none" as const,
      shimFailure: false,
      rollbackFailure,
    })),
  ])(
    "preserves $layout native project ownership (sibling change=$siblingChange, shim failure=$shimFailure, rollback failure=$rollbackFailure)",
    async ({ layout, siblingChange, shimFailure, rollbackFailure }) => {
      await withTestDir({ prefix: "openclaw-native-update-" }, async (base) => {
        const manager = layout === "bun" ? "bun" : "pnpm";
        const project = path.join(base, manager, "global");
        const globalRoot =
          layout === "pnpm11"
            ? path.join(project, "v11")
            : path.join(
                project,
                ...(layout === "pnpm10" ? ["5", "node_modules"] : ["node_modules"]),
              );
        const oldOwner =
          layout === "pnpm11" ? path.join(globalRoot, "old") : path.dirname(globalRoot);
        const packageRoot =
          layout === "pnpm11"
            ? path.join(oldOwner, "node_modules", "openclaw")
            : path.join(globalRoot, "openclaw");
        const binDir = path.join(base, "native-bin");
        const launcher = path.join(binDir, "openclaw");
        const metadata = path.join(project, "manager-metadata");
        const sibling = path.join(project, "sibling-package");
        await writePackageRoot(packageRoot, "1.0.0");
        const existingSibling = path.join(path.dirname(packageRoot), "existing-sibling");
        await fs.mkdir(existingSibling, { recursive: true });
        await fs.writeFile(
          path.join(existingSibling, "package.json"),
          '{"name":"existing-sibling","version":"1.0.0"}',
        );
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(launcher, "old launcher\n");
        await fs.writeFile(metadata, "original metadata\n");
        await fs.writeFile(sibling, "unrelated package\n");
        if (layout === "pnpm11") {
          await fs.writeFile(
            path.join(oldOwner, "package.json"),
            JSON.stringify({ dependencies: { openclaw: "1.0.0" } }),
          );
          await fs.writeFile(path.join(oldOwner, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
          await fs.symlink("old", path.join(globalRoot, "hash-openclaw"));
        }
        const target: ResolvedGlobalInstallTarget = {
          manager,
          command: manager,
          globalRoot,
          packageRoot,
          ...(layout === "pnpm11" ? { pnpmIsolated: { layoutVersion: 11 } } : {}),
        };
        let retained: PackageUpdateTransaction | undefined;
        let stagedLauncher: string;
        const preparationStarted = createDeferred();
        const finishPreparation = createDeferred();
        const phases: string[] = [];
        let cleanupRejected = false;
        const originalRename = fs.rename.bind(fs);
        const originalUnlink = fs.unlink.bind(fs);
        const backupRenameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (rollbackFailure === "backup-cleanup" && String(args[0]) === project) {
            throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
          }
          return originalRename(...args);
        });
        const backupUnlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (entryPath) => {
          if (
            rollbackFailure === "backup-cleanup" &&
            String(entryPath) === path.join(packageRoot, "dist", "index.js")
          ) {
            await fs.rm(path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH), {
              force: true,
            });
            await originalUnlink(entryPath);
            cleanupRejected = true;
            throw Object.assign(new Error("source cleanup failed after commit"), {
              code: "EACCES",
            });
          }
          return originalUnlink(entryPath);
        });
        const update = runGlobalPackageUpdateSteps({
          installTarget: target,
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          env: {
            PATH: process.env.PATH,
            PNPM_HOME: path.dirname(project),
            pnpm_config_global_dir: project,
            pnpm_config_global_bin_dir: binDir,
            BUN_INSTALL_GLOBAL_DIR: project,
            BUN_INSTALL_BIN: binDir,
          },
          runCommand: async (argv, options) => {
            const stage = readPnpmStageArgs(argv);
            if (stage.projectRoot) {
              expect(options.cwd).toBe(stage.projectRoot);
              expect(stage.projectRoot).not.toBe(project);
              expect(stage.binDir).not.toBe(binDir);
              phases.push(`probe ${argv[1]}`);
            }
            return {
              code: 0,
              stderr: "",
              stdout: argv.includes("root")
                ? `${stage.projectRoot ? path.join(stage.projectRoot, path.relative(project, globalRoot)) : globalRoot}\n`
                : `${stage.binDir ?? binDir}\n`,
            };
          },
          runStep: async ({ name, argv, cwd, env }) => {
            expect(argv[0]).toBe(manager);
            const stageArgs = readPnpmStageArgs(argv);
            const stageProject =
              manager === "bun" ? env?.BUN_INSTALL_GLOBAL_DIR : stageArgs.projectRoot;
            const stageBin = manager === "bun" ? env?.BUN_INSTALL_BIN : stageArgs.binDir;
            if (!stageProject || !stageBin) {
              throw new Error("native staging destinations missing");
            }
            expect(cwd).toBe(stageProject);
            expect(stageProject).not.toBe(project);
            await expect(
              fs.readFile(path.join(stageProject, "sibling-package"), "utf8"),
            ).resolves.toBe("unrelated package\n");
            const stageGlobal = path.join(stageProject, path.relative(project, globalRoot));
            const nextOwner =
              layout === "pnpm11" ? path.join(stageGlobal, "new") : path.dirname(stageGlobal);
            const candidateRoot =
              layout === "pnpm11"
                ? path.join(nextOwner, "node_modules", "openclaw")
                : path.join(stageGlobal, "openclaw");
            await writePackageRoot(candidateRoot, "2.0.0");
            await fs.writeFile(path.join(stageProject, "manager-metadata"), "candidate metadata\n");
            if (layout === "pnpm11") {
              await fs.writeFile(
                path.join(nextOwner, "package.json"),
                JSON.stringify({ dependencies: { openclaw: "2.0.0" } }),
              );
              await fs.writeFile(
                path.join(nextOwner, "pnpm-lock.yaml"),
                "lockfileVersion: '9.0'\n",
              );
              await fs.rm(path.join(stageGlobal, "hash-openclaw"));
              await fs.symlink("new", path.join(stageGlobal, "hash-openclaw"));
              if (shimFailure) {
                await fs.rm(path.join(stageGlobal, "old"), { recursive: true });
              }
            }
            const linkedPackage =
              layout === "pnpm11"
                ? path.join(stageGlobal, "hash-openclaw", "node_modules", "openclaw")
                : candidateRoot;
            await fs.mkdir(stageBin, { recursive: true });
            stagedLauncher = path.join(stageBin, "openclaw");
            await fs.symlink(
              path.relative(stageBin, path.join(linkedPackage, "dist", "index.js")),
              stagedLauncher,
            );
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? stageProject,
              durationMs: 0,
              exitCode: 0,
            };
          },
          validateCandidate: async (candidateRoot) => {
            phases.push("validate");
            await expect(
              fs.readFile(path.join(candidateRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"2.0.0"');
            await expect(
              fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"1.0.0"');
            await expect(fs.readFile(metadata, "utf8")).resolves.toBe("original metadata\n");
            return [];
          },
          beforeActivate: async () => {
            phases.push("stop");
            preparationStarted.resolve();
            if (siblingChange === "before") {
              await finishPreparation.promise;
            }
          },
          onTransaction: (transaction) => {
            retained = transaction;
            if (shimFailure) {
              // Lose a prepared launcher after backup, so publication fails only
              // after the new native project has replaced the old package path.
              unlinkSync(stagedLauncher);
            }
          },
          timeoutMs: 1000,
        });
        const siblingOwner =
          layout === "pnpm11" ? path.join(globalRoot, "sibling-owner") : oldOwner;
        const siblingManifest = path.join(siblingOwner, "package.json");
        const siblingEntry = path.join(siblingOwner, "node_modules", "sibling", "index.js");
        const concurrentManifest = JSON.stringify({
          dependencies: { openclaw: "1.0.0", sibling: "2.0.0" },
        });
        if (siblingChange === "before") {
          await preparationStarted.promise;
          try {
            await fs.mkdir(path.dirname(siblingEntry), { recursive: true });
            await fs.writeFile(siblingEntry, "concurrent sibling package\n");
            await fs.writeFile(siblingManifest, concurrentManifest);
            if (layout === "pnpm11") {
              await fs.symlink("sibling-owner", path.join(globalRoot, "hash-sibling"));
            }
          } finally {
            finishPreparation.resolve();
          }
        }
        const result = await update.finally(() => {
          backupRenameSpy.mockRestore();
          backupUnlinkSpy.mockRestore();
        });
        if (rollbackFailure === "backup-cleanup") {
          expect(cleanupRejected).toBe(true);
          expect(result.failedStep?.stderrTail).toContain("source cleanup failed after commit");
          expect(result.activePackageRoot).toBeNull();
          expect(result.recovery?.serviceRestartSafe).toBe(false);
          if (!retained) {
            throw new Error("transaction missing");
          }
          expect(await retained.rollback()).toMatchObject({ exitCode: 1, activePackageRoot: null });
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          await expect(
            fs.readFile(
              path.join(
                retained.backupRoot,
                path.relative(project, packageRoot),
                "dist",
                "index.js",
              ),
              "utf8",
            ),
          ).resolves.toBe("export {};\n");
          return;
        }
        if (shimFailure) {
          const activeRoot = path.join(globalRoot, "new", "node_modules", "openclaw");
          expect(result.failedStep).toMatchObject({ name: "global install swap", exitCode: 1 });
          expect(result.activePackageRoot).toBe(activeRoot);
          expect(result.afterVersion).toBe("2.0.0");
          await expect(fs.stat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await retained?.rollback()).toMatchObject({
            exitCode: 0,
            activePackageRoot: packageRoot,
          });
          await retained?.complete({ activationVerified: false });
          expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
            '"version":"1.0.0"',
          );
          expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
          return;
        }
        if (siblingChange === "before") {
          // Exercise normal confirmation too: a stale project swap must not hide
          // the sibling in a backup that successful cleanup subsequently deletes.
          await retained?.complete({ activationVerified: false });
          await expect(fs.readFile(siblingEntry, "utf8")).resolves.toBe(
            "concurrent sibling package\n",
          );
          await expect(fs.readFile(siblingManifest, "utf8")).resolves.toBe(concurrentManifest);
          expect(result.failedStep).toMatchObject({ name: "global install swap", exitCode: 1 });
          expect(result.failedStep?.stderrTail).toContain("native global installation changed");
          expect(result.afterVersion).toBe("1.0.0");
          expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
          expect(retained).toBeUndefined();
          expect(phases).toEqual([
            ...(manager === "pnpm" ? ["probe root", "probe bin"] : []),
            "validate",
            "stop",
          ]);
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
          expect(
            (await fs.readdir(path.dirname(project))).filter((entry) => entry.startsWith(".")),
          ).toEqual([]);
          return;
        }
        expect(result.failedStep).toBeNull();
        expect(phases).toEqual([
          ...(manager === "pnpm" ? ["probe root", "probe bin"] : []),
          "validate",
          "stop",
        ]);
        expect(result.afterVersion).toBe("2.0.0");
        await expect(fs.readFile(metadata, "utf8")).resolves.toBe("candidate metadata\n");
        await expect(fs.readFile(sibling, "utf8")).resolves.toBe("unrelated package\n");
        await expect(fs.realpath(launcher)).resolves.toBe(
          path.join(result.activePackageRoot!, "dist", "index.js"),
        );
        if (!retained) {
          throw new Error("transaction missing");
        }
        if (["after", "upgrade", "remove"].includes(siblingChange)) {
          const lateSiblingEntry = path.join(
            path.dirname(result.activePackageRoot!),
            "sibling",
            "index.js",
          );
          if (siblingChange === "after") {
            await fs.mkdir(path.dirname(lateSiblingEntry), { recursive: true });
            await fs.writeFile(lateSiblingEntry, "late sibling package\n");
          } else if (siblingChange === "upgrade") {
            await fs.writeFile(
              path.join(existingSibling, "package.json"),
              '{"name":"existing-sibling","version":"2.0.0"}',
            );
          } else {
            await fs.rm(existingSibling, { recursive: true });
          }
          const candidateLauncher = await fs.readlink(launcher);
          const rollback = await retained.rollback();
          expect(rollback).toMatchObject({
            exitCode: 1,
            reason: "rollback-project-changed",
            activePackageRoot: result.activePackageRoot,
          });
          expect(rollback.stderrTail).toContain("sibling");
          expect(rollback.stderrTail).not.toContain(base);
          await retained.complete({ activationVerified: false });
          if (siblingChange === "after") {
            await expect(fs.readFile(lateSiblingEntry, "utf8")).resolves.toBe(
              "late sibling package\n",
            );
          } else if (siblingChange === "upgrade") {
            await expect(
              fs.readFile(path.join(existingSibling, "package.json"), "utf8"),
            ).resolves.toContain('"version":"2.0.0"');
          } else {
            await expect(fs.stat(existingSibling)).rejects.toMatchObject({ code: "ENOENT" });
          }
          await expect(fs.readFile(metadata, "utf8")).resolves.toBe("candidate metadata\n");
          await expect(fs.readlink(launcher)).resolves.toBe(candidateLauncher);
          await expect(
            fs.readFile(path.join(result.activePackageRoot!, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
          await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
          return;
        }
        // Verification may repair only the candidate payload without changing sibling ownership.
        await fs.writeFile(
          path.join(result.activePackageRoot!, "package.json"),
          '{"name":"openclaw","version":"2.0.1"}',
        );
        const copyFile = fs.copyFile.bind(fs);
        const rename = fs.rename.bind(fs);
        const backupRoot = retained.backupRoot;
        const copySpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
          if (rollbackFailure === "shim" && String(args[1]) === launcher) {
            throw Object.assign(new Error("launcher restoration failed"), { code: "EACCES" });
          }
          return copyFile(...args);
        });
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (rollbackFailure === "package" && String(args[0]) === backupRoot) {
            throw Object.assign(new Error("package restoration failed"), { code: "EACCES" });
          }
          return rename(...args);
        });
        try {
          expect(await retained.rollback()).toMatchObject({
            exitCode: rollbackFailure === "none" ? 0 : 1,
            activePackageRoot: rollbackFailure === "package" ? null : packageRoot,
          });
        } finally {
          copySpy.mockRestore();
          renameSpy.mockRestore();
        }
        if (rollbackFailure !== "none") {
          await retained.complete({ activationVerified: false });
          if (rollbackFailure === "package") {
            await expect(fs.stat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
          } else {
            expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
              '"version":"1.0.0"',
            );
            await expect(fs.stat(launcher)).rejects.toMatchObject({ code: "ENOENT" });
          }
          return;
        }
        await retained.complete({ activationVerified: false });
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
        await expect(fs.readFile(metadata, "utf8")).resolves.toBe("original metadata\n");
        await expect(fs.readFile(sibling, "utf8")).resolves.toBe("unrelated package\n");
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        expect(
          (await fs.readdir(path.dirname(project))).filter((entry) => entry.startsWith(".")),
        ).toEqual([]);
      });
    },
  );

  it.each(["root", "bin", "probe-error"] as const)(
    "refuses pnpm staging before install when the effective destination fails (%s)",
    async (failure) => {
      await withTestDir({ prefix: "openclaw-pnpm-stage-destination-" }, async (base) => {
        const project = path.join(base, "global");
        const globalRoot = path.join(project, "5", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const binDir = path.join(base, "bin");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.mkdir(binDir);
        await fs.writeFile(path.join(binDir, "openclaw"), "live launcher\n");
        const beforeActivate = vi.fn(async () => {});
        const runStep = vi.fn(async () => {
          throw new Error("installation must not run after a refused destination probe");
        });
        let stageRoot: string | undefined;
        let stageBin: string | undefined;
        const result = await runGlobalPackageUpdateSteps({
          installTarget: { manager: "pnpm", command: "pnpm", globalRoot, packageRoot },
          packageName: "openclaw",
          installSpec: "openclaw@2.0.0",
          runCommand: async (argv, options) => {
            const stage = readPnpmStageArgs(argv);
            if (!stage.projectRoot) {
              return { code: 0, stdout: `${binDir}\n`, stderr: "" };
            }
            stageRoot = stage.projectRoot;
            stageBin = stage.binDir;
            expect(options.cwd).toBe(stageRoot);
            if (failure === "probe-error") {
              return { code: 1, stdout: "", stderr: "pnpm destination configuration rejected" };
            }
            return {
              code: 0,
              stdout:
                argv[1] === "root"
                  ? `${failure === "root" ? globalRoot : path.join(stageRoot, "5", "node_modules")}\n`
                  : `${failure === "bin" ? binDir : stageBin}\n`,
              stderr: "",
            };
          },
          runStep,
          beforeActivate,
          timeoutMs: 1000,
        });
        expect(result.failedStep).toMatchObject({ name: "pnpm staging preflight", exitCode: 1 });
        expect(result.failedStep?.stderrTail).toContain(
          failure === "probe-error" ? "configuration rejected" : `pnpm ${failure} selected`,
        );
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
        expect(runStep).not.toHaveBeenCalled();
        expect(beforeActivate).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
          '"version":"1.0.0"',
        );
        expect(await fs.readFile(path.join(binDir, "openclaw"), "utf8")).toBe("live launcher\n");
        expect(stageRoot).toBeDefined();
        expect(stageBin).toBeDefined();
        await expect(fs.stat(stageRoot!)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(stageBin!)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});

it("gives actionable Windows Bun recovery before stopping or installing", async () => {
  await withTestDir({ prefix: "openclaw-windows-bun-refusal-" }, async (base) => {
    const project = path.join(base, "global");
    const globalRoot = path.join(project, "node_modules");
    const packageRoot = path.join(globalRoot, "openclaw");
    const binDir = path.join(base, "bin");
    await writePackageRoot(packageRoot, "1.0.0");
    const beforeActivate = vi.fn(async () => {});
    const runStep = vi.fn(async () => {
      throw new Error("A refused Windows Bun update must not install a package");
    });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const result = await runGlobalPackageUpdateSteps({
        installTarget: { manager: "bun", command: "bun", globalRoot, packageRoot },
        packageName: "openclaw",
        installSpec: "openclaw@2.0.0",
        env: { BUN_INSTALL_GLOBAL_DIR: project, BUN_INSTALL_BIN: binDir },
        runCommand: async () => ({ code: 0, stdout: binDir, stderr: "" }),
        runStep,
        beforeActivate,
        timeoutMs: 1000,
      });
      expect(result.failedStep).toMatchObject({ name: "global install stage", exitCode: 1 });
      expect(result.failedStep?.stderrTail).toContain("bun add -g --trust openclaw@2.0.0");
      expect(result.failedStep?.stderrTail).toContain("openclaw gateway restart");
      expect(result.failedStep?.stderrTail).toContain("openclaw update status");
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      expect(runStep).not.toHaveBeenCalled();
      expect(beforeActivate).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });
});
