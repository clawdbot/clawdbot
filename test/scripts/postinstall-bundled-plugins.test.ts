import { existsSync as existsSyncOriginal, readFileSync as readFileSyncOriginal } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyBaileysEncryptedStreamFinishHotfix,
  collectLegacyPluginRuntimeDepsStateRoots,
  isSourceCheckoutRoot,
  isDirectPostinstallInvocation,
  pruneOpenClawCompileCache,
  pruneInstalledPackageDist,
  pruneLegacyPluginRuntimeDepsState,
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

async function writeBaileysMediaFile(packageRoot: string, text: string) {
  const mediaFile = path.join(
    packageRoot,
    "node_modules",
    "@whiskeysockets",
    "baileys",
    "lib",
    "Utils",
    "messages-media.js",
  );
  await fs.mkdir(path.dirname(mediaFile), { recursive: true });
  await fs.writeFile(mediaFile, text);
  return mediaFile;
}

describe("bundled plugin postinstall", () => {
  function existsSyncWithoutGlobalCompileCache(value: string) {
    if (path.resolve(value) === path.join(tmpdir(), "node-compile-cache")) {
      return false;
    }
    return existsSyncOriginal(value);
  }

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

  it("does not warn when compile-cache pruning hits EACCES or EPERM (shared caches)", () => {
    const base = path.join("/tmp", "openclaw-shared-compile-cache");
    const dirA = path.join(base, "v22.13.1-x64-efe9a9df-1001");
    const dirB = path.join(base, "v22.13.1-x64-efe9a9df-1002");
    const warn = vi.fn();
    const rmSync = vi.fn((value: string) => {
      if (value === dirA) {
        throw Object.assign(new Error(`permission denied pruning ${value}`), { code: "EACCES" });
      }
      if (value === dirB) {
        throw Object.assign(new Error(`operation not permitted pruning ${value}`), {
          code: "EPERM",
        });
      }
    });

    pruneOpenClawCompileCache({
      env: { NODE_COMPILE_CACHE: base },
      existsSync: vi.fn((value: string) => value === base),
      readdirSync: vi.fn(() => [
        { name: path.basename(dirA), isDirectory: () => true },
        { name: path.basename(dirB), isDirectory: () => true },
      ]),
      rmSync,
      log: { warn },
    });

    expect(rmSync).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when the compile-cache base directory cannot be listed (EACCES)", () => {
    const base = path.join("/tmp", "openclaw-compile-cache-no-list");
    const warn = vi.fn();
    const rmSync = vi.fn();
    const err = Object.assign(new Error(`EACCES: ${base}`), { code: "EACCES" });

    pruneOpenClawCompileCache({
      env: { NODE_COMPILE_CACHE: base },
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn(() => {
        throw err;
      }),
      rmSync,
      log: { warn },
    });

    expect(rmSync).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("patches the Baileys rc10 upload helper dispatcher guard", async () => {
    const packageRoot = await createTempDirAsync("openclaw-baileys-postinstall-");
    const mediaFile = await writeBaileysMediaFile(
      packageRoot,
      [
        "import { once } from 'events';",
        "const encryptedStream = async () => {",
        "        encFileWriteStream.write(mac);",
        "        const encFinishPromise = once(encFileWriteStream, 'finish');",
        "        const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve();",
        "        encFileWriteStream.end();",
        "        originalFileStream?.end?.();",
        "        stream.destroy();",
        "        await encFinishPromise;",
        "        await originalFinishPromise;",
        "        logger?.debug('encrypted data successfully');",
        "};",
        "const uploadWithFetch = async ({ url, filePath, headers, timeoutMs, agent }) => {",
        "    const nodeStream = createReadStream(filePath);",
        "    const webStream = Readable.toWeb(nodeStream);",
        "    const response = await fetch(url, {",
        "        dispatcher: agent,",
        "        method: 'POST',",
        "        body: webStream,",
        "        headers,",
        "        duplex: 'half',",
        "        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined",
        "    });",
        "};",
        "",
      ].join("\n"),
    );

    expect(applyBaileysEncryptedStreamFinishHotfix({ packageRoot })).toMatchObject({
      applied: true,
      reason: "patched",
    });
    const patchedText = await fs.readFile(mediaFile, "utf8");
    expect(patchedText).toContain(
      "...(typeof agent?.dispatch === 'function' ? { dispatcher: agent } : {}),",
    );
    expect(patchedText).not.toContain("        dispatcher: agent,");
  });

  it("recognizes already patched Baileys rc10 upload helpers", async () => {
    const packageRoot = await createTempDirAsync("openclaw-baileys-postinstall-");
    await writeBaileysMediaFile(
      packageRoot,
      [
        "import { once } from 'events';",
        "const encryptedStream = async () => {",
        "        encFileWriteStream.write(mac);",
        "        const encFinishPromise = once(encFileWriteStream, 'finish');",
        "        const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve();",
        "        encFileWriteStream.end();",
        "        originalFileStream?.end?.();",
        "        stream.destroy();",
        "        await encFinishPromise;",
        "        await originalFinishPromise;",
        "        logger?.debug('encrypted data successfully');",
        "};",
        "const uploadWithFetch = async ({ url, filePath, headers, timeoutMs, agent }) => {",
        "    const response = await fetch(url, {",
        "        ...(typeof agent?.dispatch === 'function' ? { dispatcher: agent } : {}),",
        "        method: 'POST',",
        "    });",
        "};",
        "",
      ].join("\n"),
    );

    expect(applyBaileysEncryptedStreamFinishHotfix({ packageRoot })).toMatchObject({
      applied: false,
      reason: "already_patched",
    });
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
    ).resolves.toEqual({
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
    ).resolves.toEqual({
      status: "skip-existing",
      migrated: false,
      preflight: {},
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

    await expectPathExists(currentFile);
    await expectPathMissing(staleFile);
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
      existsSync: existsSyncWithoutGlobalCompileCache,
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
      expect.stringContaining("[postinstall] pruned legacy plugin runtime deps:"),
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
      expect.stringContaining("[postinstall] pruned legacy plugin runtime deps symlinks:"),
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

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[postinstall] could not prune legacy plugin runtime deps /home/alice/.openclaw/plugin-runtime-deps: Error: locked",
      ),
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
