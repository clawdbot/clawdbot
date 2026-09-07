// Postinstall Bundled Plugins tests cover postinstall bundled plugins script behavior.
import { spawnSync } from "node:child_process";
import { readFileSync as readFileSyncOriginal } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import {
  completePackageLifecycle,
  isSourceCheckoutRoot,
  isDirectPostinstallInvocation,
  MAX_INSTALLED_DIST_SCAN_ENTRIES,
  pruneInstalledPackageDist,
  runBundledPluginPostinstall,
} from "../../scripts/postinstall-bundled-plugins.mjs";
import { createSourcePluginDependenciesFixture } from "./source-plugin-dependencies-fixture.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDirAsync } = createScriptTestHarness();
async function expectPathExists(filePath: string) {
  await fs.access(filePath);
}

async function expectPathMissing(filePath: string) {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
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

  it("removes the lifecycle marker only after postinstall completion", () => {
    const rmSync = vi.fn();

    expect(completePackageLifecycle({ packageRoot: "/pkg", rmSync })).toBe(true);
    expect(rmSync).toHaveBeenCalledWith(
      path.join("/pkg", PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
      { force: true },
    );
  });

  it("fails lifecycle completion when its marker cannot be removed", () => {
    const reportError = vi.fn();

    expect(
      completePackageLifecycle(
        {
          packageRoot: "/pkg",
          rmSync: () => {
            throw new Error("read-only package");
          },
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("could not complete package lifecycle: Error: read-only package"),
    );
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
        fileURLToPath(new URL("../../scripts/lib/package-lifecycle-marker.mjs", import.meta.url)),
        path.join(scriptRoot, "lib", "package-lifecycle-marker.mjs"),
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

  it.each(["git checkout", "workspace snapshot"])(
    "preserves importer dependency resolution during %s postinstall",
    async (sourceKind) => {
      const packageRoot = await createTempDirAsync("openclaw-source-resolution-");
      const fixture = await createSourcePluginDependenciesFixture(packageRoot);
      const scriptPath = path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs");
      await fs.mkdir(path.join(packageRoot, "scripts", "lib"), { recursive: true });
      await fs.copyFile(
        fileURLToPath(new URL("../../scripts/postinstall-bundled-plugins.mjs", import.meta.url)),
        scriptPath,
      );
      await fs.copyFile(
        fileURLToPath(new URL("../../scripts/lib/package-lifecycle-marker.mjs", import.meta.url)),
        path.join(packageRoot, "scripts", "lib", "package-lifecycle-marker.mjs"),
      );
      if (sourceKind === "git checkout") {
        await fs.writeFile(path.join(packageRoot, ".git"), "gitdir: /fixture/worktree\n");
        await fs.mkdir(path.join(packageRoot, "dist"));
        await fs.writeFile(path.join(packageRoot, "dist", "postinstall-inventory.json"), "[]\n");
      }
      fixture.assertResolution();
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: path.join(packageRoot, "home"),
          OPENCLAW_HOME: path.join(packageRoot, "home"),
          OPENCLAW_STATE_DIR: path.join(packageRoot, "state"),
          OPENCLAW_CONFIG_PATH: undefined,
          STATE_DIRECTORY: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: undefined,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      fixture.assertResolution();
    },
  );

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

  it("honors the disable env before packaged cleanup", async () => {
    const packageRoot = await createTempDirAsync("openclaw-postinstall-disabled-");
    const staleFile = path.join(packageRoot, "dist", "stale.js");
    await fs.mkdir(path.dirname(staleFile), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "dist", "postinstall-inventory.json"), "[]\n");
    await fs.writeFile(staleFile, "export {};\n");

    runBundledPluginPostinstall({
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1" },
      packageRoot,
    });

    await expectPathExists(staleFile);
  });

  it.each([undefined, "1"])(
    "completes packaged lifecycle without changing operator databases (disabled=%s)",
    async (disabled) => {
      const fixtureRoot = await createTempDirAsync("openclaw-postinstall-state-");
      const packageRoot = path.join(fixtureRoot, "node_modules", "openclaw");
      const home = path.join(fixtureRoot, "home");
      const stateDir = path.join(home, ".openclaw");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const scriptPath = path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs");
      const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
      const migrationPath = path.join(
        packageRoot,
        "dist",
        "commands",
        "doctor",
        "shared",
        "plugin-registry-migration.js",
      );
      await fs.mkdir(path.join(packageRoot, "scripts", "lib"), { recursive: true });
      await fs.mkdir(path.dirname(migrationPath), { recursive: true });
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      await fs.writeFile(path.join(packageRoot, "package.json"), '{"type":"module"}\n');
      await fs.copyFile(
        fileURLToPath(new URL("../../scripts/postinstall-bundled-plugins.mjs", import.meta.url)),
        scriptPath,
      );
      await fs.copyFile(
        fileURLToPath(new URL("../../scripts/lib/package-lifecycle-marker.mjs", import.meta.url)),
        path.join(packageRoot, "scripts", "lib", "package-lifecycle-marker.mjs"),
      );
      const database = new DatabaseSync(databasePath);
      try {
        database.exec("PRAGMA user_version = 5; CREATE TABLE operator_state (value TEXT);");
        database.prepare("INSERT INTO operator_state VALUES (?)").run("preserve me");
      } finally {
        database.close();
      }
      const before = await fs.readFile(databasePath);
      await fs.writeFile(
        migrationPath,
        [
          "import { DatabaseSync } from 'node:sqlite';",
          "import { join } from 'node:path';",
          "export function migratePluginRegistryForInstall({ env }) {",
          "  const db = new DatabaseSync(join(env.OPENCLAW_STATE_DIR, 'state', 'openclaw.sqlite'));",
          "  try { db.exec('PRAGMA user_version = 9; DROP TABLE operator_state;'); }",
          "  finally { db.close(); }",
          "  return { migrated: true, current: { plugins: [] } };",
          "}",
        ].join("\n"),
      );
      await writePackageDistInventory(packageRoot);
      await fs.writeFile(markerPath, "pending\n");
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: undefined,
          STATE_DIRECTORY: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: disabled,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      await expectPathMissing(markerPath);
      expect(await fs.readFile(databasePath)).toEqual(before);
    },
  );

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

  it("prunes from the authoritative inventory without reading dist JavaScript", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-no-js-read-");
    const currentFile = path.join(packageRoot, "dist", "current.js");
    const staleFile = path.join(packageRoot, "dist", "stale.js");
    const inventoryPath = path.join(packageRoot, "dist", "postinstall-inventory.json");
    await fs.mkdir(path.dirname(currentFile), { recursive: true });
    await fs.writeFile(currentFile, "export {};\n");
    await writePackageDistInventory(packageRoot);
    await fs.writeFile(staleFile, "export {};\n");
    const readFileSync = vi.fn((filePath: string | Buffer | URL, options?: BufferEncoding) => {
      if (String(filePath) !== inventoryPath) {
        throw new Error(`unexpected dist JavaScript read: ${String(filePath)}`);
      }
      return readFileSyncOriginal(filePath, { encoding: options });
    });

    expect(
      pruneInstalledPackageDist({
        packageRoot,
        readFileSync,
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/stale.js"]);

    await expectPathExists(currentFile);
    await expectPathMissing(staleFile);
    expect(readFileSync).toHaveBeenCalledOnce();
    expect(readFileSync).toHaveBeenCalledWith(inventoryPath, "utf8");
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

  it("preserves other installs' runtime dependencies and sibling symlinks during packaged postinstall", async () => {
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

    await expectPathExists(defaultLegacyRoot);
    await expectPathExists(oldBrandLegacyRoot);
    await expectPathExists(overrideLegacyRoot);
    await expectPathExists(systemLegacyRoot);
    await expectPathExists(legacySymlink);
    await expectPathExists(thirdPartyNodeModules);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.log).not.toHaveBeenCalled();
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
    if (process.platform !== "win32") {
      expect(
        (await fs.stat(path.join(packageRoot, "dist", "postinstall-inventory.json"))).mode & 0o777,
      ).toBe(0o644);
    }
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
});
