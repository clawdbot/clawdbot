import { readFileSync as readFileSyncOriginal } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isSourceCheckoutRoot,
  isDirectPostinstallInvocation,
  pruneOpenClawCompileCache,
  pruneInstalledPackageDist,
  pruneBundledPluginSourceNodeModules,
  runBundledPluginPostinstall,
  runPluginRegistryPostinstallMigration,
} from "../../scripts/postinstall-bundled-plugins.mjs";
import { writePackageDistInventory } from "../../src/infra/package-dist-inventory.ts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDirAsync } = createScriptTestHarness();

async function createExtensionsDir() {
  const root = await createTempDirAsync("openclaw-postinstall-");
  const extensionsDir = path.join(root, "dist", "extensions");
  await fs.mkdir(extensionsDir, { recursive: true });
  return extensionsDir;
}

async function writePluginPackage(
  extensionsDir: string,
  pluginId: string,
  packageJson: Record<string, unknown>,
) {
  const pluginDir = path.join(extensionsDir, pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  const packageRoot =
    path.basename(path.dirname(extensionsDir)) === "dist"
      ? path.dirname(path.dirname(extensionsDir))
      : path.dirname(extensionsDir);
  try {
    await writePackageDistInventory(packageRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

describe("bundled plugin postinstall", () => {
  it("recognizes direct invocation through symlinked temp prefixes", () => {
    const realpathSync = vi.fn((value: string) =>
      value.replace(/^\/var\/folders\//u, "/private/var/folders/"),
    );

    expect(
      isDirectPostinstallInvocation({
        entryPath: "/var/folders/tmp/openclaw/scripts/postinstall-bundled-plugins.mjs",
        modulePath: "/private/var/folders/tmp/openclaw/scripts/postinstall-bundled-plugins.mjs",
        realpathSync,
      }),
    ).toBe(true);
  });

  it("prunes Node versioned compile cache dirs during package postinstall", () => {
    const configuredBase = path.join("/tmp", "openclaw-cache");
    const defaultBase = path.join(tmpdir(), "node-compile-cache");
    const removed: string[] = [];
    const existsSync = vi.fn((value: string) => value === configuredBase || value === defaultBase);
    const readdirSync = vi.fn((value: string) => {
      if (value === configuredBase) {
        return [
          { name: "v22.13.1-x64-efe9a9df-1001", isDirectory: () => true },
          { name: "openclaw", isDirectory: () => true },
          { name: "README", isDirectory: () => false },
        ];
      }
      if (value === defaultBase) {
        return [{ name: "v24.14.1-x64-efe9a9df-1001", isDirectory: () => true }];
      }
      throw new Error(`unexpected readdir: ${value}`);
    });
    const rmSync = vi.fn((value: string) => {
      removed.push(value);
    });

    pruneOpenClawCompileCache({
      env: { NODE_COMPILE_CACHE: configuredBase },
      existsSync,
      readdirSync,
      rmSync,
      log: { warn: vi.fn() },
    });

    expect(removed).toEqual([
      path.join(configuredBase, "v22.13.1-x64-efe9a9df-1001"),
      path.join(defaultBase, "v24.14.1-x64-efe9a9df-1001"),
    ]);
    expect(removed).not.toContain(path.join(configuredBase, "openclaw"));
    for (const cacheDir of removed) {
      expect(rmSync).toHaveBeenCalledWith(cacheDir, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 100,
      });
    }
  });

  it("keeps pruning sibling compile cache dirs after one removal fails", () => {
    const configuredBase = path.join("/tmp", "openclaw-cache");
    const attempted: string[] = [];
    const warn = vi.fn();
    const firstCacheDir = path.join(configuredBase, "v22.13.1-x64-efe9a9df-1001");
    const secondCacheDir = path.join(configuredBase, "v22.13.1-x64-efe9a9df-1002");
    const rmSync = vi.fn((value: string) => {
      attempted.push(value);
      if (value === firstCacheDir) {
        throw new Error("locked");
      }
    });

    pruneOpenClawCompileCache({
      env: { NODE_COMPILE_CACHE: configuredBase },
      existsSync: vi.fn((value: string) => value === configuredBase),
      readdirSync: vi.fn(() => [
        { name: path.basename(firstCacheDir), isDirectory: () => true },
        { name: path.basename(secondCacheDir), isDirectory: () => true },
      ]),
      rmSync,
      log: { warn },
    });

    expect(attempted).toEqual([firstCacheDir, secondCacheDir]);
    expect(warn).toHaveBeenCalledWith(
      "[postinstall] could not prune OpenClaw compile cache: Error: locked",
    );
  });

  it("does not classify published packages with source files as source checkouts", () => {
    const packageRoot = "/pkg";
    const existingPaths = new Set([
      path.join(packageRoot, "package.json"),
      path.join(packageRoot, "pnpm-workspace.yaml"),
      path.join(packageRoot, "src"),
      path.join(packageRoot, "extensions"),
      path.join(packageRoot, "dist", "postinstall-inventory.json"),
    ]);

    expect(
      isSourceCheckoutRoot({
        packageRoot,
        existsSync: (value: string) => existingPaths.has(value),
        readFileSync: () =>
          JSON.stringify({
            openclaw: {
              bundle: {
                mirroredRootRuntimeDependencies: ["json5"],
              },
            },
          }),
      }),
    ).toBe(false);
  });

  it("prunes source-checkout bundled plugin node_modules", async () => {
    const packageRoot = await createTempDirAsync("openclaw-source-checkout-");
    const extensionsDir = path.join(packageRoot, "extensions");
    await fs.mkdir(path.join(packageRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });
    await writePluginPackage(extensionsDir, "acpx", {
      dependencies: {
        acpx: "0.5.2",
      },
    });
    await fs.mkdir(path.join(extensionsDir, "acpx", "node_modules", "acpx"), { recursive: true });
    await fs.writeFile(
      path.join(extensionsDir, "acpx", "node_modules", "acpx", "package.json"),
      JSON.stringify({ name: "acpx", version: "0.4.1" }),
    );
    runBundledPluginPostinstall({
      env: { HOME: "/tmp/home" },
      packageRoot,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    await expect(fs.stat(path.join(extensionsDir, "acpx", "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps source-checkout prune non-fatal", async () => {
    const packageRoot = await createTempDirAsync("openclaw-source-checkout-prune-error-");
    const extensionsDir = path.join(packageRoot, "extensions");
    await fs.mkdir(path.join(packageRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(extensionsDir, "acpx"), { recursive: true });
    await fs.writeFile(path.join(extensionsDir, "acpx", "package.json"), "{}\n");
    const warn = vi.fn();

    expect(() =>
      runBundledPluginPostinstall({
        env: { HOME: "/tmp/home" },
        packageRoot,
        rmSync: vi.fn(() => {
          throw new Error("locked");
        }),
        log: { log: vi.fn(), warn },
      }),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      "[postinstall] could not prune bundled plugin source node_modules: Error: locked",
    );
  });

  it("honors disable env before source-checkout pruning", async () => {
    const packageRoot = await createTempDirAsync("openclaw-source-checkout-disabled-");
    const extensionsDir = path.join(packageRoot, "extensions");
    await fs.mkdir(path.join(packageRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(extensionsDir, "acpx", "node_modules"), { recursive: true });
    await fs.writeFile(path.join(extensionsDir, "acpx", "package.json"), "{}\n");

    runBundledPluginPostinstall({
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1" },
      packageRoot,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    await expect(fs.stat(path.join(extensionsDir, "acpx", "node_modules"))).resolves.toBeTruthy();
  });

  it("migrates the plugin registry during postinstall from built dist contracts", async () => {
    const packageRoot = await createTempDirAsync("openclaw-postinstall-registry-");
    const log = { log: vi.fn(), warn: vi.fn() };
    const migratePluginRegistryForInstall = vi.fn(async () => ({
      status: "migrated",
      migrated: true,
      preflight: {
        deprecationWarnings: [],
      },
      current: {
        plugins: [{ pluginId: "demo" }],
      },
    }));
    const importModule = vi.fn(async (specifier: string) => {
      if (specifier.endsWith("/dist/commands/doctor/shared/plugin-registry-migration.js")) {
        return { migratePluginRegistryForInstall };
      }
      throw new Error(`unexpected import: ${specifier}`);
    });

    const result = await runPluginRegistryPostinstallMigration({
      packageRoot,
      existsSync: vi.fn((filePath: string) =>
        filePath.endsWith(
          path.join("dist", "commands", "doctor", "shared", "plugin-registry-migration.js"),
        ),
      ),
      importModule,
      env: { OPENCLAW_HOME: "/tmp/home" },
      log,
    });

    expect(result).toMatchObject({ status: "migrated" });
    expect(migratePluginRegistryForInstall).toHaveBeenCalledWith({
      env: { OPENCLAW_HOME: "/tmp/home" },
      packageRoot,
    });
    expect(log.log).toHaveBeenCalledWith(
      "[postinstall] migrated plugin registry: 1 plugin(s) indexed",
    );
  });

  it("surfaces deprecated plugin registry migration break-glass warnings", async () => {
    const warn = vi.fn();
    const migratePluginRegistryForInstall = vi.fn(async () => ({
      status: "skip-existing",
      migrated: false,
      preflight: {
        deprecationWarnings: ["OPENCLAW_FORCE_PLUGIN_REGISTRY_MIGRATION is deprecated"],
      },
    }));
    const importModule = vi.fn(async () => ({ migratePluginRegistryForInstall }));

    await runPluginRegistryPostinstallMigration({
      packageRoot: "/pkg",
      existsSync: vi.fn(() => true),
      importModule,
      log: { log: vi.fn(), warn },
    });

    expect(warn).toHaveBeenCalledWith(
      "[postinstall] OPENCLAW_FORCE_PLUGIN_REGISTRY_MIGRATION is deprecated",
    );
  });

  it("keeps plugin registry postinstall migration non-fatal when dist entries are unavailable", async () => {
    const warn = vi.fn();

    await expect(
      runPluginRegistryPostinstallMigration({
        packageRoot: "/pkg",
        existsSync: vi.fn(() => false),
        log: { log: vi.fn(), warn },
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "missing-dist-entry",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("honors plugin registry postinstall migration disable env", async () => {
    const importModule = vi.fn(async () => {
      throw new Error("dist migration module should not import when migration is disabled");
    });
    await expect(
      runPluginRegistryPostinstallMigration({
        packageRoot: "/pkg",
        env: { OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION: "1" },
        existsSync: vi.fn(() => true),
        importModule,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).resolves.toMatchObject({
      status: "disabled",
      migrated: false,
      reason: "disabled-env",
    });
    expect(importModule).not.toHaveBeenCalled();
  });

  it("does not disable plugin registry migration for falsey env flag strings", async () => {
    const migratePluginRegistryForInstall = vi.fn(async () => ({
      status: "skip-existing",
      migrated: false,
      preflight: {},
    }));
    const importModule = vi.fn(async () => ({ migratePluginRegistryForInstall }));

    await expect(
      runPluginRegistryPostinstallMigration({
        packageRoot: "/pkg",
        env: { OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION: "0" },
        existsSync: vi.fn(() => true),
        importModule,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).resolves.toMatchObject({
      status: "skip-existing",
      migrated: false,
    });
    expect(importModule).toHaveBeenCalledOnce();
    expect(migratePluginRegistryForInstall).toHaveBeenCalledWith({
      env: { OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION: "0" },
      packageRoot: "/pkg",
    });
  });

  it("prunes stale dist files from packaged installs", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-");
    const currentFile = path.join(packageRoot, "dist", "channel-BOa4MfoC.js");
    const staleFile = path.join(packageRoot, "dist", "channel-CJUAgRQR.js");
    await fs.mkdir(path.dirname(currentFile), { recursive: true });
    await fs.writeFile(currentFile, "export {};\n");
    await writePackageDistInventory(packageRoot);
    await fs.writeFile(staleFile, "export {};\n");

    expect(
      pruneInstalledPackageDist({
        packageRoot,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/channel-CJUAgRQR.js"]);

    await expect(fs.stat(currentFile)).resolves.toBeTruthy();
    await expect(fs.stat(staleFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps imported dist chunks even when inventory is stale", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-import-");
    const entryFile = path.join(packageRoot, "dist", "cli", "run-main.js");
    const importedChunk = path.join(packageRoot, "dist", "memory-state-CcqRgDZU.js");
    const staleFile = path.join(packageRoot, "dist", "memory-state-old.js");
    await fs.mkdir(path.dirname(entryFile), { recursive: true });
    await fs.writeFile(entryFile, 'await import("../memory-state-CcqRgDZU.js");\n');
    await writePackageDistInventory(packageRoot);
    await fs.writeFile(importedChunk, "export {};\n");
    await fs.writeFile(staleFile, "export {};\n");

    expect(
      pruneInstalledPackageDist({
        packageRoot,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/memory-state-old.js"]);

    await expect(fs.stat(importedChunk)).resolves.toBeTruthy();
    await expect(fs.stat(staleFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not abort dist pruning when a listed chunk disappears before import expansion", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-missing-chunk-");
    const entryFile = path.join(packageRoot, "dist", "control-ui", "assets", "instances.js");
    const staleFile = path.join(packageRoot, "dist", "stale.js");
    await fs.mkdir(path.dirname(entryFile), { recursive: true });
    await fs.writeFile(entryFile, 'import "./chunk.js";\n');
    await writePackageDistInventory(packageRoot);
    await fs.writeFile(staleFile, "export {};\n");
    const readFileSync = vi.fn((filePath: string | Buffer | URL, options?: BufferEncoding) => {
      if (String(filePath).endsWith("dist/control-ui/assets/instances.js")) {
        const error = new Error("missing generated asset") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return readFileSyncOriginal(filePath, options);
    });

    expect(() =>
      pruneInstalledPackageDist({
        packageRoot,
        readFileSync,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).not.toThrow();

    await expect(fs.stat(staleFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes stale private QA files without restoring compat sidecars", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-qa-compat-");
    const currentFile = path.join(packageRoot, "dist", "entry.js");
    const stalePackage = path.join(packageRoot, "dist", "extensions", "qa-lab", "package.json");
    const staleManifest = path.join(
      packageRoot,
      "dist",
      "extensions",
      "qa-lab",
      "openclaw.plugin.json",
    );
    await fs.mkdir(path.dirname(stalePackage), { recursive: true });
    await fs.writeFile(currentFile, "export {};\n");
    await writePackageDistInventory(packageRoot);
    await fs.writeFile(stalePackage, "{}\n");
    await fs.writeFile(staleManifest, "{}\n");

    runBundledPluginPostinstall({
      packageRoot,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    await expect(fs.stat(stalePackage)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(staleManifest)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(packageRoot, "dist", "extensions", "qa-channel", "runtime-api.js")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(packageRoot, "dist", "extensions", "qa-channel", "package.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(packageRoot, "dist", "extensions", "qa-channel", "openclaw.plugin.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(packageRoot, "dist", "extensions", "qa-lab", "runtime-api.js")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps packaged postinstall non-fatal when the dist inventory is missing", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-missing-inventory-");
    const staleFile = path.join(packageRoot, "dist", "channel-CJUAgRQR.js");
    await fs.mkdir(path.dirname(staleFile), { recursive: true });
    await fs.writeFile(staleFile, "export {};\n");
    const warn = vi.fn();

    expect(() =>
      runBundledPluginPostinstall({
        packageRoot,
        log: { log: vi.fn(), warn },
      }),
    ).not.toThrow();

    await expect(fs.stat(staleFile)).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      "[postinstall] skipping dist prune: missing dist inventory: dist/postinstall-inventory.json",
    );
  });

  it("keeps packaged postinstall non-fatal when the dist inventory is invalid", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-invalid-inventory-");
    const currentFile = path.join(packageRoot, "dist", "channel-BOa4MfoC.js");
    const inventoryPath = path.join(packageRoot, "dist", "postinstall-inventory.json");
    await fs.mkdir(path.dirname(currentFile), { recursive: true });
    await fs.writeFile(currentFile, "export {};\n");
    await fs.writeFile(inventoryPath, "{not-json}\n");
    const warn = vi.fn();

    expect(() =>
      runBundledPluginPostinstall({
        packageRoot,
        log: { log: vi.fn(), warn },
      }),
    ).not.toThrow();

    await expect(fs.stat(currentFile)).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      "[postinstall] skipping dist prune: invalid dist inventory: dist/postinstall-inventory.json",
    );
  });

  it("rejects symlinked dist roots in packaged installs", () => {
    expect(() =>
      pruneInstalledPackageDist({
        packageRoot: "/pkg",
        expectedFiles: new Set(),
        existsSync: vi.fn(() => true),
        lstatSync: vi.fn((filePath) => ({
          isDirectory: () => filePath === "/pkg/dist",
          isSymbolicLink: () => filePath === "/pkg/dist",
        })),
        realpathSync: vi.fn((filePath) => filePath),
        readdirSync: vi.fn(),
        rmSync: vi.fn(),
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toThrow("unsafe dist root: dist must be a real directory");
  });

  it("rejects symlink entries in packaged dist trees", () => {
    expect(() =>
      pruneInstalledPackageDist({
        packageRoot: "/pkg",
        expectedFiles: new Set(),
        existsSync: vi.fn(() => true),
        lstatSync: vi.fn(() => ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
        })),
        realpathSync: vi.fn((filePath) => filePath),
        readdirSync: vi.fn((filePath) => {
          if (filePath === "/pkg/dist") {
            return [
              {
                name: "escape",
                isDirectory: () => false,
                isFile: () => false,
                isSymbolicLink: () => true,
              },
            ];
          }
          return [];
        }),
        rmSync: vi.fn(),
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toThrow("unsafe dist entry: dist/escape");
  });

  it("prunes stale bundled plugin dependency debris from packaged dist", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-dist-prune-");
    const staleFile = path.join(packageRoot, "dist", "stale-runtime.js");
    const packageJson = path.join(packageRoot, "dist", "extensions", "slack", "package.json");
    const binDir = path.join(packageRoot, "dist", "extensions", "slack", "node_modules", ".bin");
    const dependencyFile = path.join(
      packageRoot,
      "dist",
      "extensions",
      "slack",
      "node_modules",
      "typebox",
      "package.json",
    );
    const installStageFile = path.join(
      packageRoot,
      "dist",
      "extensions",
      "slack",
      ".openclaw-install-stage",
      "node_modules",
      "typebox",
      "build",
      "compile",
      "code.mjs",
    );
    const retryInstallStageFile = path.join(
      packageRoot,
      "dist",
      "extensions",
      "slack",
      ".openclaw-install-stage-retry",
      "node_modules",
      "typebox",
      "build",
      "compile",
      "code.mjs",
    );
    await fs.mkdir(path.dirname(staleFile), { recursive: true });
    await fs.mkdir(path.dirname(packageJson), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.dirname(dependencyFile), { recursive: true });
    await fs.mkdir(path.dirname(installStageFile), { recursive: true });
    await fs.mkdir(path.dirname(retryInstallStageFile), { recursive: true });
    await fs.writeFile(staleFile, "export {};\n");
    await fs.writeFile(packageJson, "{}\n");
    await fs.writeFile(dependencyFile, "{}\n");
    await fs.writeFile(installStageFile, "export {};\n");
    await fs.writeFile(retryInstallStageFile, "export {};\n");
    await fs.symlink("../fxparser/bin.js", path.join(binDir, "fxparser"));

    expect(
      pruneInstalledPackageDist({
        packageRoot,
        expectedFiles: new Set(["dist/extensions/slack/package.json"]),
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/stale-runtime.js"]);
    await expect(
      fs.stat(path.join(packageRoot, "dist", "extensions", "slack", "node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(installStageFile))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.dirname(retryInstallStageFile))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("unlinks stale files instead of recursive pruning them", () => {
    const unlinkSync = vi.fn();

    expect(
      pruneInstalledPackageDist({
        packageRoot: "/pkg",
        expectedFiles: new Set(),
        existsSync: vi.fn(() => true),
        lstatSync: vi.fn(() => ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
        })),
        realpathSync: vi.fn((filePath) => filePath),
        readdirSync: vi.fn((filePath, options) => {
          if (filePath === "/pkg/dist" && options?.withFileTypes) {
            return [
              {
                name: "stale.js",
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
              },
            ];
          }
          return [];
        }),
        unlinkSync,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/stale.js"]);

    expect(unlinkSync).toHaveBeenCalledWith("/pkg/dist/stale.js");
  });

  it("prunes only bundled plugin package node_modules in source checkouts", async () => {
    const packageRoot = await createTempDirAsync("openclaw-source-prune-");
    const extensionsDir = path.join(packageRoot, "extensions");
    await fs.mkdir(path.join(extensionsDir, "acpx", "node_modules"), { recursive: true });
    await fs.mkdir(path.join(extensionsDir, "fixtures", "node_modules"), { recursive: true });
    await fs.writeFile(
      path.join(extensionsDir, "acpx", "package.json"),
      JSON.stringify({ name: "@openclaw/acpx" }),
    );

    pruneBundledPluginSourceNodeModules({ extensionsDir });

    await expect(fs.stat(path.join(extensionsDir, "acpx", "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(extensionsDir, "fixtures", "node_modules")),
    ).resolves.toBeTruthy();
  });

  it("skips symlink entries when pruning source-checkout bundled plugin node_modules", () => {
    const removePath = vi.fn();

    pruneBundledPluginSourceNodeModules({
      extensionsDir: "/repo/extensions",
      existsSync: vi.fn((value) => value === "/repo/extensions"),
      readdirSync: vi.fn(() => [
        {
          name: "acpx",
          isDirectory: () => true,
          isSymbolicLink: () => true,
        },
      ]),
      rmSync: removePath,
    });

    expect(removePath).not.toHaveBeenCalled();
  });
});
