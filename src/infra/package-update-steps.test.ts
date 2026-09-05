// Covers package update step orchestration.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  markPackagePostInstallDoctorAdvisory,
  runGlobalPackageUpdateSteps,
} from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
} from "./update-doctor-result.js";
import {
  resolveNpmGlobalPrefixLayoutFromPrefix,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

type PackageUpdateStepResult = Awaited<
  ReturnType<typeof runGlobalPackageUpdateSteps>
>["steps"][number];

async function addHardlinkedPackageFile(packageRoot: string, linkRoot: string): Promise<void> {
  const packageFile = path.join(packageRoot, "dist", "index.js");
  await fs.mkdir(linkRoot, { recursive: true });
  await fs.link(packageFile, path.join(linkRoot, `${path.basename(packageRoot)}-index.js`));
}

function createFsError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function createPnpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "pnpm",
    command: "pnpm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
  };
}

async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

describe("markPackagePostInstallDoctorAdvisory", () => {
  it("marks only explicit post-install doctor advisory exits", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        stderrTail: "doctor deferred repair",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult(["deferred configured plugin repair"]),
    );

    expect(step.advisory).toEqual({
      kind: "package-post-install-doctor",
      message: expect.stringContaining("recoverable update-time repair warning"),
    });
    expect(step.stderrTail).toContain("doctor deferred repair");
    expect(step.stderrTail).toContain("deferred configured plugin repair");
  });

  it("keeps advisory diagnostics bounded after appending deferred repair details", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        stderrTail: "doctor deferred repair",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult([
        `deferred configured plugin repair ${"x".repeat(10_000)}`,
      ]),
    );

    expect(step.stderrTail).toHaveLength(8_001);
    expect(step.stderrTail).toMatch(/^…/u);
    expect(step.stderrTail).toContain("recoverable update-time repair warning");
  });

  it("does not mark unknown nonzero doctor exits as advisory", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: 1,
        stderrTail: "doctor refused migration",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      null,
    );

    expect(step.advisory).toBeUndefined();
    expect(step.stderrTail).toBe("doctor refused migration");
  });

  it("does not mark timed-out doctor exits as advisory when they report a code", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: 124,
        stderrTail: "doctor timed out",
        signal: null,
        killed: true,
        termination: "timeout" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult(["deferred configured plugin repair"]),
    );

    expect(step.advisory).toBeUndefined();
    expect(step.stderrTail).toBe("doctor timed out");
  });
});

