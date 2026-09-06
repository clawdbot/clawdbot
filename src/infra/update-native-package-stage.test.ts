import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import {
  finalizeNativePackageStage,
  prepareNativePackageStage,
} from "./update-native-package-stage.js";

const runFile = promisify(execFile);

async function writeStoredRuntime(packageRoot: string, store: string, generation: string) {
  const payload = path.join(store, generation, "node_modules", "aged-runtime");
  const modules = path.join(packageRoot, "node_modules");
  await fs.mkdir(payload, { recursive: true });
  await fs.mkdir(modules, { recursive: true });
  await fs.writeFile(
    path.join(payload, "index.cjs"),
    `module.exports = ${JSON.stringify(generation)};`,
  );
  await fs.rm(path.join(modules, "aged-runtime"), { force: true });
  await fs.symlink(path.relative(modules, payload), path.join(modules, "aged-runtime"));
  await fs.writeFile(
    path.join(packageRoot, "openclaw.mjs"),
    '#!/usr/bin/env node\nimport value from "./node_modules/aged-runtime/index.cjs";\nconsole.log(value);\n',
    { mode: 0o755 },
  );
}

describe.skipIf(process.platform === "win32")("native package stage", () => {
  it.each(["bun", "pnpm10", "pnpm11"] as const)(
    "preserves the live %s project and executes its relocated candidate launcher",
    async (layout) => {
      await withTestDir({ prefix: "native-package-stage-" }, async (base) => {
        const project = path.join(base, "install", "global");
        const globalRoot = path.join(
          project,
          layout === "pnpm11" ? "v11" : layout === "pnpm10" ? "5/node_modules" : "node_modules",
        );
        const packageRoot = path.join(
          globalRoot,
          ...(layout === "pnpm11" ? ["group", "node_modules"] : []),
          "openclaw",
        );
        const liveBinDir = path.join(base, "bin");
        const external = path.join(base, "shared-store");
        await fs.mkdir(packageRoot, { recursive: true });
        await fs.mkdir(liveBinDir);
        await fs.mkdir(external);
        await fs.writeFile(path.join(external, "dependency"), "shared dependency");
        const virtualStoreDir = path.join(project, layout === "pnpm10" ? "5/.pnpm" : "store");
        if (layout === "pnpm10") {
          const externalStore = path.join(external, "pnpm-store");
          await fs.mkdir(externalStore);
          await fs.symlink(externalStore, virtualStoreDir);
        }
        await fs.writeFile(
          path.join(project, "package.json"),
          JSON.stringify({ dependencies: { sibling: "file:../sibling" } }),
        );
        await writeStoredRuntime(packageRoot, virtualStoreDir, "old");
        await fs.symlink(packageRoot, path.join(project, "owned-package"));
        await fs.symlink(path.relative(project, external), path.join(project, "shared-package"));
        if (layout === "pnpm11") {
          await fs.symlink(
            path.dirname(path.dirname(packageRoot)),
            path.join(globalRoot, "active-hash"),
          );
        }
        const modulesManifest = path.join(packageRoot, ".modules.yaml");
        await fs.writeFile(
          modulesManifest,
          JSON.stringify({ virtualStoreDir, storeDir: external }),
        );
        const installTarget: ResolvedGlobalInstallTarget = {
          manager: layout === "bun" ? "bun" : "pnpm",
          command: layout === "bun" ? "bun" : "pnpm",
          globalRoot,
          packageRoot,
        };
        const stage = await prepareNativePackageStage({
          installTarget,
          packageName: "openclaw",
          installSpec: "openclaw@2.0.0",
          globalBinDir: liveBinDir,
          env: {},
        });
        expect(stage).not.toBeNull();
        if (!stage) {
          throw new Error("missing native stage");
        }
        const candidateRoot = path.join(stage.projectRoot, path.relative(project, packageRoot));
        const candidateEntry = path.join(candidateRoot, "openclaw.mjs");
        const candidateStore = path.join(
          stage.projectRoot,
          path.relative(project, virtualStoreDir),
        );
        expect((await fs.lstat(candidateStore)).isSymbolicLink()).toBe(false);
        expect(await fs.realpath(candidateStore)).toBe(candidateStore);
        expect(
          (await runFile(process.execPath, [candidateEntry], { timeout: 5000 })).stdout.trim(),
        ).toBe("old");
        // An aged pnpm install prunes the old payload before installing its replacement.
        await fs.rm(path.join(candidateStore, "old"), { recursive: true });
        expect(
          (
            await runFile(process.execPath, [path.join(packageRoot, "openclaw.mjs")], {
              timeout: 5000,
            })
          ).stdout.trim(),
        ).toBe("old");
        if (layout === "pnpm10") {
          expect((await fs.lstat(virtualStoreDir)).isSymbolicLink()).toBe(true);
          expect(await fs.realpath(virtualStoreDir)).toBe(path.join(external, "pnpm-store"));
        }
        expect(await fs.realpath(path.join(stage.projectRoot, "owned-package"))).toBe(
          candidateRoot,
        );
        expect(await fs.realpath(path.join(stage.projectRoot, "shared-package"))).toBe(external);
        expect(path.resolve(stage.projectRoot, "../sibling")).toBe(
          path.resolve(project, "../sibling"),
        );
        expect(
          JSON.parse(await fs.readFile(path.join(candidateRoot, ".modules.yaml"), "utf8")),
        ).toEqual({ virtualStoreDir: candidateStore, storeDir: external });
        await writeStoredRuntime(candidateRoot, candidateStore, "candidate");
        const externalEntry = path.join(external, "entry.mjs");
        await fs.writeFile(externalEntry, 'console.log("external");\n');
        const externalLauncher = path.join(stage.binDir, "shared");
        await fs.writeFile(
          externalLauncher,
          `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/${path.relative(stage.binDir, externalEntry)}" "$@"\n`,
          { mode: 0o755 },
        );
        expect((await runFile(externalLauncher, [], { timeout: 5000 })).stdout.trim()).toBe(
          "external",
        );
        const launcher = path.join(stage.binDir, "openclaw");
        if (layout === "bun") {
          await fs.symlink(path.relative(stage.binDir, candidateEntry), launcher);
        } else {
          const target = path.relative(stage.binDir, candidateEntry);
          await fs.writeFile(
            launcher,
            `#!/bin/sh\nbasedir=$(dirname "$0")\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node" "$basedir/${target}" "$@"\nelse\n  exec node "$basedir/${target}" "$@"\nfi\n`,
            { mode: 0o755 },
          );
          const node = process.execPath.replaceAll("'", "'\\''");
          await fs.writeFile(
            path.join(liveBinDir, "node"),
            `#!/bin/sh\nprintf 'bin-runtime\\n'\nexec '${node}' "$@"\n`,
            { mode: 0o755 },
          );
        }
        expect((await runFile(launcher, [], { timeout: 5000 })).stdout.trim()).toBe("candidate");
        await finalizeNativePackageStage(stage, "openclaw");
        expect(
          (
            await runFile(process.execPath, [path.join(packageRoot, "openclaw.mjs")], {
              timeout: 5000,
            })
          ).stdout.trim(),
        ).toBe("old");
        expect(JSON.parse(await fs.readFile(modulesManifest, "utf8"))).toEqual({
          virtualStoreDir,
          storeDir: external,
        });
        await fs.rename(project, `${project}.previous`);
        await fs.rename(stage.projectRoot, project);
        await fs.cp(launcher, path.join(liveBinDir, "openclaw"), { verbatimSymlinks: true });
        await fs.copyFile(externalLauncher, path.join(liveBinDir, "shared"));
        await fs.rm(stage.binDir, { recursive: true });
        expect(
          (await runFile(path.join(liveBinDir, "openclaw"), [], { timeout: 5000 })).stdout.trim(),
        ).toBe(layout === "bun" ? "candidate" : "bin-runtime\ncandidate");
        expect(
          (await runFile(path.join(liveBinDir, "shared"), [], { timeout: 5000 })).stdout.trim(),
        ).toBe("external");
        expect(await fs.realpath(path.join(project, "owned-package"))).toBe(packageRoot);
        expect(await fs.readFile(path.join(project, "shared-package", "dependency"), "utf8")).toBe(
          "shared dependency",
        );
        expect(JSON.parse(await fs.readFile(modulesManifest, "utf8"))).toEqual({
          virtualStoreDir,
          storeDir: external,
        });
      });
    },
  );

  it("rejects a concurrent native owner mutation before finalizing the candidate", async () => {
    await withTestDir({ prefix: "native-package-stage-race-" }, async (base) => {
      const project = path.join(base, "install", "global");
      const globalRoot = path.join(project, "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await fs.mkdir(packageRoot, { recursive: true });
      const manifest = path.join(project, "package.json");
      await fs.writeFile(manifest, '{"dependencies":{"openclaw":"1.0.0"}}');
      const stage = await prepareNativePackageStage({
        installTarget: { manager: "bun", command: "bun", globalRoot, packageRoot },
        packageName: "openclaw",
        installSpec: "openclaw@2.0.0",
        globalBinDir: path.join(base, "bin"),
        env: {},
      });
      if (!stage) {
        throw new Error("missing native stage");
      }
      const concurrentManifest = '{"dependencies":{"openclaw":"1.0.0","sibling":"2.0.0"}}';
      await fs.writeFile(manifest, concurrentManifest);
      await expect(finalizeNativePackageStage(stage, "openclaw")).rejects.toThrow(
        "changed before activation",
      );
      expect(await fs.readFile(manifest, "utf8")).toBe(concurrentManifest);
      expect(await fs.readdir(stage.binDir)).toEqual([]);
    });
  });
});
