import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  detectGlobalInstallManagerForRoot,
  resolveGlobalInstallTarget,
  type CommandRunner,
} from "./update-global.js";

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

describe("custom Bun global installation ownership", () => {
  it("preserves ownership when the original BUN_INSTALL is unavailable", async () => {
    await withTestDir({ prefix: "openclaw-update-custom-bun-root-" }, async (base) => {
      await withEnvAsync(
        { BUN_INSTALL: undefined, BUN_INSTALL_GLOBAL_DIR: undefined },
        async () => {
          const bunRoot = path.join(base, "custom-bun", "install", "global", "node_modules");
          const pkgRoot = path.join(bunRoot, "openclaw");
          const npmRoot = path.join(base, "shell", "lib", "node_modules");
          await fs.mkdir(pkgRoot, { recursive: true });
          const runCommand = vi.fn<CommandRunner>(async () => ({
            stdout: `${npmRoot}\n`,
            stderr: "",
            code: 0,
          }));

          await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
            "bun",
          );
          await expect(
            resolveGlobalInstallTarget({
              manager: "bun",
              runCommand,
              timeoutMs: 1000,
              pkgRoot,
              honorPackageRoot: true,
            }),
          ).resolves.toMatchObject({ manager: "bun", globalRoot: bunRoot, packageRoot: pkgRoot });
        },
      );
    });
  });

  it.each([
    { name: "an explicit caller environment", supplyEnv: true },
    { name: "the ambient process environment", supplyEnv: false },
  ] as const)("pins updates to their original owner with $name", async ({ supplyEnv }) => {
    await withTestDir({ prefix: "openclaw-package-update-bun-owner-" }, async (base) => {
      const bunInstall = path.join(base, "owning-bun");
      const globalProject = path.join(bunInstall, "install", "global");
      const globalRoot = path.join(globalProject, "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const conflictingInstall = path.join(base, "unrelated-bun");
      const conflictingGlobalProject = path.join(base, "unrelated-global");
      const owningBin = path.join(base, "custom-bun-bin");
      await writePackageRoot(packageRoot, "1.0.0");

      await withEnvAsync(
        {
          BUN_INSTALL: conflictingInstall,
          BUN_INSTALL_GLOBAL_DIR: conflictingGlobalProject,
          BUN_INSTALL_BIN: owningBin,
        },
        async () => {
          const callerEnv: NodeJS.ProcessEnv = {
            BUN_INSTALL: conflictingInstall,
            BUN_INSTALL_GLOBAL_DIR: conflictingGlobalProject,
            BUN_INSTALL_BIN: owningBin,
          };
          const originalCallerEnv = { ...callerEnv };
          const runStep = vi.fn(async ({ name, argv, cwd, env }) => {
            expect(argv).toEqual(["bun", "add", "-g", "--trust", "openclaw@2.0.0"]);
            expect(env).toMatchObject({
              BUN_INSTALL: bunInstall,
              BUN_INSTALL_GLOBAL_DIR: globalProject,
              BUN_INSTALL_BIN: owningBin,
            });
            await writePackageRoot(packageRoot, "2.0.0");
            return { name, command: argv.join(" "), cwd: cwd ?? base, durationMs: 1, exitCode: 0 };
          });

          const result = await runGlobalPackageUpdateSteps({
            installTarget: { manager: "bun", command: "bun", globalRoot, packageRoot },
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: vi.fn<CommandRunner>(),
            runStep,
            timeoutMs: 1000,
            ...(supplyEnv ? { env: callerEnv } : {}),
          });

          expect(result.failedStep).toBeNull();
          expect(result.afterVersion).toBe("2.0.0");
          expect(runStep).toHaveBeenCalledOnce();
          expect(callerEnv).toEqual(originalCallerEnv);
          expect(process.env.BUN_INSTALL).toBe(conflictingInstall);
          expect(process.env.BUN_INSTALL_GLOBAL_DIR).toBe(conflictingGlobalProject);
          expect(process.env.BUN_INSTALL_BIN).toBe(owningBin);
        },
      );
    });
  });
});
