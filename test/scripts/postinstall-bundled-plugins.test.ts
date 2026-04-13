import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createNestedNpmInstallEnv,
  discoverBundledPluginRuntimeDeps,
  pruneBundledPluginSourceNodeModules,
  runBundledPluginPostinstall,
} from "../../scripts/postinstall-bundled-plugins.mjs";
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
