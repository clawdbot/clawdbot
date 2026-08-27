// Postinstall Bundled Plugins tests cover postinstall bundled plugins script behavior.
import { spawnSync } from "node:child_process";
import { readFileSync as readFileSyncOriginal } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import {
  collectLegacyPluginRuntimeDepsStateRoots,
  isSourceCheckoutRoot,
  isDirectPostinstallInvocation,
  MAX_INSTALLED_DIST_SCAN_ENTRIES,
  pruneInstalledPackageDist,
  pruneLegacyPluginRuntimeDepsState,
  pruneBundledPluginSourceNodeModules,
  runBundledPluginPostinstall,
  runPluginRegistryPostinstallMigration,
} from "../../scripts/postinstall-bundled-plugins.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDirAsync } = createScriptTestHarness();
async function expectPathExists(filePath: string) {
  await expect(fs.access(filePath)).resolves.toBeUndefined();
}

async function expectPathMissing(filePath: string) {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
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
  it("resolves TypeScript from NODE_PATH during external modules-dir installs", async () => {
    const packageRoot = await createTempDirAsync("openclaw-postinstall-node-path-");
    const scriptRoot = path.join(packageRoot, "scripts");
    const externalModulesDir = path.join(packageRoot, "external-node-modules");
    await fs.mkdir(path.join(scriptRoot, "lib"), { recursive: true });
    await fs.mkdir(externalModulesDir, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"openclaw","type":"module","version":"2026.7.2"}\n',
    );
    for (const relativePath of [
      "scripts/postinstall-bundled-plugins.mjs",
      "scripts/lib/package-dist-imports.mjs",
      "scripts/lib/guard-inventory-utils.mjs",
    ]) {
      await fs.copyFile(
        fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
        path.join(packageRoot, relativePath),
      );
    }
    await fs.symlink(
      fileURLToPath(new URL("../../node_modules/typescript", import.meta.url)),
      path.join(externalModulesDir, "typescript"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(scriptRoot, "postinstall-bundled-plugins.mjs")],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_PATH: [externalModulesDir, process.env.NODE_PATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });

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

  it.each([
    { cacheMode: "disabled", disableCompileCache: "1" },
    { cacheMode: "enabled", disableCompileCache: undefined },
  ])(
    "preserves shared default and configured Node caches during $cacheMode packaged postinstall",
    async ({ disableCompileCache }) => {
      const packageRoot = await createTempDirAsync("openclaw-packaged-compile-cache-");
      const scriptRoot = path.join(packageRoot, "scripts");
      const temporaryRoot = path.join(packageRoot, "temporary");
      const configuredCacheRoot = path.join(packageRoot, "configured-node-cache");
      const defaultCacheRoot = path.join(temporaryRoot, "node-compile-cache");
      const sentinels = [
        path.join(defaultCacheRoot, "v22.22.3-x64-another-app", "keep.txt"),
        path.join(defaultCacheRoot, "v24.15.0-x64-other-install", "keep.txt"),
        path.join(configuredCacheRoot, "v25.9.0-x64-another-app", "keep.txt"),
        path.join(configuredCacheRoot, "v26.4.0-x64-other-install", "keep.txt"),
      ];

      await fs.mkdir(path.join(scriptRoot, "lib"), { recursive: true });
      await fs.mkdir(path.join(packageRoot, "home"), { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        '{"name":"openclaw","type":"module","version":"2026.7.2"}\n',
      );
      await fs.copyFile(
        fileURLToPath(new URL("../../scripts/postinstall-bundled-plugins.mjs", import.meta.url)),
        path.join(scriptRoot, "postinstall-bundled-plugins.mjs"),
      );
      await fs.copyFile(
        fileURLToPath(new URL("../../scripts/lib/package-dist-imports.mjs", import.meta.url)),
        path.join(scriptRoot, "lib", "package-dist-imports.mjs"),
      );
      await fs.copyFile(
        fileURLToPath(new URL("../../scripts/lib/guard-inventory-utils.mjs", import.meta.url)),
        path.join(scriptRoot, "lib", "guard-inventory-utils.mjs"),
      );
      await fs.mkdir(path.join(packageRoot, "node_modules"), { recursive: true });
      await fs.symlink(
        fileURLToPath(new URL("../../node_modules/typescript", import.meta.url)),
        path.join(packageRoot, "node_modules", "typescript"),
        process.platform === "win32" ? "junction" : "dir",
      );
      for (const sentinel of sentinels) {
        await fs.mkdir(path.dirname(sentinel), { recursive: true });
        await fs.writeFile(sentinel, "owned by another Node application\n");
      }

      const result = spawnSync(
        process.execPath,
        [path.join(scriptRoot, "postinstall-bundled-plugins.mjs")],
        {
          cwd: packageRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: path.join(packageRoot, "home"),
            OPENCLAW_CONFIG_PATH: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: undefined,
            OPENCLAW_HOME: path.join(packageRoot, "home"),
            OPENCLAW_STATE_DIR: path.join(packageRoot, "state"),
            STATE_DIRECTORY: undefined,
            NODE_COMPILE_CACHE: configuredCacheRoot,
            NODE_DISABLE_COMPILE_CACHE: disableCompileCache,
            TEMP: temporaryRoot,
            TMP: temporaryRoot,
            TMPDIR: temporaryRoot,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      for (const sentinel of sentinels) {
        await expectPathExists(sentinel);
      }
    },
  );

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

    await expectPathMissing(path.join(extensionsDir, "acpx", "node_modules"));
  });

  it("keeps source-checkout prune non-fatal", async () => {
    const packageRoot = await createTempDirAsync("openclaw-source-checkout-prune-error-");
    const extensionsDir = path.join(packageRoot, "extensions");
    await fs.mkdir(path.join(packageRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(extensionsDir, "acpx"), { recursive: true });
    await fs.writeFile(path.join(extensionsDir, "acpx", "package.json"), "{}\n");
    const warn = vi.fn();

    expect(
      runBundledPluginPostinstall({
        env: { HOME: "/tmp/home" },
        packageRoot,
        rmSync: vi.fn(() => {
          throw new Error("locked");
        }),
        log: { log: vi.fn(), warn },
      }),
    ).toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "[postinstall] could not prune bundled plugin source node_modules: Error: locked",
    );
  });

  it("does not prune user-state legacy runtime deps during source-checkout postinstall", async () => {
    const packageRoot = await createTempDirAsync("openclaw-source-checkout-state-skip-");
    const home = await createTempDirAsync("openclaw-source-checkout-home-");
    const legacyRuntimeRoot = path.join(home, ".openclaw", "plugin-runtime-deps");
    await fs.mkdir(path.join(packageRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(packageRoot, "extensions"), { recursive: true });
    await fs.mkdir(legacyRuntimeRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRuntimeRoot, "package.json"), "{}\n");

    runBundledPluginPostinstall({
      env: { HOME: home },
      packageRoot,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    await expectPathExists(legacyRuntimeRoot);
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

    await expectPathExists(path.join(extensionsDir, "acpx", "node_modules"));
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

    expect(result).toEqual({
      current: {
        plugins: [{ pluginId: "demo" }],
      },
      migrated: true,
      preflight: {
        deprecationWarnings: [],
      },
      status: "migrated",
    });
    expect(migratePluginRegistryForInstall).toHaveBeenCalledWith({
      env: { OPENCLAW_HOME: "/tmp/home" },
      packageRoot,
    });
    expect(log.log).toHaveBeenCalledWith(
      "[postinstall] migrated plugin registry: 1 plugin(s) indexed",
    );
  });

  it("does not migrate operator plugin state from a source checkout", async () => {
    const packageRoot = "/source";
    const existingPaths = new Set([
      path.join(packageRoot, ".git"),
      path.join(packageRoot, "src"),
      path.join(packageRoot, "extensions"),
      path.join(
        packageRoot,
        "dist",
        "commands",
        "doctor",
        "shared",
        "plugin-registry-migration.js",
      ),
    ]);
    const importModule = vi.fn();

    await expect(
      runPluginRegistryPostinstallMigration({
        packageRoot,
        existsSync: vi.fn((filePath: string) => existingPaths.has(filePath)),
        importModule,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "source-checkout",
    });
    expect(importModule).not.toHaveBeenCalled();
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

    await expectPathExists(currentFile);
    await expectPathMissing(staleFile);
  });

  it("omits unpacked plugin-sdk test helpers from the package dist inventory", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-inventory-");
    const runtimeFile = path.join(packageRoot, "dist", "plugin-sdk", "runtime.js");
    const testHelperFile = path.join(packageRoot, "dist", "plugin-sdk", "channel-test-helpers.js");
    const nestedTestHelperFile = path.join(
      packageRoot,
      "dist",
      "plugin-sdk",
      "src",
      "plugin-sdk",
      "test-helpers",
      "provider-contract.d.ts",
    );
    await fs.mkdir(path.dirname(nestedTestHelperFile), { recursive: true });
    await fs.mkdir(path.dirname(runtimeFile), { recursive: true });
    await fs.writeFile(runtimeFile, "export {};\n");
    await fs.writeFile(testHelperFile, "export {};\n");
    await fs.writeFile(nestedTestHelperFile, "export {};\n");

    const inventory = await writePackageDistInventory(packageRoot);

    expect(inventory).toContain("dist/plugin-sdk/runtime.js");
    expect(inventory).not.toContain("dist/plugin-sdk/channel-test-helpers.js");
    expect(inventory).not.toContain(
      "dist/plugin-sdk/src/plugin-sdk/test-helpers/provider-contract.d.ts",
    );
  });

  it("prunes legacy plugin runtime deps state during packaged postinstall", async () => {
    const prefix = await createTempDirAsync("openclaw-packaged-prefix-");
    const packageRoot = path.join(prefix, "lib", "node_modules", "openclaw");
    const nodeModulesRoot = path.dirname(packageRoot);
    const home = await createTempDirAsync("openclaw-packaged-home-");
    const stateOverride = path.join(home, "custom-state");
    const systemState = path.join(home, "system-state");
    const defaultLegacyRoot = path.join(home, ".openclaw", "plugin-runtime-deps");
    const oldBrandLegacyRoot = path.join(home, ".clawdbot", "plugin-runtime-deps");
    const overrideLegacyRoot = path.join(stateOverride, "plugin-runtime-deps");
    const systemLegacyRoot = path.join(systemState, "plugin-runtime-deps");
    const thirdPartyNodeModules = path.join(
      home,
      ".openclaw",
      "extensions",
      "lossless-claw",
      "node_modules",
    );
    const currentFile = path.join(packageRoot, "dist", "entry.js");
    const legacySymlinkTarget = path.join(
      defaultLegacyRoot,
      "openclaw-2026.4.29-slack",
      "node_modules",
      "@slack",
      "web-api",
    );
    const slackScope = path.join(nodeModulesRoot, "@slack");
    const legacySymlink = path.join(slackScope, "web-api");

    await fs.mkdir(path.dirname(currentFile), { recursive: true });
    await fs.writeFile(currentFile, "export {};\n");
    await writePackageDistInventory(packageRoot);
    for (const root of [
      defaultLegacyRoot,
      oldBrandLegacyRoot,
      overrideLegacyRoot,
      systemLegacyRoot,
      thirdPartyNodeModules,
    ]) {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), "{}\n");
    }
    await fs.mkdir(legacySymlinkTarget, { recursive: true });
    await fs.mkdir(slackScope, { recursive: true });
    await fs.symlink(legacySymlinkTarget, legacySymlink, "dir");

    const log = { log: vi.fn(), warn: vi.fn() };
    runBundledPluginPostinstall({
      env: {
        HOME: home,
        OPENCLAW_STATE_DIR: stateOverride,
        STATE_DIRECTORY: systemState,
      },
      packageRoot,
      log,
    });

    await expectPathMissing(defaultLegacyRoot);
    await expectPathMissing(oldBrandLegacyRoot);
    await expectPathMissing(overrideLegacyRoot);
    await expectPathMissing(systemLegacyRoot);
    await expectPathMissing(legacySymlink);
    await expectPathExists(thirdPartyNodeModules);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledWith(
      `[postinstall] pruned legacy plugin runtime deps: ${[
        oldBrandLegacyRoot,
        defaultLegacyRoot,
        overrideLegacyRoot,
        systemLegacyRoot,
      ].join(", ")}`,
    );
  });

  it("prunes global plugin-runtime symlinks before deleting their legacy targets", async () => {
    const prefix = await createTempDirAsync("openclaw-packaged-prefix-");
    const home = await createTempDirAsync("openclaw-packaged-home-");
    const packageRoot = path.join(prefix, "lib", "node_modules", "openclaw");
    const nodeModulesRoot = path.dirname(packageRoot);
    const legacyRuntimeRoot = path.join(home, ".openclaw", "plugin-runtime-deps");
    const legacyTarget = path.join(
      legacyRuntimeRoot,
      "openclaw-2026.4.29-slack",
      "node_modules",
      "@slack",
      "web-api",
    );
    const slackScope = path.join(nodeModulesRoot, "@slack");
    const slackLink = path.join(slackScope, "web-api");

    await fs.mkdir(legacyTarget, { recursive: true });
    await fs.writeFile(path.join(legacyTarget, "package.json"), "{}\n");
    await fs.mkdir(slackScope, { recursive: true });
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.symlink(legacyTarget, slackLink, "dir");

    const log = { log: vi.fn(), warn: vi.fn() };
    pruneLegacyPluginRuntimeDepsState({
      env: { HOME: home },
      packageRoot,
      log,
    });

    await expectPathMissing(slackLink);
    await expectPathMissing(legacyRuntimeRoot);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledWith(
      `[postinstall] pruned legacy plugin runtime deps symlinks: ${slackLink}`,
    );
  });

  it("keeps legacy plugin runtime deps cleanup non-fatal", () => {
    const warn = vi.fn();

    expect(
      pruneLegacyPluginRuntimeDepsState({
        env: { HOME: "/home/alice" },
        existsSync: vi.fn(() => true),
        rmSync: vi.fn(() => {
          throw new Error("locked");
        }),
        log: { log: vi.fn(), warn },
        homedir: () => "/home/alice",
      }),
    ).toStrictEqual([]);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "[postinstall] could not prune legacy plugin runtime deps /home/alice/.clawdbot/plugin-runtime-deps: Error: locked",
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      "[postinstall] could not prune legacy plugin runtime deps /home/alice/.openclaw/plugin-runtime-deps: Error: locked",
    );
  });

  it("resolves legacy plugin runtime deps roots from OpenClaw state env", () => {
    expect(
      collectLegacyPluginRuntimeDepsStateRoots({
        env: {
          HOME: "/users/alice",
          OPENCLAW_HOME: "/srv/openclaw-home",
          OPENCLAW_CONFIG_PATH: "~/profile/openclaw.json",
          OPENCLAW_STATE_DIR: "~/state",
          STATE_DIRECTORY: "/var/lib/openclaw",
        },
        homedir: () => "/users/alice",
      }),
    ).toEqual([
      "/srv/openclaw-home/.clawdbot/plugin-runtime-deps",
      "/srv/openclaw-home/.openclaw/plugin-runtime-deps",
      "/srv/openclaw-home/profile/plugin-runtime-deps",
      "/srv/openclaw-home/state/plugin-runtime-deps",
      "/var/lib/openclaw/plugin-runtime-deps",
    ]);
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

    await expectPathExists(importedChunk);
    await expectPathMissing(staleFile);
  });

  it("keeps named imported chunks without preserving template-literal pseudoimports", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-named-import-");
    const entryFile = path.join(packageRoot, "dist", "cli", "run-main.js");
    const importedChunk = path.join(packageRoot, "dist", "memory-state-current.js");
    const phantomChunk = path.join(packageRoot, "dist", "memory-state-phantom.js");
    await fs.mkdir(path.dirname(entryFile), { recursive: true });
    await fs.writeFile(
      entryFile,
      [
        "import {",
        "  value,",
        '} from "../memory-state-current.js";',
        "const example = `",
        'import "../memory-state-phantom.js"',
        "`;",
        "export { value, example };",
        "",
      ].join("\n"),
    );
    await writePackageDistInventory(packageRoot);
    await fs.writeFile(importedChunk, "export const value = 42;\n");
    await fs.writeFile(phantomChunk, "export const stale = true;\n");

    expect(
      pruneInstalledPackageDist({
        packageRoot,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/memory-state-phantom.js"]);

    await expectPathExists(importedChunk);
    await expectPathMissing(phantomChunk);
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

    expect(
      pruneInstalledPackageDist({
        packageRoot,
        readFileSync,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/stale.js"]);

    await expectPathMissing(staleFile);
  });

  it("prunes stale private QA files without restoring compat sidecars", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-qa-compat-");
    const currentFile = path.join(packageRoot, "dist", "entry.js");
    const currentManifest = path.join(
      packageRoot,
      "dist",
      "extensions",
      "example",
      "openclaw.plugin.json",
    );
    const stalePackage = path.join(packageRoot, "dist", "extensions", "qa-lab", "package.json");
    const staleManifest = path.join(
      packageRoot,
      "dist",
      "extensions",
      "qa-lab",
      "openclaw.plugin.json",
    );
    await fs.mkdir(path.dirname(stalePackage), { recursive: true });
    await fs.mkdir(path.dirname(currentManifest), { recursive: true });
    await fs.writeFile(currentFile, "export {};\n");
    await fs.writeFile(currentManifest, "{}\n");
    await writePackageDistInventory(packageRoot);
    await fs.writeFile(stalePackage, "{}\n");
    await fs.writeFile(staleManifest, "{}\n");

    runBundledPluginPostinstall({
      packageRoot,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    await expectPathExists(currentManifest);
    await expectPathMissing(stalePackage);
    await expectPathMissing(staleManifest);
    await expectPathMissing(
      path.join(packageRoot, "dist", "extensions", "qa-channel", "runtime-api.js"),
    );
    await expectPathMissing(
      path.join(packageRoot, "dist", "extensions", "qa-channel", "package.json"),
    );
    await expectPathMissing(
      path.join(packageRoot, "dist", "extensions", "qa-channel", "openclaw.plugin.json"),
    );
    await expectPathMissing(
      path.join(packageRoot, "dist", "extensions", "qa-lab", "runtime-api.js"),
    );
  });

  it("keeps packaged postinstall non-fatal when the dist inventory is missing", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-missing-inventory-");
    const staleFile = path.join(packageRoot, "dist", "channel-CJUAgRQR.js");
    await fs.mkdir(path.dirname(staleFile), { recursive: true });
    await fs.writeFile(staleFile, "export {};\n");
    const warn = vi.fn();

    expect(
      runBundledPluginPostinstall({
        packageRoot,
        log: { log: vi.fn(), warn },
      }),
    ).toBeUndefined();

    await expectPathExists(staleFile);
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

    expect(
      runBundledPluginPostinstall({
        packageRoot,
        log: { log: vi.fn(), warn },
      }),
    ).toBeUndefined();

    await expectPathExists(currentFile);
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

  it("rejects packaged dist scans that exceed the filesystem entry limit", () => {
    expect(() =>
      pruneInstalledPackageDist({
        packageRoot: "/pkg",
        expectedFiles: new Set(),
        existsSync: vi.fn(() => true),
        lstatSync: vi.fn(() => ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
        })),
        maxDistScanEntries: 1,
        realpathSync: vi.fn((filePath) => filePath),
        readdirSync: vi.fn((filePath, options) => {
          if (filePath === "/pkg/dist" && options?.withFileTypes) {
            return [
              {
                name: "first.js",
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
              },
              {
                name: "second.js",
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
              },
            ];
          }
          return [];
        }),
        rmSync: vi.fn(),
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toThrow(
      "installed dist scan exceeded 1 filesystem entries; refusing to scan unbounded package contents",
    );
    // One budget spans all three prune walks, and npm upgrades scan old+new
    // content-hashed dist files (~24k entries as of 2026.6.x). A cap without
    // several-x headroom fails `npm install -g openclaw` for upgrading users.
    expect(MAX_INSTALLED_DIST_SCAN_ENTRIES).toBeGreaterThanOrEqual(100_000);
  });

  it("uses one packaged dist scan budget across listing and pruning phases", () => {
    expect(() =>
      pruneInstalledPackageDist({
        packageRoot: "/pkg",
        expectedFiles: new Set(["dist/kept.js"]),
        existsSync: vi.fn(() => true),
        lstatSync: vi.fn(() => ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
        })),
        maxDistScanEntries: 1,
        readFileSync: vi.fn(() => "export {};\n"),
        realpathSync: vi.fn((filePath) => filePath),
        readdirSync: vi.fn((filePath, options) => {
          if (filePath === "/pkg/dist" && options?.withFileTypes) {
            return [
              {
                name: "kept.js",
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
              },
            ];
          }
          return [];
        }),
        rmSync: vi.fn(),
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toThrow(
      "installed dist scan exceeded 1 filesystem entries; refusing to scan unbounded package contents",
    );
  });

  it("applies the packaged dist scan budget to legacy dependency debris prepass", () => {
    expect(() =>
      pruneInstalledPackageDist({
        packageRoot: "/pkg",
        expectedFiles: new Set(),
        existsSync: vi.fn(() => true),
        lstatSync: vi.fn(() => ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
        })),
        maxDistScanEntries: 1,
        realpathSync: vi.fn((filePath) => filePath),
        readdirSync: vi.fn((filePath, options) => {
          if (filePath === "/pkg/dist/extensions" && options?.withFileTypes) {
            return [
              {
                name: "slack",
                isDirectory: () => true,
                isFile: () => false,
                isSymbolicLink: () => false,
              },
            ];
          }
          if (filePath === "/pkg/dist/extensions/slack" && options?.withFileTypes) {
            return [
              {
                name: "node_modules",
                isDirectory: () => true,
                isFile: () => false,
                isSymbolicLink: () => false,
              },
            ];
          }
          return [];
        }),
        rmSync: vi.fn(),
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toThrow(
      "installed dist scan exceeded 1 filesystem entries; refusing to scan unbounded package contents",
    );
  });

  it("prunes sibling empty dist directories after closing parent scans", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-empty-dirs-");
    const firstEmptyDir = path.join(packageRoot, "dist", "empty-a");
    const secondEmptyDir = path.join(packageRoot, "dist", "empty-b");
    await fs.mkdir(firstEmptyDir, { recursive: true });
    await fs.mkdir(secondEmptyDir, { recursive: true });

    expect(
      pruneInstalledPackageDist({
        packageRoot,
        expectedFiles: new Set(),
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual([]);

    await expectPathMissing(firstEmptyDir);
    await expectPathMissing(secondEmptyDir);
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
    await expectPathMissing(path.join(packageRoot, "dist", "extensions", "slack", "node_modules"));
    await expectPathMissing(path.dirname(installStageFile));
    await expectPathMissing(path.dirname(retryInstallStageFile));
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

    await expectPathMissing(path.join(extensionsDir, "acpx", "node_modules"));
    await expectPathExists(path.join(extensionsDir, "fixtures", "node_modules"));
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
