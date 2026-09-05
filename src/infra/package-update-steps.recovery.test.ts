import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";

describe("npm lifecycle policy preflight", () => {
  it.each([false, true])(
    "verifies the original package before recovery from preflight refusal (corrupt=%s)",
    async (corrupt) => {
      await withTestDir({ prefix: "openclaw-recovery-preflight-" }, async (base) => {
        const globalRoot = path.join(base, "lib", "node_modules");
        const target = createNpmTarget(globalRoot);
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        if (corrupt) {
          await fs.rm(path.join(packageRoot, "dist", "index.js"));
        }
        target.npmOwner = {
          version: null,
          lifecyclePolicy: null,
          probeError: "version probe failed",
        };
        const runStep = vi.fn();
        const runCommand = vi.fn(createRootRunner(globalRoot));
        const result = await runGlobalPackageUpdateSteps({
          installTarget: target,
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          runCommand,
          runStep,
          timeoutMs: 1000,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "Unable to determine the owning npm version",
        );
        expect(runCommand).not.toHaveBeenCalled();
        expect(runStep).not.toHaveBeenCalled();
        expect(result.recovery).toEqual(
          corrupt
            ? { serviceRestartSafe: false, reason: "runtime-verification-failed" }
            : { serviceRestartSafe: true, version: "1.0.0" },
        );
      });
    },
  );
});

describe("package update recovery safety", () => {
  it("recovers the verified original when staging preparation fails before hooks run", async () => {
    await withTestDir({ prefix: "openclaw-package-stage-recovery-" }, async (base) => {
      const globalRoot = path.join(base, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const stage = vi
        .spyOn(fs, "mkdtemp")
        .mockRejectedValueOnce(Object.assign(new Error("stage denied"), { code: "EACCES" }));
      const runStep = vi.fn();
      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });
        expect(result.failedStep?.name).toBe("global install stage");
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
        expect(runStep).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).toBe(
          "export {};\n",
        );
      } finally {
        stage.mockRestore();
      }
    });
  });

  it.each(
    (["pnpm", "bun", "npm"] as const).flatMap((manager) =>
      (["install exit", "install throw", "doctor throw"] as const).flatMap((failure) =>
        (manager === "npm" && failure !== "doctor throw"
          ? (["none", "replaced", "corrupt"] as const)
          : (["none"] as const)
        ).map((stagingSideEffect) => ({ manager, failure, stagingSideEffect })),
      ),
    ),
  )(
    "verifies $manager recovery after $failure with $stagingSideEffect staging side effect",
    async ({ manager, failure, stagingSideEffect }) => {
      await withTestDir({ prefix: "openclaw-package-recovery-" }, async (base) => {
        const globalRoot =
          manager === "npm" ? path.join(base, "lib", "node_modules") : path.join(base, "global");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        const params = {
          installTarget:
            manager === "npm"
              ? createNpmTarget(globalRoot)
              : { manager, command: manager, globalRoot, packageRoot },
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }: { name: string; argv: string[] }) => {
            const prefix = argv[argv.indexOf("--prefix") + 1];
            const installRoot =
              manager === "npm" && prefix
                ? path.join(prefix, "lib", "node_modules", "openclaw")
                : packageRoot;
            await writePackageRoot(installRoot, "2.0.0");
            if (stagingSideEffect === "replaced") {
              await writePackageRoot(packageRoot, "2.0.0");
            } else if (stagingSideEffect === "corrupt") {
              await fs.rm(path.join(packageRoot, "dist", "index.js"), { force: true });
            }
            if (failure === "install throw") {
              throw new Error("install interrupted");
            }
            return {
              name,
              command: argv.join(" "),
              cwd: globalRoot,
              durationMs: 0,
              exitCode: failure === "install exit" ? 1 : 0,
            };
          },
          postVerifyStep: async () => {
            throw new Error("doctor interrupted after replacement");
          },
          timeoutMs: 1000,
        };
        const result = await runGlobalPackageUpdateSteps(params);

        expect(result.failedStep).not.toBeNull();
        const safe =
          manager === "npm" && failure !== "doctor throw" && stagingSideEffect === "none";
        expect(result.recovery).toEqual(
          safe
            ? { serviceRestartSafe: true, version: "1.0.0" }
            : {
                serviceRestartSafe: false,
                reason: "runtime-verification-failed",
                ...(manager === "npm" && failure === "doctor throw"
                  ? { packageRollbackVerified: true }
                  : {}),
              },
        );
        const liveVersion =
          manager === "npm" && stagingSideEffect !== "replaced" ? "1.0.0" : "2.0.0";
        if (failure === "doctor throw") {
          expect(result.afterVersion).toBe(liveVersion);
        }
        expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
          `"version":"${liveVersion}"`,
        );
      });
    },
  );

  it.each(["backup", "activation"] as const)(
    "handles a %s move rejected after staged lifecycle mutates state",
    async (failure) => {
      await withTestDir({ prefix: "openclaw-package-move-recovery-" }, async (base) => {
        const globalRoot = path.join(base, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        const stateCanary = path.join(base, "synthetic-state");
        let source = failure === "backup" ? packageRoot : "";
        let copied = false;
        let cleanupRejected = false;
        const rename = fs.rename.bind(fs);
        const unlink = fs.unlink.bind(fs);
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (String(args[0]) === source && !copied) {
            copied = true;
            throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
          }
          return await rename(...args);
        });
        const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
          await unlink(target);
          if (String(target) === path.join(source, "dist", "index.js") && !cleanupRejected) {
            cleanupRejected = true;
            throw Object.assign(new Error("source cleanup failed after commit"), {
              code: "EACCES",
            });
          }
        });
        let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
        try {
          result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            timeoutMs: 1000,
            runStep: async ({ name, argv }) => {
              const prefix = argv[argv.indexOf("--prefix") + 1];
              if (!prefix) {
                throw new Error("missing stage prefix");
              }
              const staged = path.join(prefix, "lib", "node_modules", "openclaw");
              await writePackageRoot(staged, "2.0.0");
              await fs.writeFile(stateCanary, "migrated by staged lifecycle");
              if (failure === "activation") {
                source = staged;
              }
              return { name, command: argv.join(" "), cwd: prefix, durationMs: 0, exitCode: 0 };
            },
          });
        } finally {
          renameSpy.mockRestore();
          unlinkSpy.mockRestore();
        }
        expect(cleanupRejected).toBe(true);
        expect(await fs.readFile(stateCanary, "utf8")).toBe("migrated by staged lifecycle");
        // Main's old activation decision allowed anything except an explicit false.
        // Restored package bytes cannot undo the lifecycle's state mutation.
        expect(result.recovery?.serviceRestartSafe).toBe(false);
        expect(result.failedStep?.stderrTail).toContain("source cleanup failed after commit");
        if (failure === "backup") {
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const backups = (await fs.readdir(globalRoot)).filter((name) =>
            name.startsWith(`.openclaw.package-backup-${process.pid}-`),
          );
          expect(backups).toHaveLength(1);
          await expect(
            fs.readFile(path.join(globalRoot, backups[0] ?? "", "dist", "index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        } else {
          expect(result.afterVersion).toBe("1.0.0");
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        }
      });
    },
  );

  it.each(["blocking", "throwing", "missing", "success"] as const)(
    "commits staged npm only after a %s Doctor outcome",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-package-recovery-swap-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const binDir = path.join(prefix, "bin");
        const shimNames = ["openclaw", "openclaw.cmd", "openclaw.ps1"];
        const stateCanary = path.join(base, "candidate-doctor-state");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.mkdir(binDir, { recursive: true });
        await Promise.all(
          shimNames.map((name) => fs.writeFile(path.join(binDir, name), `old ${name}\n`, "utf8")),
        );

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            const stagedBinDir = path.join(stagePrefix, "bin");
            await fs.mkdir(stagedBinDir, { recursive: true });
            await Promise.all(
              shimNames.map((shimName) =>
                fs.writeFile(path.join(stagedBinDir, shimName), `new ${shimName}\n`, "utf8"),
              ),
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => {
            expect(candidateRoot).toBe(packageRoot);
            await expect(
              fs.readFile(path.join(candidateRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"2.0.0"');
            for (const shimName of shimNames) {
              await expect(fs.readFile(path.join(binDir, shimName), "utf8")).resolves.toBe(
                `new ${shimName}\n`,
              );
            }
            await fs.writeFile(stateCanary, "mutated by candidate Doctor\n", "utf8");
            if (outcome === "throwing") {
              throw new Error("doctor interrupted after swap");
            }
            if (outcome === "missing") {
              return null;
            }
            return {
              name: "openclaw doctor",
              command: "openclaw doctor --non-interactive --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: outcome === "blocking" ? 1 : 0,
              stderrTail: outcome === "blocking" ? "doctor rejected candidate" : null,
            };
          },
          timeoutMs: 1000,
        });

        const expectedVersion = outcome === "success" ? "2.0.0" : "1.0.0";
        expect(result.afterVersion).toBe(expectedVersion);
        expect(await fs.readFile(stateCanary, "utf8")).toBe("mutated by candidate Doctor\n");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain(`"version":"${expectedVersion}"`);
        for (const shimName of shimNames) {
          await expect(fs.readFile(path.join(binDir, shimName), "utf8")).resolves.toBe(
            `${outcome === "success" ? "new" : "old"} ${shimName}\n`,
          );
        }
        expect((await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."))).toEqual([]);
        if (outcome === "success") {
          expect(result.failedStep).toBeNull();
          expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "2.0.0" });
        } else {
          expect(result.failedStep).not.toBeNull();
          expect(result.recovery).toEqual({
            serviceRestartSafe: false,
            reason: "runtime-verification-failed",
            packageRollbackVerified: true,
          });
          expect(
            result.steps.find((step) => step.name === "global install swap")?.stdoutTail,
          ).toContain("restored previous openclaw package and affected launchers");
          expect(
            result.steps.find((step) => step.name === "global install swap")?.stdoutTail,
          ).toContain("candidate Doctor may have changed persistent state");
        }
      });
    },
  );

  it("retains launcher backup evidence when post-Doctor rollback fails", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-failed-rollback-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const binDir = path.join(prefix, "bin");
      const targetShim = path.join(binDir, "openclaw");
      const targetCmdShim = path.join(binDir, "openclaw.cmd");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(targetShim, "old openclaw\n", "utf8");
      await fs.writeFile(targetCmdShim, "old openclaw.cmd\n", "utf8");
      const copyFile = fs.copyFile.bind(fs);
      const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        const source = String(args[0]);
        if (
          String(args[1]) === targetCmdShim &&
          path.basename(path.dirname(source)).startsWith(".openclaw.shim-backup-")
        ) {
          throw Object.assign(new Error("launcher restoration denied"), { code: "EACCES" });
        }
        return await copyFile(...args);
      });
      let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
      try {
        result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            const stagedBinDir = path.join(stagePrefix, "bin");
            await fs.mkdir(stagedBinDir, { recursive: true });
            await fs.writeFile(path.join(stagedBinDir, "openclaw"), "new openclaw\n", "utf8");
            await fs.writeFile(
              path.join(stagedBinDir, "openclaw.cmd"),
              "new openclaw.cmd\n",
              "utf8",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => ({
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          }),
          timeoutMs: 1000,
        });
      } finally {
        copyFileSpy.mockRestore();
      }

      expect(result.failedStep).toMatchObject({ name: "global install swap", exitCode: 1 });
      expect(result.failedStep?.stderrTail).toContain("launcher restoration denied");
      expect(result.failedStep?.stderrTail).toContain(`launcher ${targetCmdShim} was not restored`);
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: false,
      });
      expect(result.afterVersion).toBe("1.0.0");
      await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old openclaw\n");
      await expect(fs.readFile(targetCmdShim, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const backupDirs = (await fs.readdir(globalRoot)).filter((entry) =>
        entry.startsWith(".openclaw.shim-backup-"),
      );
      expect(backupDirs).toHaveLength(1);
      await expect(
        fs.readFile(path.join(globalRoot, backupDirs[0] ?? "", "openclaw.cmd"), "utf8"),
      ).resolves.toBe("old openclaw.cmd\n");
    });
  });
});