describe("runGlobalPackageUpdateSteps", () => {
  it.runIf(process.platform !== "win32")(
    "swaps npm package roots that contain package-manager hardlinks",
    async () => {
      await withTestDir({ prefix: "openclaw-package-update-hardlinks-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await addHardlinkedPackageFile(packageRoot, path.join(base, "cache", "existing"));

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
            if (name !== "global update") {
              throw new Error(`unexpected step ${name}`);
            }
            const prefixIndex = argv.indexOf("--prefix");
            const stagePrefix = argv[prefixIndex + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
            await writePackageRoot(stagedPackageRoot, "2.0.0");
            await addHardlinkedPackageFile(stagedPackageRoot, path.join(base, "cache", "staged"));
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          },
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("2.0.0");
        expect(result.steps.map((step) => step.name)).toEqual([
          "global update",
          "global install swap",
        ]);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2.0.0"');
        await expect(fs.lstat(path.join(packageRoot, "dist", "index.js"))).resolves.toMatchObject({
          nlink: 2,
        });
      });
    },
  );

  it("swaps staged npm updates into an explicitly selected direct node_modules root", async () => {
    await withTestDir({ prefix: "openclaw-package-update-direct-root-" }, async (base) => {
      const managedRoot = path.join(base, ".openclaw", "npm", "node_modules");
      const packageRoot = path.join(managedRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        const prefixIndex = argv.indexOf("--prefix");
        expect(prefixIndex).toBeGreaterThan(0);
        const stagePrefix = argv[prefixIndex + 1];
        if (!stagePrefix) {
          throw new Error("missing staged prefix");
        }
        expect(path.dirname(stagePrefix)).toBe(managedRoot);
        await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0");
        await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
        await fs.symlink(
          "../lib/node_modules/openclaw/dist/index.js",
          path.join(stagePrefix, "bin", "openclaw"),
        );
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          ...createNpmTarget(managedRoot),
          directNodeModulesRoot: true,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(path.join(base, "shell", "lib", "node_modules")),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.verifiedPackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("2.0.0");
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      await expectPathMissing(path.join(managedRoot, ".bin", "openclaw"));
    });
  });

  it("accepts v-prefixed exact npm specs when verifying staged installs", async () => {
    await withTestDir({ prefix: "openclaw-package-update-v-prefix-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv).toContain("openclaw@v2.0.0");
        const prefixIndex = argv.indexOf("--prefix");
        const stagePrefix = argv[prefixIndex + 1];
        if (!stagePrefix) {
          throw new Error("missing staged prefix");
        }
        await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0");
        await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
        await fs.symlink(
          "../lib/node_modules/openclaw/dist/index.js",
          path.join(stagePrefix, "bin", "openclaw"),
        );
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@v2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install swap",
      ]);
    });
  });

  it.each([
    { installSpec: "openclaw@^2.0.0", installedVersion: "2.4.1" },
    { installSpec: "openclaw@nightly", installedVersion: "3.0.0-beta.2" },
  ])(
    "accepts concrete version $installedVersion staged from $installSpec",
    async ({ installSpec, installedVersion }) => {
      await withTestDir({ prefix: "openclaw-package-update-moving-spec-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        const postVerifyStep = vi.fn(async (root: string) => ({
          name: "candidate validation",
          command: "doctor",
          cwd: root,
          durationMs: 1,
          exitCode: 0,
        }));

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec,
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }) => {
            if (name !== "global update") {
              throw new Error(`unexpected step ${name}`);
            }
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              installedVersion,
            );
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          },
          timeoutMs: 1000,
          postVerifyStep,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe(installedVersion);
        expect(result.steps.map((step) => step.name)).toEqual([
          "global update",
          "global install swap",
          "candidate validation",
        ]);
        expect(postVerifyStep).toHaveBeenCalledWith(packageRoot);
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: installedVersion });
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain(`"version":"${installedVersion}"`);
      });
    },
  );

  it("packs npm GitHub specs before installing into the staged prefix", async () => {
    await withTestDir({ prefix: "openclaw-package-update-npm-pack-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceSpec = "OpenClaw@github:openclaw/openclaw#release/2026.5.12";
      await writePackageRoot(packageRoot, "1.0.0");

      let packDir: string | undefined;
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name === "global update pack") {
          expect(argv).toEqual([
            "npm",
            "pack",
            sourceSpec,
            "--pack-destination",
            expect.any(String),
            "--json",
            "--loglevel=error",
          ]);
          const destination = argv[4];
          if (!destination) {
            throw new Error("missing pack destination");
          }
          packDir = destination;
          await fs.writeFile(path.join(destination, "openclaw-2.0.0.tgz"), "packed\n", "utf8");
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        }
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        const prefixIndex = argv.indexOf("--prefix");
        const stagePrefix = argv[prefixIndex + 1];
        if (!stagePrefix || !packDir) {
          throw new Error("missing staged prefix or pack dir");
        }
        expect(argv).toEqual([
          "npm",
          "i",
          "-g",
          `--allow-scripts=${path.join(packDir, "openclaw-2.0.0.tgz")}`,
          "--prefix",
          stagePrefix,
          path.join(packDir, "openclaw-2.0.0.tgz"),
          "--no-fund",
          "--no-audit",
          "--loglevel=error",
          "--min-release-age=0",
        ]);
        expect(cwd).toBe(packDir);
        await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0");
        await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
        await fs.symlink(
          "../lib/node_modules/openclaw/dist/index.js",
          path.join(stagePrefix, "bin", "openclaw"),
        );
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: sourceSpec,
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update pack",
        "global update",
        "global install swap",
      ]);
      if (!packDir) {
        throw new Error("expected npm pack directory");
      }
      await expectPathMissing(packDir);
    });
  });

  it.each([
    {
      name: "full git url",
      sourceSpec: "https://github.com/openclaw/openclaw.git#main",
    },
    {
      name: "hosted GitHub URL without git suffix",
      sourceSpec: "https://github.com/openclaw/openclaw#main",
    },
    {
      name: "aliased hosted GitHub URL without git suffix",
      sourceSpec: "openclaw@https://github.com/openclaw/openclaw#main",
    },
    {
      name: "GitHub shorthand",
      sourceSpec: "openclaw/openclaw#main",
    },
    {
      name: "SCP-style SSH",
      sourceSpec: "git@github.com:openclaw/openclaw.git#main",
    },
  ] as const)(
    "packs additional npm git source spec forms before install: $name",
    async ({ sourceSpec }) => {
      await withTestDir({ prefix: "openclaw-package-update-npm-pack-variant-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");

        let tarball: string | undefined;
        const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          if (name === "global update pack") {
            const destination = argv[argv.indexOf("--pack-destination") + 1];
            if (!destination) {
              throw new Error("missing pack destination");
            }
            expect(argv.slice(0, 3)).toEqual(["npm", "pack", sourceSpec]);
            tarball = path.join(destination, "openclaw-2.0.0.tgz");
            await fs.writeFile(tarball, "packed\n", "utf8");
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          }
          if (name !== "global update" || !tarball) {
            throw new Error(`unexpected step ${name}`);
          }
          expect(argv).toContain(tarball);
          const stagePrefix = argv[argv.indexOf("--prefix") + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "2.0.0",
          );
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        });

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: sourceSpec,
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.steps.map((step) => step.name)).toEqual([
          "global update pack",
          "global update",
          "global install swap",
        ]);
      });
    },
  );

  it("swaps staged npm package roots through the copy fallback when rename crosses devices", async () => {
    await withTestDir({ prefix: "openclaw-package-update-exdev-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");

      const realRename = fs.rename.bind(fs);
      let stagedPackageRoot: string | undefined;
      let exdevMoves = 0;
      const renameSpy = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
          const [from, to] = args;
          if (
            exdevMoves === 0 &&
            String(from) === stagedPackageRoot &&
            String(to) === packageRoot
          ) {
            exdevMoves += 1;
            throw createFsError("EXDEV", "cross-device link not permitted");
          }
          return await realRename(...args);
        });

      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }) => {
            const prefixIndex = argv.indexOf("--prefix");
            const stagePrefix = argv[prefixIndex + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
            stagedPackageRoot = path.join(stageLayout.globalRoot, "openclaw");
            await writePackageRoot(stagedPackageRoot, "2.0.0");
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          },
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("2.0.0");
        expect(exdevMoves).toBe(1);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2.0.0"');
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  it("stages pnpm-detected updates through npm when the global root has npm prefix layout", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-staged-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const staleChunk = path.join(packageRoot, "dist", "install-C_GuuNz6.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(staleChunk, 'import "./install.runtime-Xom5hOHq.js";\n', "utf8");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv[0]).toBe("npm");
        expect(argv).toContain("i");
        expect(argv).toContain("-g");
        expect(argv).toContain("--prefix");
        expect(argv).toContain("openclaw@2.0.0");
        expect(argv).not.toContain("pnpm");
        const prefixIndex = argv.indexOf("--prefix");
        const stagePrefix = argv[prefixIndex + 1];
        if (!stagePrefix) {
          throw new Error("missing staged prefix");
        }
        await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0");
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createPnpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install swap",
      ]);
      await expectPathMissing(staleChunk);
    });
  });

  it("keeps Windows pnpm global roots on the pnpm update path", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTestDir({ prefix: "openclaw-package-update-win32-pnpm-" }, async (base) => {
        const globalDir = path.join(base, "pnpm", "global");
        const globalRoot = path.join(globalDir, "5", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");

        const runStep = vi.fn(
          async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
            if (name !== "global update") {
              throw new Error(`unexpected step ${name}`);
            }
            expect(argv).toEqual(["pnpm", "add", "-g", "--allow-build=openclaw", "openclaw@2.0.0"]);
            expect(env).toMatchObject({
              pnpm_config_global_dir: globalDir,
              PNPM_CONFIG_GLOBAL_DIR: globalDir,
            });
            await writePackageRoot(packageRoot, "2.0.0");
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          },
        );

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createPnpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("2.0.0");
        expect(result.steps.map((step) => step.name)).toEqual(["global update"]);
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it.each(["delayed", "manual"] as const)(
    "keeps a successful staged swap with %s cleanup after a Windows native module error",
    async (cleanupMode) => {
      await withTestDir({ prefix: "openclaw-package-update-staged-cleanup-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");

        const realRm = fs.rm;
        const realRename = fs.rename;
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (
            cleanupMode === "manual" &&
            path.basename(String(args[1])).startsWith(".openclaw-package-backup-")
          ) {
            throw Object.assign(new Error("backup retirement failed"), { code: "EACCES" });
          }
          return await realRename(...args);
        });
        const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
          const targetPath = String(target);
          if (path.basename(targetPath).startsWith(".openclaw.package-backup-")) {
            throw Object.assign(new Error("EPERM: operation not permitted, unlink native.node"), {
              code: "EPERM",
            });
          }
          return realRm(target, options);
        });

        try {
          const result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep: async ({ name, argv, cwd }) => {
              const prefixIndex = argv.indexOf("--prefix");
              const stagePrefix = argv[prefixIndex + 1];
              if (!stagePrefix) {
                throw new Error("missing staged prefix");
              }
              const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
              await writePackageRoot(path.join(stageLayout.globalRoot, "openclaw"), "2.0.0");
              return {
                name,
                command: argv.join(" "),
                cwd: cwd ?? process.cwd(),
                durationMs: 1,
                exitCode: 0,
              };
            },
            timeoutMs: 1000,
          });

          expect(result.failedStep).toBeNull();
          expect(result.afterVersion).toBe("2.0.0");
          const swapStep = result.steps.find((step) => step.name === "global install swap");
          expect(swapStep?.stdoutTail).toContain("preserved old package");
          expect(swapStep?.stdoutTail).toContain(
            cleanupMode === "manual" ? "remove it manually" : "delayed cleanup",
          );
          const delayedCleanupDirs = (await fs.readdir(globalRoot)).filter((entry) =>
            entry.startsWith(
              cleanupMode === "manual" ? ".openclaw.package-backup-" : ".openclaw-package-backup-",
            ),
          );
          expect(delayedCleanupDirs).toHaveLength(1);
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
        } finally {
          rmSpy.mockRestore();
          renameSpy.mockRestore();
        }
      });
    },
  );

  it("does not run post-verify work when staged npm verification fails", async () => {
    await withTestDir({ prefix: "openclaw-package-update-verify-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const postVerifyStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv, cwd }) => {
          const prefixIndex = argv.indexOf("--prefix");
          const stagePrefix = argv[prefixIndex + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "1.5.0",
          );
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        },
        timeoutMs: 1000,
        postVerifyStep,
      });

      expect(result.failedStep?.name).toBe("global install verify");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install verify",
      ]);
      expect(result.steps.at(-1)?.stderrTail).toContain(
        "expected installed version 2.0.0, found 1.5.0",
      );
      // Staged tree never reached live swap — do not exempt the future-config guard.
      expect(result.verifiedPackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("1.0.0");
      expect(postVerifyStep).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it
    .runIf(process.platform !== "win32")
    .each([
      "regular copy",
      "symlink copy",
      "backup copy",
      "shim restore",
      "mode restore",
      "package restore",
    ] as const)("preserves staged swap rollback safety after %s failure", async (failure) => {
    await withTestDir({ prefix: "openclaw-package-update-shim-rollback-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const targetShim = path.join(prefix, "bin", "openclaw");
      const oldLink = "../lib/node_modules/openclaw/dist/legacy.js";
      const newLink = "../lib/node_modules/openclaw/dist/index.js";
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(path.dirname(targetShim), { recursive: true });
      if (failure === "symlink copy") {
        await fs.writeFile(path.join(packageRoot, "dist", "legacy.js"), "old shim\n");
        await fs.symlink(oldLink, targetShim);
      } else {
        await fs.writeFile(targetShim, "old shim\n", "utf8");
      }

      await fs.chmod(targetShim, 0o755);
      let stagedShimForFailure: string | undefined;
      const realCopyFile = fs.copyFile.bind(fs);
      const realSymlink = fs.symlink.bind(fs);
      const realRename = fs.rename.bind(fs);
      const realChmod = fs.chmod.bind(fs);
      const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (...args) => {
        if (failure === "mode restore" && String(args[0]) === targetShim) {
          throw createFsError("EACCES", "shim mode restoration failed");
        }
        return await realChmod(...args);
      });
      const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        const source = String(args[0]);
        const destination = String(args[1]);
        if (
          (failure === "backup copy" && source === targetShim) ||
          (failure !== "backup copy" && source === stagedShimForFailure) ||
          (failure === "shim restore" &&
            destination === targetShim &&
            path.basename(path.dirname(source)).startsWith(".openclaw.shim-backup-"))
        ) {
          throw createFsError("EACCES", `${failure} failed`);
        }
        return await realCopyFile(...args);
      });
      const symlinkSpy = vi.spyOn(fs, "symlink").mockImplementation(async (...args) => {
        if (failure === "symlink copy" && args[0] === newLink && String(args[1]) === targetShim) {
          throw createFsError("EACCES", "staged symlink creation failed");
        }
        return await realSymlink(...args);
      });
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (
          failure === "package restore" &&
          String(args[1]) === packageRoot &&
          path.basename(String(args[0])).startsWith(".openclaw.package-backup-")
        ) {
          throw createFsError("EACCES", "package restoration failed");
        }
        return await realRename(...args);
      });

      let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
      try {
        result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            const stagedShim = path.join(stagePrefix, "bin", "openclaw");
            stagedShimForFailure = stagedShim;
            await fs.mkdir(path.dirname(stagedShim), { recursive: true });
            if (failure === "symlink copy") {
              await fs.symlink(newLink, stagedShim);
            } else {
              await fs.writeFile(stagedShim, "new shim\n", "utf8");
            }
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          },
          timeoutMs: 1000,
        });
      } finally {
        copyFileSpy.mockRestore();
        symlinkSpy.mockRestore();
        renameSpy.mockRestore();
        chmodSpy.mockRestore();
      }

      expect(result.failedStep?.name).toBe("global install swap");
      if (failure === "package restore") {
        expect(result.afterVersion).toBeNull();
        await expectPathMissing(packageRoot);
      } else {
        expect(result.afterVersion).toBe("1.0.0");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
      }
      if (failure === "shim restore" || failure === "mode restore") {
        if (failure === "shim restore") {
          await expectPathMissing(targetShim);
        }
        const backups = (await fs.readdir(globalRoot)).filter((entry) =>
          entry.startsWith(".openclaw.shim-backup-"),
        );
        expect(backups).toHaveLength(1);
        await expect(
          fs.readFile(path.join(globalRoot, backups[0] ?? "", "openclaw"), "utf8"),
        ).resolves.toBe("old shim\n");
      } else {
        await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old shim\n");
        if (failure === "symlink copy") {
          expect(await fs.readlink(targetShim)).toBe(oldLink);
        }
        expect((await fs.stat(targetShim)).mode & 0o777).toBe(0o755);
      }
      if (
        failure === "shim restore" ||
        failure === "mode restore" ||
        failure === "package restore"
      ) {
        expect(result.recovery?.serviceRestartSafe).toBe(false);
        const backups = (await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."));
        expect(backups.length).toBeGreaterThan(0);
        const retry = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }) => ({
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 0,
            exitCode: 1,
            stderrTail: "retry install failed before activation",
          }),
          timeoutMs: 1000,
        });
        expect(retry.failedStep).not.toBeNull();
        expect(await fs.readdir(globalRoot)).toEqual(expect.arrayContaining(backups));
      }
      // Package and launcher rollback does not reverse possible lifecycle state changes.
      expect(result.recovery?.serviceRestartSafe).toBe(false);
    });
  });

  it("cleans the staged npm prefix when the install command throws", async () => {
    await withTestDir({ prefix: "openclaw-package-update-cleanup-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      let stagePrefix: string | undefined;
      await expect(
        runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ argv }) => {
            const prefixIndex = argv.indexOf("--prefix");
            stagePrefix = argv[prefixIndex + 1];
            throw new Error("install crashed");
          },
          timeoutMs: 1000,
        }),
      ).resolves.toMatchObject({
        failedStep: { stderrTail: "install crashed", exitCode: 1 },
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
      });

      if (stagePrefix === undefined) {
        throw new Error("expected staged install prefix");
      }
      await expectPathMissing(stagePrefix);
    });
  });
});
