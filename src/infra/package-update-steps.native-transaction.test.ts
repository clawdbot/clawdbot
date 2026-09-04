import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  runGlobalPackageUpdateSteps,
  type PackageUpdateTransaction,
} from "./package-update-steps.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";

describe.runIf(process.platform !== "win32")("native package transactions", () => {
  it.each(["pnpm10", "pnpm11", "bun"] as const)(
    "validates %s in its native project and restores package, sibling, metadata, and launcher",
    async (layout) => {
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
        const phases: string[] = [];
        const result = await runGlobalPackageUpdateSteps({
          installTarget: target,
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          env: { PATH: process.env.PATH, BUN_INSTALL_GLOBAL_DIR: project, BUN_INSTALL_BIN: binDir },
          runCommand: async (argv) => ({
            code: 0,
            stderr: "",
            stdout: argv.includes("root") ? `${globalRoot}\n` : `${binDir}\n`,
          }),
          runStep: async ({ name, argv, cwd, env }) => {
            expect(argv[0]).toBe(manager);
            const stageProject =
              manager === "bun" ? env?.BUN_INSTALL_GLOBAL_DIR : env?.npm_config_global_dir;
            const stageBin =
              manager === "bun" ? env?.BUN_INSTALL_BIN : env?.npm_config_global_bin_dir;
            if (!stageProject || !stageBin) {
              throw new Error("native staging environment missing");
            }
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
            }
            const linkedPackage =
              layout === "pnpm11"
                ? path.join(stageGlobal, "hash-openclaw", "node_modules", "openclaw")
                : candidateRoot;
            await fs.mkdir(stageBin, { recursive: true });
            await fs.symlink(
              path.relative(stageBin, path.join(linkedPackage, "dist", "index.js")),
              path.join(stageBin, "openclaw"),
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
          },
          onTransaction: (transaction) => {
            retained = transaction;
          },
          timeoutMs: 1000,
        });
        expect(result.failedStep).toBeNull();
        expect(phases).toEqual(["validate", "stop"]);
        expect(result.afterVersion).toBe("2.0.0");
        await expect(fs.readFile(metadata, "utf8")).resolves.toBe("candidate metadata\n");
        await expect(fs.readFile(sibling, "utf8")).resolves.toBe("unrelated package\n");
        await expect(fs.realpath(launcher)).resolves.toBe(
          path.join(result.verifiedPackageRoot!, "dist", "index.js"),
        );
        if (!retained) {
          throw new Error("transaction missing");
        }
        expect((await retained.rollback()).exitCode).toBe(0);
        await retained.complete();
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
});
