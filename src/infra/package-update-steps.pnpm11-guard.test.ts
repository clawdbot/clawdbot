import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import type { CommandRunner, ResolvedGlobalInstallTarget } from "./update-global.js";

type PackageUpdateStepResult = Awaited<
  ReturnType<typeof runGlobalPackageUpdateSteps>
>["steps"][number];

async function writePackageRoot(packageRoot: string, version: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
  ]);
  await writePackageDistInventory(packageRoot);
}

async function writePnpmIsolatedPackage(params: {
  globalRoot: string;
  installName: string;
  version: string;
  dependencies?: Record<string, string>;
}): Promise<{ activeLink: string; packageRoot: string }> {
  const installRoot = path.join(params.globalRoot, params.installName);
  const packageRoot = path.join(installRoot, "node_modules", "openclaw");
  await writePackageRoot(packageRoot, params.version);
  await fs.writeFile(
    path.join(installRoot, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { openclaw: params.version, ...params.dependencies },
    }),
    "utf8",
  );
  const activeLink = path.join(params.globalRoot, `hash-${params.installName}`);
  await fs.symlink(installRoot, activeLink, "dir");
  return { activeLink, packageRoot };
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

describe("pnpm 11 isolated install preflight", () => {
  it("rejects grouped installs before dropping sibling packages", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-group-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      await writePnpmIsolatedPackage({
        globalRoot,
        installName: "grouped",
        version: "1.0.0",
        dependencies: { cowsay: "1.6.0" },
      });
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "invoking",
        version: "1.0.0",
      });
      const runCommand = vi.fn<CommandRunner>();
      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: { layoutVersion: 11 },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain("with cowsay");
      expect(result.failedStep?.stderrTail).toContain("stopped before mutation");
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects multiple standalone installs before an alias-wide update", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-multiple-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      await writePnpmIsolatedPackage({
        globalRoot,
        installName: "other",
        version: "9.0.0",
      });
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "invoking",
        version: "1.0.0",
      });
      const runCommand = vi.fn<CommandRunner>();
      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: { layoutVersion: 11 },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain("found 2");
      expect(result.failedStep?.stderrTail).toContain("stopped before mutation");
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects an orphaned invoking install before manager probes", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-invoking-orphan-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const packageRoot = path.join(globalRoot, "orphan", "node_modules", "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const runCommand = vi.fn<CommandRunner>();
      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: { layoutVersion: 11 },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain("found 0");
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects an orphan whose package symlink shares the active store target", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-shared-store-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const activeInstallRoot = path.join(globalRoot, "active");
      const orphanInstallRoot = path.join(globalRoot, "orphan");
      const activePackageRoot = path.join(activeInstallRoot, "node_modules", "openclaw");
      const orphanPackageRoot = path.join(orphanInstallRoot, "node_modules", "openclaw");
      const sharedPackageRoot = path.join(base, "store", "openclaw");
      await Promise.all([
        fs.mkdir(path.dirname(activePackageRoot), { recursive: true }),
        fs.mkdir(path.dirname(orphanPackageRoot), { recursive: true }),
        writePackageRoot(sharedPackageRoot, "1.0.0"),
      ]);
      await Promise.all([
        fs.writeFile(
          path.join(activeInstallRoot, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
          "utf8",
        ),
        fs.writeFile(
          path.join(orphanInstallRoot, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
          "utf8",
        ),
        fs.symlink(sharedPackageRoot, activePackageRoot, "dir"),
        fs.symlink(sharedPackageRoot, orphanPackageRoot, "dir"),
        fs.symlink(activeInstallRoot, path.join(globalRoot, "hash-active"), "dir"),
      ]);
      const runCommand = vi.fn<CommandRunner>();
      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: { layoutVersion: 11 },
          globalRoot,
          packageRoot: orphanPackageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot: orphanPackageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain(
        "found 1 active installs and 0 owner matches",
      );
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("uses the owner-reported custom bin without changing pnpm command resolution", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-isolated-" }, async (base) => {
      const globalDir = path.join(base, "pnpm-home", "global");
      const globalRoot = path.join(globalDir, "v11");
      const ownerBinDir = path.join(base, "custom-global-bin");
      const pathBinDir = path.join(base, "path-pnpm-home", "bin");
      const callerProjectDir = path.join(base, "caller-project");
      const oldPackageRoot = path.join(globalRoot, "old", "node_modules", "openclaw");
      const newPackageRoot = path.join(globalRoot, "new", "node_modules", "openclaw");
      await fs.mkdir(ownerBinDir, { recursive: true });
      await writePackageRoot(oldPackageRoot, "1.0.0");
      await fs.writeFile(
        path.join(globalRoot, "old", "package.json"),
        JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
        "utf8",
      );
      await fs.symlink(path.join(globalRoot, "old"), path.join(globalRoot, "hash-openclaw"), "dir");

      const pnpmWarning = "[WARN] Using --global skips the package manager check for this project";
      const runCommand: CommandRunner = async (argv, options) => {
        const command = argv.join(" ");
        expect(options.cwd).toBe(globalRoot);
        if (command === "pnpm root -g") {
          return { stdout: `${pnpmWarning}\n${globalRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm bin -g") {
          expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(pathBinDir);
          return { stdout: `${pnpmWarning}\n${ownerBinDir}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm --version") {
          expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(pathBinDir);
          return { stdout: `${pnpmWarning}\n11.4.0\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${command}`);
      };
      const runStep = vi.fn(async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
        if (name === "global update") {
          expect(cwd).toBe(globalRoot);
          expect(env?.PATH?.split(path.delimiter)[0]).toBe(pathBinDir);
          expect(argv).toEqual([
            "pnpm",
            "add",
            "-g",
            "--global-dir",
            globalDir,
            "--global-bin-dir",
            ownerBinDir,
            "--allow-build=openclaw",
            "openclaw@2.0.0",
          ]);
          await fs.rm(path.join(globalRoot, "hash-openclaw"), { force: true });
          await fs.rm(path.join(globalRoot, "old"), { recursive: true, force: true });
          await writePackageRoot(newPackageRoot, "2.0.0");
          await fs.mkdir(path.join(newPackageRoot, "scripts"), { recursive: true });
          await Promise.all([
            fs.writeFile(
              path.join(newPackageRoot, "dist", "openclaw-install-guard"),
              "pending\n",
              "utf8",
            ),
            fs.writeFile(
              path.join(newPackageRoot, "scripts", "preinstall-package-manager-warning.mjs"),
              "export {};\n",
              "utf8",
            ),
            fs.writeFile(
              path.join(newPackageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
              "export {};\n",
              "utf8",
            ),
            fs.writeFile(
              path.join(globalRoot, "new", "package.json"),
              JSON.stringify({ private: true, dependencies: { openclaw: "2.0.0" } }),
              "utf8",
            ),
          ]);
          await fs.symlink(
            path.join(globalRoot, "new"),
            path.join(globalRoot, "hash-openclaw"),
            "dir",
          );
        } else if (name === "pnpm package preinstall") {
          expect(argv).toEqual([
            process.execPath,
            path.join(newPackageRoot, "scripts", "preinstall-package-manager-warning.mjs"),
          ]);
          await expect(
            fs.readFile(path.join(newPackageRoot, ".openclaw-lifecycle-pending"), "utf8"),
          ).resolves.toBe("pending\n");
          await fs.rm(path.join(newPackageRoot, "dist", "openclaw-install-guard"));
        } else if (name === "pnpm package postinstall") {
          expect(argv).toEqual([
            process.execPath,
            path.join(newPackageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
          ]);
          await expect(
            fs.readFile(path.join(newPackageRoot, ".openclaw-lifecycle-pending"), "utf8"),
          ).resolves.toBe("pending\n");
        } else {
          throw new Error(`unexpected step: ${name}`);
        }
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const postVerifyStep = vi.fn(async (packageRoot: string) => {
        expect(packageRoot).toBe(newPackageRoot);
        return null;
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: {
            layoutVersion: 11,
          },
          globalRoot,
          packageRoot: oldPackageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot: oldPackageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
        env: { PATH: `${pathBinDir}${path.delimiter}${ownerBinDir}` },
        installCwd: callerProjectDir,
        postVerifyStep,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.verifiedPackageRoot).toBe(newPackageRoot);
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "pnpm package preinstall",
        "pnpm package postinstall",
      ]);
      await expectPathMissing(path.join(newPackageRoot, ".openclaw-lifecycle-pending"));
      expect(postVerifyStep).toHaveBeenCalledOnce();
    });
  });

  it("accepts a replacement pnpm project that reuses the same shared-store package", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-pnpm-shared-replacement-" },
      async (base) => {
        const globalDir = path.join(base, "pnpm-home", "global");
        const globalRoot = path.join(globalDir, "v11");
        const globalBinDir = path.join(base, "pnpm-home", "bin");
        const oldInstallRoot = path.join(globalRoot, "old");
        const newInstallRoot = path.join(globalRoot, "new");
        const oldPackageRoot = path.join(oldInstallRoot, "node_modules", "openclaw");
        const newPackageRoot = path.join(newInstallRoot, "node_modules", "openclaw");
        const sharedPackageRoot = path.join(base, "store", "openclaw");
        const activeLink = path.join(globalRoot, "hash-openclaw");
        await Promise.all([
          fs.mkdir(path.dirname(oldPackageRoot), { recursive: true }),
          writePackageRoot(sharedPackageRoot, "1.0.0"),
        ]);
        await Promise.all([
          fs.writeFile(
            path.join(oldInstallRoot, "package.json"),
            JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
            "utf8",
          ),
          fs.symlink(sharedPackageRoot, oldPackageRoot, "dir"),
          fs.symlink(oldInstallRoot, activeLink, "dir"),
        ]);
        const runCommand: CommandRunner = async (argv, options) => {
          expect(options.cwd).toBe(globalRoot);
          const command = argv.join(" ");
          if (command === "pnpm root -g") {
            return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
          }
          if (command === "pnpm bin -g") {
            return { stdout: `${globalBinDir}\n`, stderr: "", code: 0 };
          }
          if (command === "pnpm --version") {
            return { stdout: "11.4.0\n", stderr: "", code: 0 };
          }
          throw new Error(`unexpected command: ${command}`);
        };
        const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          expect(name).toBe("global update");
          expect(cwd).toBe(globalRoot);
          await fs.rm(activeLink);
          await fs.mkdir(path.dirname(newPackageRoot), { recursive: true });
          await Promise.all([
            fs.writeFile(
              path.join(newInstallRoot, "package.json"),
              JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
              "utf8",
            ),
            fs.symlink(sharedPackageRoot, newPackageRoot, "dir"),
            fs.symlink(newInstallRoot, activeLink, "dir"),
          ]);
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
            manager: "pnpm",
            command: "pnpm",
            pnpmIsolated: { layoutVersion: 11 },
            globalRoot,
            packageRoot: oldPackageRoot,
          },
          installSpec: "openclaw@1.0.0",
          packageName: "openclaw",
          packageRoot: oldPackageRoot,
          runCommand,
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("1.0.0");
        expect(result.verifiedPackageRoot).toBe(newPackageRoot);
        expect(runStep).toHaveBeenCalledOnce();
      },
    );
  });

  it("preserves pnpm local specs before mutating from the owner root", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-relative-spec-" }, async (base) => {
      const globalDir = path.join(base, "pnpm-home", "global");
      const globalRoot = path.join(globalDir, "v11");
      const globalBinDir = path.join(base, "pnpm-home", "bin");
      const callerProjectDir = path.join(base, "caller-project");
      const candidateTarball = path.join(callerProjectDir, "candidate.tgz");
      const candidateTar = path.join(callerProjectDir, "candidate.tar");
      const cases: Array<{
        installSpec: string;
        expectedInstallSpec: string;
        installCwd?: string;
      }> = [
        {
          installSpec: "file:./candidate.tgz",
          expectedInstallSpec: `file:${candidateTarball}`,
        },
        {
          installSpec: "openclaw@link:./candidate",
          expectedInstallSpec: `openclaw@link:${path.join(callerProjectDir, "candidate")}`,
        },
        {
          installSpec: "git+file:./candidate#main",
          expectedInstallSpec: "git+file:///C:/caller/candidate#main",
          installCwd: "C:\\caller",
        },
        { installSpec: "./candidate.tar", expectedInstallSpec: candidateTar },
        {
          installSpec: "openclaw@file:./candidate.tar",
          expectedInstallSpec: `openclaw@file:${candidateTar}`,
        },
        { installSpec: "candidate.tar", expectedInstallSpec: "candidate.tar" },
        { installSpec: "openclaw@candidate.tar", expectedInstallSpec: "openclaw@candidate.tar" },
        { installSpec: "file:~/candidate.tgz", expectedInstallSpec: "file:~/candidate.tgz" },
        { installSpec: "~/candidate.tgz", expectedInstallSpec: "~/candidate.tgz" },
      ];
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "install",
        version: "1.0.0",
      });
      await fs.mkdir(callerProjectDir, { recursive: true });
      await fs.writeFile(candidateTarball, "fixture", "utf8");
      await fs.writeFile(candidateTar, "fixture", "utf8");
      const runCommand: CommandRunner = async (argv, options) => {
        expect(options.cwd).toBe(globalRoot);
        const command = argv.join(" ");
        if (command === "pnpm root -g") {
          return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm bin -g") {
          return { stdout: `${globalBinDir}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm --version") {
          return { stdout: "11.4.0\n", stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${command}`);
      };
      let expectedInstallSpec = "";
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        expect(name).toBe("global update");
        expect(cwd).toBe(globalRoot);
        expect(argv).toEqual([
          "pnpm",
          "add",
          "-g",
          "--global-dir",
          globalDir,
          "--global-bin-dir",
          globalBinDir,
          "--allow-build=openclaw",
          expectedInstallSpec,
        ]);
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 1,
          stderrTail: "fixture stop",
        };
      });

      for (const testCase of cases) {
        expectedInstallSpec = testCase.expectedInstallSpec;
        const result = await runGlobalPackageUpdateSteps({
          installTarget: {
            manager: "pnpm",
            command: "pnpm",
            pnpmIsolated: { layoutVersion: 11 },
            globalRoot,
            packageRoot,
          },
          installSpec: testCase.installSpec,
          packageName: "openclaw",
          packageRoot,
          runCommand,
          runStep,
          timeoutMs: 1000,
          installCwd: testCase.installCwd ?? callerProjectDir,
        });
        expect(result.failedStep?.name).toBe("global update");
      }
      expect(runStep).toHaveBeenCalledTimes(cases.length);
    });
  });

  it("probes pnpm from its owner root before rejecting a mismatched major", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-major-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const globalBinDir = path.join(base, "pnpm-home", "bin");
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "install",
        version: "1.0.0",
      });
      const runStep = vi.fn();
      const runCommand: CommandRunner = async (argv, options) => {
        const command = argv.join(" ");
        expect(options.cwd).toBe(globalRoot);
        expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(globalBinDir);
        if (command === "pnpm root -g") {
          return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm bin -g") {
          return { stdout: `${globalBinDir}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm --version") {
          return { stdout: "10.32.1\n", stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${command}`);
      };

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: {
            layoutVersion: 11,
          },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
        env: { PATH: `${globalBinDir}${path.delimiter}${path.join(base, "pnpm-10", "bin")}` },
      });

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain("reports pnpm 10.32.1");
      expect(runStep).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it("rejects a pnpm command that owns another global root", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-root-" }, async (base) => {
      const globalRoot = path.join(base, "owner", "global", "v11");
      const otherGlobalRoot = path.join(base, "other", "global", "v11");
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "install",
        version: "1.0.0",
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        expect(argv).toEqual(["pnpm", "root", "-g"]);
        return { stdout: `${otherGlobalRoot}\n`, stderr: "", code: 0 };
      });
      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: { layoutVersion: 11 },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain("owns");
      expect(result.failedStep?.stderrTail).toContain("not the invoking OpenClaw install");
      expect(runCommand).toHaveBeenCalledOnce();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects a pnpm update that leaves only an orphaned old package root", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-orphan-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const globalBinDir = path.join(base, "pnpm-home", "bin");
      const { activeLink, packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "old",
        version: "1.0.0",
      });
      const runCommand: CommandRunner = async (argv) => {
        const command = argv.join(" ");
        if (command === "pnpm root -g") {
          return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm bin -g") {
          return { stdout: `${globalBinDir}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm --version") {
          return { stdout: "11.4.0\n", stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${command}`);
      };
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        expect(name).toBe("global update");
        await fs.rm(activeLink);
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
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: {
            layoutVersion: 11,
          },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("global install verify");
      expect(result.failedStep?.stderrTail).toContain("unique active pnpm replacement");
      expect(runStep).toHaveBeenCalledOnce();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it("retries interrupted pnpm package lifecycle repair", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-lifecycle-" }, async (base) => {
      const globalRoot = path.join(base, "global");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      let firstAttempt = true;

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name === "global update" && firstAttempt) {
          await writePackageRoot(packageRoot, "2.0.0");
          await fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true });
          await Promise.all([
            fs.writeFile(
              path.join(packageRoot, "dist", "openclaw-install-guard"),
              "pending\n",
              "utf8",
            ),
            fs.writeFile(
              path.join(packageRoot, "scripts", "preinstall-package-manager-warning.mjs"),
              "export {};\n",
              "utf8",
            ),
            fs.writeFile(
              path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
              "export {};\n",
              "utf8",
            ),
          ]);
        } else if (name === "pnpm package preinstall") {
          await fs.rm(path.join(packageRoot, "dist", "openclaw-install-guard"));
        }
        const exitCode = name === "pnpm package postinstall" && firstAttempt ? 1 : 0;
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode,
        };
      });
      const updateParams = {
        installTarget: createPnpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: async (argv: string[]) => {
          if (argv.join(" ") === "pnpm root -g") {
            return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
          }
          throw new Error(`unexpected command: ${argv.join(" ")}`);
        },
        runStep,
        timeoutMs: 1000,
      };

      const failed = await runGlobalPackageUpdateSteps(updateParams);
      expect(failed.failedStep?.name).toBe("pnpm package postinstall");
      await expect(
        fs.readFile(path.join(packageRoot, ".openclaw-lifecycle-pending"), "utf8"),
      ).resolves.toBe("pending\n");

      firstAttempt = false;
      runStep.mockClear();
      const recovered = await runGlobalPackageUpdateSteps(updateParams);
      expect(recovered.failedStep).toBeNull();
      expect(recovered.afterVersion).toBe("2.0.0");
      expect(runStep.mock.calls.map(([call]) => call.name)).toEqual([
        "global update",
        "pnpm package postinstall",
      ]);
      await expectPathMissing(path.join(packageRoot, ".openclaw-lifecycle-pending"));
    });
  });
});
