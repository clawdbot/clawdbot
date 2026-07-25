import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  detectGlobalInstallManagerForRoot,
  listActivePnpmIsolatedGlobalPackages,
  resolveGlobalInstallTarget,
  resolvePnpmGlobalDirFromGlobalRoot,
  type CommandRunner,
} from "./update-global.js";

async function writeGlobalPackageJson(packageRoot: string, version: string): Promise<void> {
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
    "utf8",
  );
}

async function writePnpmIsolatedPackage(params: {
  globalRoot: string;
  installName: string;
  version: string;
  dependencies?: Record<string, string>;
}): Promise<string> {
  const installDir = path.join(params.globalRoot, params.installName);
  const packageRoot = path.join(installDir, "node_modules", "openclaw");
  await fs.mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeGlobalPackageJson(packageRoot, params.version),
    fs.writeFile(
      path.join(installDir, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { openclaw: params.version, ...params.dependencies },
      }),
      "utf8",
    ),
  ]);
  await fs.symlink(installDir, path.join(params.globalRoot, `hash-${params.installName}`), "dir");
  return packageRoot;
}

describe("pnpm 11 global install discovery", () => {
  it("detects isolated global installs from the active project link", async () => {
    await withTempDir({ prefix: "openclaw-update-pnpm-isolated-root-" }, async (base) => {
      const npmRoot = path.join(base, "npm", "lib", "node_modules");
      const pnpmGlobalDir = path.join(base, "pnpm-home", "global");
      const pnpmGlobalRoot = path.join(pnpmGlobalDir, "v11");
      const pkgRoot = await writePnpmIsolatedPackage({
        globalRoot: pnpmGlobalRoot,
        installName: "a1b2",
        version: "2026.7.1",
      });
      const hashLinkedPkgRoot = path.join(pnpmGlobalRoot, "hash-a1b2", "node_modules", "openclaw");
      const pnpmHomeAlias = path.join(base, "pnpm-home-alias");
      await fs.symlink(path.join(base, "pnpm-home"), pnpmHomeAlias, "dir");
      const aliasedPkgRoot = path.join(
        pnpmHomeAlias,
        "global",
        "v11",
        "a1b2",
        "node_modules",
        "openclaw",
      );
      await fs.mkdir(path.join(npmRoot, "openclaw"), { recursive: true });

      const runCommand: CommandRunner = async (argv) => {
        const command = argv.join(" ");
        if (command === "npm root -g") {
          return { stdout: `${npmRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm root -g") {
          return {
            stdout: `[WARN] Using --global skips the package manager check for this project\n${pnpmGlobalRoot}\n`,
            stderr: "",
            code: 0,
          };
        }
        throw new Error(`unexpected command: ${command}`);
      };

      await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
        "pnpm",
      );
      await expect(
        detectGlobalInstallManagerForRoot(runCommand, hashLinkedPkgRoot, 1000),
      ).resolves.toBe("pnpm");
      await expect(
        detectGlobalInstallManagerForRoot(runCommand, aliasedPkgRoot, 1000),
      ).resolves.toBe("pnpm");
      await expect(
        resolveGlobalInstallTarget({
          manager: "pnpm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot,
          honorPackageRoot: true,
        }),
      ).resolves.toEqual({
        manager: "pnpm",
        command: "pnpm",
        pnpmIsolated: { layoutVersion: 11 },
        globalRoot: pnpmGlobalRoot,
        packageRoot: pkgRoot,
      });
      expect(resolvePnpmGlobalDirFromGlobalRoot(pnpmGlobalRoot)).toBe(pnpmGlobalDir);
    });
  });

  it("prefers the invoking project when multiple installs are active", async () => {
    await withTempDir({ prefix: "openclaw-update-pnpm-isolated-owner-" }, async (base) => {
      const pnpmGlobalRoot = path.join(base, "pnpm-home", "global", "v11");
      const otherPackageRoot = await writePnpmIsolatedPackage({
        globalRoot: pnpmGlobalRoot,
        installName: "a-other",
        version: "2026.7.1",
      });
      const invokingPackageRoot = await writePnpmIsolatedPackage({
        globalRoot: pnpmGlobalRoot,
        installName: "z-invoking",
        version: "2026.7.2",
        dependencies: { cowsay: "1.6.0" },
      });
      const runCommand: CommandRunner = async (argv) => {
        if (argv.join(" ") === "pnpm root -g") {
          return { stdout: `${pnpmGlobalRoot}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(
        listActivePnpmIsolatedGlobalPackages({
          globalRoot: pnpmGlobalRoot,
          packageName: "openclaw",
        }),
      ).resolves.toEqual([
        { packageRoot: otherPackageRoot, packageNames: ["openclaw"] },
        { packageRoot: invokingPackageRoot, packageNames: ["cowsay", "openclaw"] },
      ]);
      await expect(
        resolveGlobalInstallTarget({
          manager: "pnpm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot: invokingPackageRoot,
          packageName: "openclaw",
        }),
      ).resolves.toEqual({
        manager: "pnpm",
        command: "pnpm",
        pnpmIsolated: { layoutVersion: 11 },
        globalRoot: pnpmGlobalRoot,
        packageRoot: invokingPackageRoot,
      });
    });
  });

  it("does not adopt another pnpm project through a shared-store package symlink", async () => {
    await withTempDir({ prefix: "openclaw-update-pnpm-shared-store-owner-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const activeInstallRoot = path.join(globalRoot, "active");
      const orphanInstallRoot = path.join(globalRoot, "orphan");
      const activePackageRoot = path.join(activeInstallRoot, "node_modules", "openclaw");
      const orphanPackageRoot = path.join(orphanInstallRoot, "node_modules", "openclaw");
      const sharedPackageRoot = path.join(base, "store", "openclaw");
      await Promise.all([
        fs.mkdir(path.dirname(activePackageRoot), { recursive: true }),
        fs.mkdir(path.dirname(orphanPackageRoot), { recursive: true }),
        fs.mkdir(sharedPackageRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeGlobalPackageJson(sharedPackageRoot, "2026.7.1"),
        fs.writeFile(
          path.join(activeInstallRoot, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "2026.7.1" } }),
          "utf8",
        ),
        fs.writeFile(
          path.join(orphanInstallRoot, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "2026.7.1" } }),
          "utf8",
        ),
        fs.writeFile(path.join(orphanInstallRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
      ]);
      await Promise.all([
        fs.symlink(sharedPackageRoot, activePackageRoot, "dir"),
        fs.symlink(sharedPackageRoot, orphanPackageRoot, "dir"),
        fs.symlink(activeInstallRoot, path.join(globalRoot, "hash-active"), "dir"),
      ]);
      const runCommand: CommandRunner = async (argv) => {
        if (argv.join(" ") === "pnpm root -g") {
          return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(
        resolveGlobalInstallTarget({
          manager: "pnpm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot: orphanPackageRoot,
          packageName: "openclaw",
        }),
      ).resolves.toEqual({
        manager: "pnpm",
        command: "pnpm",
        pnpmIsolated: { layoutVersion: 11 },
        globalRoot,
        packageRoot: orphanPackageRoot,
      });
    });
  });

  it("preserves pnpm 11 ownership when the invoking project is orphaned", async () => {
    await withTempDir({ prefix: "openclaw-update-pnpm-isolated-orphan-" }, async (base) => {
      const pnpmGlobalRoot = path.join(base, "pnpm-home", "global", "v11");
      const orphanPackageRoot = path.join(pnpmGlobalRoot, "orphan", "node_modules", "openclaw");
      await fs.mkdir(orphanPackageRoot, { recursive: true });
      const orphanInstallRoot = path.join(pnpmGlobalRoot, "orphan");
      await Promise.all([
        writeGlobalPackageJson(orphanPackageRoot, "2026.7.1"),
        fs.writeFile(
          path.join(orphanInstallRoot, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "2026.7.1" } }),
          "utf8",
        ),
        fs.writeFile(path.join(orphanInstallRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
      ]);
      const detectRunner = vi.fn<CommandRunner>().mockResolvedValue({
        stdout: "",
        stderr: "not active",
        code: 1,
      });

      await expect(
        detectGlobalInstallManagerForRoot(detectRunner, orphanPackageRoot, 1000),
      ).resolves.toBe("pnpm");
      expect(detectRunner).toHaveBeenCalledTimes(2);

      const runCommand: CommandRunner = async (argv) => {
        if (argv.join(" ") === "pnpm root -g") {
          return {
            stdout: `${path.join(base, "other-pnpm-home", "global", "v11")}\n`,
            stderr: "",
            code: 0,
          };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };
      await expect(
        resolveGlobalInstallTarget({
          manager: "npm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot: orphanPackageRoot,
          packageName: "openclaw",
        }),
      ).resolves.toEqual({
        manager: "pnpm",
        command: "pnpm",
        pnpmIsolated: { layoutVersion: 11 },
        globalRoot: pnpmGlobalRoot,
        packageRoot: orphanPackageRoot,
      });
    });
  });

  it("keeps npm ownership when its prefix is named like a pnpm layout", async () => {
    await withTempDir({ prefix: "openclaw-update-npm-v11-prefix-" }, async (base) => {
      const npmPrefix = path.join(base, "v11");
      const npmGlobalRoot = path.join(npmPrefix, "lib", "node_modules");
      const packageRoot = path.join(npmGlobalRoot, "openclaw");
      await fs.mkdir(packageRoot, { recursive: true });
      await writeGlobalPackageJson(packageRoot, "2026.7.1");
      const runCommand: CommandRunner = async (argv) => {
        const command = argv.join(" ");
        if (command === "npm root -g") {
          return { stdout: `${npmGlobalRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm root -g") {
          return {
            stdout: `${path.join(base, "pnpm-home", "global", "v11")}\n`,
            stderr: "",
            code: 0,
          };
        }
        throw new Error(`unexpected command: ${command}`);
      };

      await expect(detectGlobalInstallManagerForRoot(runCommand, packageRoot, 1000)).resolves.toBe(
        "npm",
      );
      await expect(
        resolveGlobalInstallTarget({
          manager: "npm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot: packageRoot,
          packageName: "openclaw",
          honorPackageRoot: true,
        }),
      ).resolves.toEqual({
        manager: "npm",
        command: "npm",
        globalRoot: npmGlobalRoot,
        packageRoot,
      });
    });
  });

  it("does not infer pnpm ownership without pnpm node_modules metadata", async () => {
    await withTempDir({ prefix: "openclaw-update-pnpm-shape-only-" }, async (base) => {
      const customGlobalDir = path.join(base, "custom-pnpm");
      const customGlobalRoot = path.join(customGlobalDir, "5", "node_modules");
      const pkgRoot = path.join(customGlobalRoot, "openclaw");
      const defaultPnpmRoot = path.join(base, "default-pnpm", "5", "node_modules");
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.writeFile(
        path.join(customGlobalDir, "5", "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n",
        "utf8",
      );

      const runCommand: CommandRunner = async (argv) => {
        if (argv[0] === "npm") {
          return { stdout: "", stderr: "", code: 1 };
        }
        if (argv[0] === "pnpm") {
          return { stdout: `${defaultPnpmRoot}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(
        detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000),
      ).resolves.toBeNull();
      await expect(
        resolveGlobalInstallTarget({
          manager: "pnpm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot,
        }),
      ).resolves.toEqual({
        manager: "pnpm",
        command: "pnpm",
        globalRoot: defaultPnpmRoot,
        packageRoot: path.join(defaultPnpmRoot, "openclaw"),
      });
    });
  });
});
