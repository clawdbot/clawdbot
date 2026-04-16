import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createNestedNpmInstallEnv,
  pruneInstalledPackageDist,
  discoverBundledPluginRuntimeDeps,
  pruneBundledPluginSourceNodeModules,
  restoreLegacyUpdaterCompatSidecars,
  runBundledPluginPostinstall,
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
  function createNpmInstallArgs(...packages: string[]) {
    return [
      "install",
      "--omit=dev",
      "--no-save",
      "--package-lock=false",
      "--legacy-peer-deps",
      ...packages,
    ];
  }

  function createBareNpmRunner(packages: string[]) {
    return {
      command: "npm",
      args: createNpmInstallArgs(...packages),
      env: {
        HOME: "/tmp/home",
        PATH: "/tmp/node/bin",
      },
      shell: false as const,
    };
  }

  function expectNpmInstallSpawn(
    spawnSync: ReturnType<typeof vi.fn>,
    packageRoot: string,
    packages: string[],
  ) {
    expect(spawnSync).toHaveBeenCalledWith("npm", createNpmInstallArgs(...packages), {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        HOME: "/tmp/home",
        PATH: "/tmp/node/bin",
      },
      shell: false,
      stdio: "pipe",
      windowsVerbatimArguments: undefined,
    });
  }

  it("clears global npm config before nested installs", () => {
    expect(
      createNestedNpmInstallEnv({
        npm_config_global: "true",
        npm_config_location: "global",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      }),
    ).toEqual({
      HOME: "/tmp/home",
    });
  });

  it("installs bundled plugin deps outside of source checkouts", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "acpx", {
      dependencies: {
        acpx: "0.4.1",
      },
    });
    const spawnSync = vi.fn();

    runBundledPluginPostinstall({
      env: { HOME: "/tmp/home" },
      extensionsDir,
      packageRoot,
      npmRunner: createBareNpmRunner(["acpx@0.4.1"]),
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(spawnSync).toHaveBeenCalled();
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
    const spawnSync = vi.fn();

    runBundledPluginPostinstall({
      env: { HOME: "/tmp/home" },
      packageRoot,
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    await expect(fs.stat(path.join(extensionsDir, "acpx", "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(spawnSync).not.toHaveBeenCalled();
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

  it("restores only postinstall-generated QA lab compat sidecar after pruning old installs", async () => {
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
      spawnSync: vi.fn(),
      log: { log: vi.fn(), warn: vi.fn() },
    });

    await expect(fs.stat(stalePackage)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(staleManifest)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(packageRoot, "dist", "extensions", "qa-lab", "runtime-api.js"), "utf8"),
    ).resolves.toContain("QA Lab is not packaged");
  });

  it("creates only an empty QA lab compat sidecar for fresh installs", async () => {
    const packageRoot = await createTempDirAsync("openclaw-packaged-install-no-qa-compat-");
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "dist", "entry.js"), "export {};\n");
    await writePackageDistInventory(packageRoot);

    expect(
      restoreLegacyUpdaterCompatSidecars({
        packageRoot,
        removedFiles: ["dist/entry-old.js"],
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).toEqual(["dist/extensions/qa-lab/runtime-api.js"]);

    await expect(
      fs.readFile(path.join(packageRoot, "dist", "extensions", "qa-lab", "runtime-api.js"), "utf8"),
    ).resolves.toBe(
      "// Compatibility stub for older OpenClaw updaters. QA Lab is not packaged.\nexport {};\n",
    );
    await expect(
      fs.stat(path.join(packageRoot, "dist", "extensions", "qa-lab", "package.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(packageRoot, "dist", "extensions", "qa-lab", "openclaw.plugin.json")),
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

  it("runs nested local installs with sanitized env when the sentinel package is missing", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "acpx", {
      dependencies: {
        acpx: "0.4.1",
      },
    });
    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    runBundledPluginPostinstall({
      env: {
        npm_config_global: "true",
        npm_config_location: "global",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      },
      extensionsDir,
      packageRoot,
      npmRunner: createBareNpmRunner(["acpx@0.4.1"]),
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expectNpmInstallSpawn(spawnSync, packageRoot, ["acpx@0.4.1"]);
  });

  it("skips reinstall when the bundled sentinel package already exists", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "acpx", {
      dependencies: {
        acpx: "0.4.1",
      },
    });
    await fs.mkdir(path.join(packageRoot, "node_modules", "acpx"), { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "node_modules", "acpx", "package.json"),
      "{}\n",
      "utf8",
    );
    const spawnSync = vi.fn();

    runBundledPluginPostinstall({
      env: { npm_config_global: "true" },
      extensionsDir,
      packageRoot,
      spawnSync,
    });

    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("reinstalls bundled runtime deps when optional native children are missing", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "discord", {
      dependencies: {
        "@snazzah/davey": "0.1.11",
      },
    });
    await fs.mkdir(path.join(packageRoot, "node_modules", "@snazzah", "davey"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(packageRoot, "node_modules", "@snazzah", "davey", "package.json"),
      JSON.stringify({
        optionalDependencies: {
          "@snazzah/davey-win32-arm64-msvc": "0.1.11",
        },
      }),
    );
    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    runBundledPluginPostinstall({
      env: { HOME: "/tmp/home" },
      extensionsDir,
      packageRoot,
      arch: "arm64",
      npmRunner: createBareNpmRunner(["@snazzah/davey@0.1.11"]),
      platform: "win32",
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expectNpmInstallSpawn(spawnSync, packageRoot, ["@snazzah/davey@0.1.11"]);
  });

  it("does not reinstall when only another platform optional native child is missing", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "discord", {
      dependencies: {
        "@snazzah/davey": "0.1.11",
      },
    });
    await fs.mkdir(path.join(packageRoot, "node_modules", "@snazzah", "davey"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(packageRoot, "node_modules", "@snazzah", "davey", "package.json"),
      JSON.stringify({
        optionalDependencies: {
          "@snazzah/davey-win32-arm64-msvc": "0.1.11",
        },
      }),
    );
    const spawnSync = vi.fn();

    runBundledPluginPostinstall({
      env: { HOME: "/tmp/home" },
      extensionsDir,
      packageRoot,
      arch: "arm64",
      platform: "darwin",
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("discovers bundled plugin runtime deps from extension manifests", async () => {
    const extensionsDir = await createExtensionsDir();
    await writePluginPackage(extensionsDir, "slack", {
      dependencies: {
        "@slack/web-api": "7.11.0",
      },
    });
    await writePluginPackage(extensionsDir, "amazon-bedrock", {
      dependencies: {
        "@aws-sdk/client-bedrock": "3.1020.0",
      },
    });

    expect(discoverBundledPluginRuntimeDeps({ extensionsDir })).toEqual(
      expect.arrayContaining([
        {
          name: "@slack/web-api",
          pluginIds: ["slack"],
          sentinelPath: path.join("node_modules", "@slack", "web-api", "package.json"),
          version: "7.11.0",
        },
        {
          name: "@aws-sdk/client-bedrock",
          pluginIds: ["amazon-bedrock"],
          sentinelPath: path.join("node_modules", "@aws-sdk", "client-bedrock", "package.json"),
          version: "3.1020.0",
        },
      ]),
    );
  });

  it("merges duplicate bundled runtime deps across plugins", async () => {
    const extensionsDir = await createExtensionsDir();
    await writePluginPackage(extensionsDir, "slack", {
      dependencies: {
        "https-proxy-agent": "^8.0.0",
      },
    });
    await writePluginPackage(extensionsDir, "feishu", {
      dependencies: {
        "https-proxy-agent": "^8.0.0",
      },
    });

    expect(discoverBundledPluginRuntimeDeps({ extensionsDir })).toEqual(
      expect.arrayContaining([
        {
          name: "https-proxy-agent",
          pluginIds: ["feishu", "slack"],
          sentinelPath: path.join("node_modules", "https-proxy-agent", "package.json"),
          version: "^8.0.0",
        },
      ]),
    );
  });

  it("installs missing bundled plugin runtime deps during global installs", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "slack", {
      dependencies: {
        "@slack/web-api": "7.11.0",
      },
    });
    await writePluginPackage(extensionsDir, "telegram", {
      dependencies: {
        grammy: "1.38.4",
      },
    });
    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    runBundledPluginPostinstall({
      env: {
        npm_config_global: "true",
        npm_config_location: "global",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      },
      extensionsDir,
      packageRoot,
      npmRunner: createBareNpmRunner(["@slack/web-api@7.11.0", "grammy@1.38.4"]),
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expectNpmInstallSpawn(spawnSync, packageRoot, ["@slack/web-api@7.11.0", "grammy@1.38.4"]);
  });

  it("installs only missing bundled plugin runtime deps", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "slack", {
      dependencies: {
        "@slack/web-api": "7.11.0",
      },
    });
    await writePluginPackage(extensionsDir, "telegram", {
      dependencies: {
        grammy: "1.38.4",
      },
    });
    await fs.mkdir(path.join(packageRoot, "node_modules", "@slack", "web-api"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(packageRoot, "node_modules", "@slack", "web-api", "package.json"),
      "{}\n",
    );
    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    runBundledPluginPostinstall({
      env: {
        HOME: "/tmp/home",
      },
      extensionsDir,
      packageRoot,
      npmRunner: createBareNpmRunner(["grammy@1.38.4"]),
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expectNpmInstallSpawn(spawnSync, packageRoot, ["grammy@1.38.4"]);
  });

  it("installs bundled plugin deps when npm location is global", async () => {
    const extensionsDir = await createExtensionsDir();
    const packageRoot = path.dirname(path.dirname(extensionsDir));
    await writePluginPackage(extensionsDir, "telegram", {
      dependencies: {
        grammy: "1.38.4",
      },
    });
    const spawnSync = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    runBundledPluginPostinstall({
      env: {
        npm_config_location: "global",
        npm_config_prefix: "/opt/homebrew",
        HOME: "/tmp/home",
      },
      extensionsDir,
      packageRoot,
      npmRunner: createBareNpmRunner(["grammy@1.38.4"]),
      spawnSync,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expectNpmInstallSpawn(spawnSync, packageRoot, ["grammy@1.38.4"]);
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
