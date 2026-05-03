import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { writePackageDistInventory } from "./package-dist-inventory.js";
import {
  runGlobalPackageUpdateSteps,
  type PackageUpdateStepResult,
} from "./package-update-steps.js";
import type { CommandRunner, ResolvedGlobalInstallTarget } from "./update-global.js";

async function writePackageRoot(packageRoot: string, version: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
    "utf8",
  );
  await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
  await writePackageDistInventory(packageRoot);
}

function createNpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "npm",
    command: "npm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
  };
}

function createRootRunner(globalRoot: string): CommandRunner {
  return async (argv) => {
    if (argv.join(" ") === "npm root -g") {
      return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}

describe("runGlobalPackageUpdateSteps", () => {
  it("installs npm updates into a clean staged prefix before swapping the global package", async () => {
    await withTempDir({ prefix: "openclaw-package-update-staged-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(path.join(packageRoot, "dist", "extensions", "qa-channel"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(packageRoot, "dist", "extensions", "qa-channel", "runtime-api.js"),
        "export {};\n",
        "utf8",
      );

      const runStep = vi.fn(
        async ({ name, argv, cwd, timeoutMs }): Promise<PackageUpdateStepResult> => {
          expect(timeoutMs).toBe(1000);
          if (name !== "global update") {
            throw new Error(`unexpected step ${name}`);
          }
          const prefixIndex = argv.indexOf("--prefix");
          expect(prefixIndex).toBeGreaterThan(0);
          const stagePrefix = argv[prefixIndex + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          expect(path.dirname(stagePrefix)).toBe(globalRoot);
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "2.0.0",
          );
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
        },
      );

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.verifiedPackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install swap",
      ]);
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      await expect(
        fs.access(path.join(packageRoot, "dist", "extensions", "qa-channel", "runtime-api.js")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readlink(path.join(prefix, "bin", "openclaw"))).resolves.toBe(
        "../lib/node_modules/openclaw/dist/index.js",
      );
    });
  });

  it("keeps a successful staged swap when old package cleanup hits a transient Windows native module error", async () => {
    await withTempDir({ prefix: "openclaw-package-update-staged-cleanup-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const realRm = fs.rm;
      const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        const targetPath = String(target);
        if (
          targetPath.includes(`${path.sep}.openclaw-`) &&
          !targetPath.includes(".openclaw-update-stage-") &&
          !targetPath.includes(".openclaw-shim-backup-")
        ) {
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
          },
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("2.0.0");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2.0.0"');
      } finally {
        rmSpy.mockRestore();
      }
    });
  });

  it("does not run post-verify work when staged npm verification fails", async () => {
    await withTempDir({ prefix: "openclaw-package-update-verify-" }, async (base) => {
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
      expect(result.verifiedPackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("1.0.0");
      expect(postVerifyStep).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "restores the existing bin shim when staged shim replacement fails",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-shim-rollback-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const targetShim = path.join(prefix, "bin", "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.mkdir(path.dirname(targetShim), { recursive: true });
        await fs.writeFile(targetShim, "old shim\n", "utf8");

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
              "2.0.0",
            );
            const stagedShim = path.join(stagePrefix, "bin", "openclaw");
            await fs.mkdir(path.dirname(stagedShim), { recursive: true });
            await fs.writeFile(stagedShim, "new shim\n", "utf8");
            await fs.chmod(stagedShim, 0);
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

        expect(result.failedStep?.name).toBe("global install swap");
        expect(result.verifiedPackageRoot).toBe(packageRoot);
        expect(result.afterVersion).toBe("1.0.0");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
        await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old shim\n");
      });
    },
  );

  it("cleans the staged npm prefix when the install command throws", async () => {
    await withTempDir({ prefix: "openclaw-package-update-cleanup-" }, async (base) => {
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
      ).rejects.toThrow("install crashed");

      expect(stagePrefix).toBeDefined();
      await expect(fs.access(stagePrefix ?? "")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
