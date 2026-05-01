import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
  buildPluginSnapshotReport,
  enablePluginInConfig,
  installHooksFromNpmSpec,
  installHooksFromPath,
  installPluginFromClawHub,
  installPluginFromGitSpec,
  installPluginFromMarketplace,
  installPluginFromNpmSpec,
  installPluginFromPath,
  loadConfig,
  loadPluginManifestRegistry,
  readConfigFileSnapshot,
  parseClawHubPluginSpec,
  recordHookInstall,
  recordPluginInstall,
  resetPluginsCliTestState,
  replaceConfigFile,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  writeConfigFile,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./plugins-cli-test-helpers.js";

const CLI_STATE_ROOT = "/tmp/openclaw-state";
const ORIGINAL_OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const PROFILE_STATE_ROOT = "/tmp/openclaw-ledger-profile";

function cliInstallPath(pluginId: string): string {
  return installedPluginRoot(CLI_STATE_ROOT, pluginId);
}

function useProfileExtensionsDir(): string {
  process.env.OPENCLAW_STATE_DIR = PROFILE_STATE_ROOT;
  return path.join(PROFILE_STATE_ROOT, "extensions");
}

function createEnabledPluginConfig(pluginId: string): OpenClawConfig {
  return {
    plugins: {
      entries: {
        [pluginId]: {
          enabled: true,
        },
      },
    },
  } as OpenClawConfig;
}

function createEmptyPluginConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {},
    },
  } as OpenClawConfig;
}

function createClawHubInstallResult(params: {
  pluginId: string;
  packageName: string;
  version: string;
  channel: string;
}): Awaited<ReturnType<typeof installPluginFromClawHub>> {
  return {
    ok: true,
    pluginId: params.pluginId,
    targetDir: cliInstallPath(params.pluginId),
    version: params.version,
    packageName: params.packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: params.packageName,
      clawhubFamily: "code-plugin",
      clawhubChannel: params.channel,
      version: params.version,
      integrity: "sha256-abc",
      resolvedAt: "2026-03-22T00:00:00.000Z",
    },
  };
}

function createNpmPluginInstallResult(
  pluginId = "demo",
): Awaited<ReturnType<typeof installPluginFromNpmSpec>> {
  return {
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version: "1.2.3",
    npmResolution: {
      packageName: pluginId,
      resolvedVersion: "1.2.3",
      tarballUrl: `https://registry.npmjs.org/${pluginId}/-/${pluginId}-1.2.3.tgz`,
    },
  };
}

function createGitPluginInstallResult(
  pluginId = "demo",
): Awaited<ReturnType<typeof installPluginFromGitSpec>> {
  return {
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version: "1.2.3",
    extensions: ["index.js"],
    git: {
      url: "https://github.com/acme/demo.git",
      ref: "v1.2.3",
      commit: "abc123",
      resolvedAt: "2026-04-30T00:00:00.000Z",
    },
  };
}

function mockClawHubPackageNotFound(packageName: string) {
  installPluginFromClawHub.mockResolvedValue({
    ok: false,
    error: `ClawHub /api/v1/packages/${packageName} failed (404): Package not found`,
    code: "package_not_found",
  });
}

function primeNpmPluginFallback(pluginId = "demo") {
  const cfg = createEmptyPluginConfig();
  const enabledCfg = createEnabledPluginConfig(pluginId);

  loadConfig.mockReturnValue(cfg);
  mockClawHubPackageNotFound(pluginId);
  installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult(pluginId));
  enablePluginInConfig.mockReturnValue({ config: enabledCfg });
  recordPluginInstall.mockReturnValue(enabledCfg);
  applyExclusiveSlotSelection.mockReturnValue({
    config: enabledCfg,
    warnings: [],
  });

  return { cfg, enabledCfg };
}

function createPathHookPackInstalledConfig(tmpRoot: string): OpenClawConfig {
  return {
    hooks: {
      internal: {
        installs: {
          "demo-hooks": {
            source: "path",
            sourcePath: tmpRoot,
            installPath: tmpRoot,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createNpmHookPackInstalledConfig(): OpenClawConfig {
  return {
    hooks: {
      internal: {
        installs: {
          "demo-hooks": {
            source: "npm",
            spec: "@acme/demo-hooks@1.2.3",
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createHookPackInstallResult(targetDir: string): {
  ok: true;
  hookPackId: string;
  hooks: string[];
  targetDir: string;
  version: string;
} {
  return {
    ok: true,
    hookPackId: "demo-hooks",
    hooks: ["command-audit"],
    targetDir,
    version: "1.2.3",
  };
}

function primeHookPackNpmFallback() {
  const cfg = {} as OpenClawConfig;
  const installedCfg = createNpmHookPackInstalledConfig();

  loadConfig.mockReturnValue(cfg);
  mockClawHubPackageNotFound("@acme/demo-hooks");
  installPluginFromNpmSpec.mockResolvedValue({
    ok: false,
    error: "package.json missing openclaw.plugin.json",
  });
  installHooksFromNpmSpec.mockResolvedValue({
    ...createHookPackInstallResult("/tmp/hooks/demo-hooks"),
    npmResolution: {
      name: "@acme/demo-hooks",
      spec: "@acme/demo-hooks@1.2.3",
      integrity: "sha256-demo",
    },
  });
  recordHookInstall.mockReturnValue(installedCfg);

  return { cfg, installedCfg };
}

function primeBlockedNpmPluginInstall(params: {
  spec: string;
  pluginId: string;
  code?: "security_scan_blocked" | "security_scan_failed";
}) {
  loadConfig.mockReturnValue({} as OpenClawConfig);
  mockClawHubPackageNotFound(params.spec);
  installPluginFromNpmSpec.mockResolvedValue({
    ok: false,
    error: `Plugin "${params.pluginId}" installation blocked: dangerous code patterns detected: finding details`,
    code: params.code ?? "security_scan_blocked",
  });
}

function primeHookPackPathFallback(params: {
  tmpRoot: string;
  pluginInstallError: string;
}): OpenClawConfig {
  const installedCfg = createPathHookPackInstalledConfig(params.tmpRoot);

  loadConfig.mockReturnValue({} as OpenClawConfig);
  installPluginFromPath.mockResolvedValueOnce({
    ok: false,
    error: params.pluginInstallError,
  });
  installHooksFromPath.mockResolvedValueOnce(createHookPackInstallResult(params.tmpRoot));
  recordHookInstall.mockReturnValue(installedCfg);

  return installedCfg;
}

describe("plugins cli install", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  afterEach(() => {
    if (ORIGINAL_OPENCLAW_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_OPENCLAW_STATE_DIR;
    }
  });

  it("shows the force overwrite option in install help", async () => {
    const { Command } = await import("commander");
    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    registerPluginsCli(program);

    const pluginsCommand = program.commands.find((command) => command.name() === "plugins");
    const installCommand = pluginsCommand?.commands.find((command) => command.name() === "install");
    const helpText = installCommand?.helpInformation() ?? "";

    expect(helpText).toContain("--force");
    expect(helpText).toContain("Overwrite an existing installed plugin or");
    expect(helpText).toContain("hook pack");
  });

  it("exits when --marketplace is combined with --link", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--link"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("`--link` is not supported with `--marketplace`.");
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
  });

  it("exits when --force is combined with --link", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "./plugin", "--link", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("`--force` is not supported with `--link`.");
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("exits when marketplace install fails", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
      }),
    );
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("passes the active profile extensions dir to marketplace installs", async () => {
    const extensionsDir = useProfileExtensionsDir();

    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionsDir,
        marketplace: "local/repo",
        plugin: "alpha",
      }),
    );
  });

  it("fails closed for unrelated invalid config before installer side effects", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfig.mockImplementation(() => {
      throw invalidConfigErr;
    });
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw-config.json5",
      exists: true,
      raw: '{ "models": { "default": 123 } }',
      parsed: { models: { default: 123 } },
      resolved: { models: { default: 123 } },
      valid: false,
      config: { models: { default: 123 } },
      hash: "mock",
      issues: [{ path: "models.default", message: "invalid model ref" }],
      warnings: [],
      legacyIssues: [],
    });

    await expect(runPluginsCommand(["plugins", "install", "alpha"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("installs marketplace plugins and persists plugin index", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = {
      plugins: {
        entries: {
          alpha: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    installPluginFromMarketplace.mockResolvedValue({
      ok: true,
      pluginId: "alpha",
      targetDir: cliInstallPath("alpha"),
      extensions: ["index.js"],
      version: "1.2.3",
      marketplaceName: "Claude",
      marketplaceSource: "local/repo",
      marketplacePlugin: "alpha",
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", kind: "provider" }],
      diagnostics: [],
    });
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "alpha", kind: "memory" }],
      diagnostics: [],
    });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: ["slot adjusted"],
    });

    await runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]);

    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      alpha: expect.objectContaining({
        source: "marketplace",
        installPath: cliInstallPath("alpha"),
      }),
    });
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
    expect(replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        baseHash: "mock",
        nextConfig: enabledCfg,
      }),
    );
    expect(runtimeLogs.some((line) => line.includes("slot adjusted"))).toBe(true);
    expect(runtimeLogs.some((line) => line.includes("Installed plugin: alpha"))).toBe(true);
  });

  it("passes force through as overwrite mode for marketplace installs", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
        mode: "update",
      }),
    );
  });

  it("installs ClawHub plugins and persists source metadata", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    loadConfig.mockReturnValue(cfg);
    parseClawHubPluginSpec.mockReturnValue({ name: "demo" });
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "official",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "clawhub:demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      demo: expect.objectContaining({
        source: "clawhub",
        spec: "clawhub:demo",
        installPath: cliInstallPath("demo"),
        version: "1.2.3",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      }),
    });
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
    expect(runtimeLogs.some((line) => line.includes("Installed plugin: demo"))).toBe(true);
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("passes the active profile extensions dir to ClawHub installs", async () => {
    const extensionsDir = useProfileExtensionsDir();
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    parseClawHubPluginSpec.mockReturnValue({ name: "demo" });
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "official",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "clawhub:demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionsDir,
        spec: "clawhub:demo",
      }),
    );
  });

  it("does not persist incomplete config entries for config-gated bundled installs", async () => {
    const cfg = {
      plugins: {
        entries: {
          "memory-lancedb": {
            config: {},
          },
        },
        load: {
          paths: ["/existing/plugin"],
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);

    await runPluginsCommand(["plugins", "install", "memory-lancedb"]);

    const writtenConfig = writeConfigFile.mock.calls.at(-1)?.[0] as OpenClawConfig;
    expect(writtenConfig.plugins?.entries?.["memory-lancedb"]).toBeUndefined();
    expect(writtenConfig.plugins?.load?.paths).toEqual(["/existing/plugin"]);
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      "memory-lancedb": expect.objectContaining({
        source: "path",
        sourcePath: expect.stringContaining("memory-lancedb"),
        installPath: expect.stringContaining("memory-lancedb"),
      }),
    });
    expect(enablePluginInConfig).not.toHaveBeenCalled();
    expect(applyExclusiveSlotSelection).not.toHaveBeenCalled();
    expect(runtimeLogs.some((line) => line.includes("requires configuration first"))).toBe(true);
  });

  it("enables config-gated bundled installs when provider-backed config is explicit", async () => {
    const cfg = {
      plugins: {
        entries: {
          "memory-lancedb": {
            config: {
              embedding: {
                provider: "openai",
                model: "text-embedding-3-small",
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("memory-lancedb");
    loadConfig.mockReturnValue(cfg);
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });

    await runPluginsCommand(["plugins", "install", "memory-lancedb"]);

    expect(enablePluginInConfig).toHaveBeenCalled();
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
    expect(runtimeLogs.some((line) => line.includes("requires configuration first"))).toBe(false);
  });

  it("passes force through as overwrite mode for ClawHub installs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    parseClawHubPluginSpec.mockReturnValue({ name: "demo" });
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "official",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "clawhub:demo", "--force"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
        mode: "update",
      }),
    );
  });

  it("keeps explicit ClawHub versions pinned in install records", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    parseClawHubPluginSpec.mockReturnValue({ name: "demo", version: "1.2.3" });
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "official",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "clawhub:demo@1.2.3"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo@1.2.3",
      }),
    );
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      demo: expect.objectContaining({
        source: "clawhub",
        spec: "clawhub:demo@1.2.3",
        installPath: cliInstallPath("demo"),
        version: "1.2.3",
        clawhubPackage: "demo",
      }),
    });
  });

  it("prefers ClawHub before npm for bare plugin specs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "community",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      demo: expect.objectContaining({
        source: "clawhub",
        spec: "clawhub:demo",
        installPath: cliInstallPath("demo"),
        version: "1.2.3",
        clawhubPackage: "demo",
      }),
    });
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
  });

  it("keeps explicit bare ClawHub selectors in install records", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3-beta.1",
        channel: "community",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "demo@beta"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo@beta",
      }),
    );
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      demo: expect.objectContaining({
        source: "clawhub",
        spec: "clawhub:demo@beta",
        version: "1.2.3-beta.1",
        clawhubPackage: "demo",
      }),
    });
  });

  it("falls back to npm when ClawHub does not have the package", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
      }),
    );
  });

  it("installs directly from npm when npm: prefix is used", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult("demo"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "npm:demo"]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
        mode: "install",
      }),
    );
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      demo: expect.objectContaining({
        source: "npm",
        spec: "demo",
        installPath: cliInstallPath("demo"),
      }),
    });
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
  });

  it("passes the active profile extensions dir to npm installs", async () => {
    const extensionsDir = useProfileExtensionsDir();
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult("demo"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "npm:demo"]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionsDir,
        spec: "demo",
      }),
    );
  });

  it("passes npm: prefix installs through npm options without ClawHub lookup", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult("demo"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);

    await runPluginsCommand([
      "plugins",
      "install",
      "npm:demo",
      "--force",
      "--dangerously-force-unsafe-install",
    ]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
        mode: "update",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
  });

  it("reports npm install failures without trying ClawHub when npm: prefix is used", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "npm install failed",
    });
    installHooksFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    await expect(runPluginsCommand(["plugins", "install", "npm:demo"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("npm install failed");
  });

  it("does not resolve npm: prefixed bundled plugin ids through bundled installs", async () => {
    loadConfig.mockReturnValue({ plugins: { load: { paths: [] } } } as OpenClawConfig);
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "Package not found on npm: memory-lancedb.",
      code: "npm_package_not_found",
    });
    installHooksFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    await expect(runPluginsCommand(["plugins", "install", "npm:memory-lancedb"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "memory-lancedb",
      }),
    );
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("Package not found on npm: memory-lancedb.");
  });

  it("rejects empty npm: prefix installs before resolver lookup", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);

    await expect(runPluginsCommand(["plugins", "install", "npm:"])).rejects.toThrow("__exit__:1");

    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("unsupported npm: spec: missing package");
  });

  it("installs directly from git when git: prefix is used", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    installPluginFromGitSpec.mockResolvedValue(createGitPluginInstallResult("demo"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "git:github.com/acme/demo@v1.2.3"]);

    expect(installPluginFromGitSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "git:github.com/acme/demo@v1.2.3",
        mode: "install",
      }),
    );
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      demo: expect.objectContaining({
        source: "git",
        spec: "git:github.com/acme/demo@v1.2.3",
        installPath: cliInstallPath("demo"),
        gitUrl: "https://github.com/acme/demo.git",
        gitRef: "v1.2.3",
        gitCommit: "abc123",
      }),
    });
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
  });

  it("rejects --pin for git installs and points at git refs", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);

    await expect(
      runPluginsCommand(["plugins", "install", "git:github.com/acme/demo", "--pin"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromGitSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("use `git:<repo>@<ref>`");
  });

  it("passes dangerous force unsafe install to marketplace installs", async () => {
    await expect(
      runPluginsCommand([
        "plugins",
        "install",
        "alpha",
        "--marketplace",
        "local/repo",
        "--dangerously-force-unsafe-install",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("passes dangerous force unsafe install to npm installs", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo", "--dangerously-force-unsafe-install"]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("passes dangerous force unsafe install to linked path probe installs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-link-"));

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockResolvedValueOnce({
      ok: true,
      pluginId: "demo",
      targetDir: tmpRoot,
      version: "1.2.3",
      extensions: ["./dist/index.js"],
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        tmpRoot,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    expect(installPluginFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: tmpRoot,
        dryRun: true,
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("passes dangerous force unsafe install to linked hook-pack probe fallback", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-link-"));
    primeHookPackPathFallback({
      tmpRoot,
      pluginInstallError: "plugin install probe failed",
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        tmpRoot,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    expect(installHooksFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: tmpRoot,
        dryRun: true,
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("does not fall back to hook pack for linked path when a no-flag security scan blocks", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-link-plugin-"));
    const pluginInstallError = "plugin blocked by security scan";

    loadConfig.mockReturnValue({} as OpenClawConfig);
    installPluginFromPath.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_blocked",
    });

    try {
      await expect(
        runPluginsCommand(["plugins", "install", localPluginDir, "--link"]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installHooksFromPath).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("passes dangerous force unsafe install to local hook-pack fallback installs", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-install-"));
    primeHookPackPathFallback({
      tmpRoot,
      pluginInstallError: "plugin install failed",
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        tmpRoot,
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    expect(installHooksFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: tmpRoot,
        mode: "install",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("passes the active profile extensions dir to local path installs", async () => {
    const extensionsDir = useProfileExtensionsDir();
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: path.join(extensionsDir, "demo"),
      version: "1.2.3",
      extensions: ["./dist/index.js"],
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    try {
      await runPluginsCommand(["plugins", "install", localPluginDir]);
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installPluginFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionsDir,
        path: localPluginDir,
      }),
    );
  });
  it("passes force through as overwrite mode for npm installs", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo", "--force"]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
        mode: "update",
      }),
    );
  });

  it("suggests update or --force when npm plugin install target already exists", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);
    mockClawHubPackageNotFound("@example/lossless-claw");
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error:
        "plugin already exists: /home/openclaw/.openclaw/extensions/lossless-claw (delete it first)",
    });
    installHooksFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    await expect(
      runPluginsCommand(["plugins", "install", "@example/lossless-claw"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Use `openclaw plugins update <id-or-npm-spec>` to upgrade the tracked plugin, or rerun install with `--force` to replace it.",
    );
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("does not append hook-pack fallback details for managed extensions boundary failures", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));

    loadConfig.mockReturnValue({} as OpenClawConfig);
    installPluginFromPath.mockResolvedValue({
      ok: false,
      error: "Invalid path: must stay within extensions directory",
    });
    installHooksFromPath.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    try {
      await expect(runPluginsCommand(["plugins", "install", localPluginDir])).rejects.toThrow(
        "__exit__:1",
      );
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(runtimeErrors.at(-1)).toBe("Invalid path: must stay within extensions directory");
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("passes the install logger to the --link dry-run probe", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-link-plugin-"));
    const cfg = {
      plugins: {
        entries: {},
        load: {
          paths: [],
        },
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockImplementation(async (...args: unknown[]) => {
      const [params] = args as [
        {
          logger?: { warn?: (message: string) => void };
          path: string;
          dryRun?: boolean;
          dangerouslyForceUnsafeInstall?: boolean;
        },
      ];
      params.logger?.warn?.(
        'WARNING: Plugin "demo" forced despite dangerous code patterns via --dangerously-force-unsafe-install: index.js:1',
      );
      return {
        ok: true,
        pluginId: "demo",
        targetDir: localPluginDir,
        version: "1.0.0",
        extensions: [],
      };
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        localPluginDir,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installPluginFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: localPluginDir,
        dryRun: true,
        dangerouslyForceUnsafeInstall: true,
        logger: expect.objectContaining({
          info: expect.any(Function),
          warn: expect.any(Function),
        }),
      }),
    );
    expect(
      runtimeLogs.some((line) =>
        line.includes(
          "forced despite dangerous code patterns via --dangerously-force-unsafe-install",
        ),
      ),
    ).toBe(true);
  });

  it("does not fall back to hook pack for local path when a no-flag security scan fails", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));
    const pluginInstallError = "plugin security scan failed";

    loadConfig.mockReturnValue({} as OpenClawConfig);
    installPluginFromPath.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_failed",
    });

    try {
      await expect(runPluginsCommand(["plugins", "install", localPluginDir])).rejects.toThrow(
        "__exit__:1",
      );
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installHooksFromPath).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("does not fall back to hook pack for local path when dangerous force unsafe install is set", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));
    const cfg = {} as OpenClawConfig;
    const pluginInstallError = "plugin blocked by security scan";

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_blocked",
    });

    try {
      await expect(
        runPluginsCommand([
          "plugins",
          "install",
          localPluginDir,
          "--dangerously-force-unsafe-install",
        ]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installHooksFromPath).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
  });

  it("does not fall back to hook pack for local path when security scan fails under dangerous force unsafe install", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));
    const cfg = {} as OpenClawConfig;
    const pluginInstallError = "plugin security scan failed";

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_failed",
    });

    try {
      await expect(
        runPluginsCommand([
          "plugins",
          "install",
          localPluginDir,
          "--dangerously-force-unsafe-install",
        ]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installHooksFromPath).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
  });

  it("does not fall back to hook pack for npm installs when dangerous force unsafe install is set", async () => {
    const cfg = {} as OpenClawConfig;
    const pluginInstallError = "plugin blocked by security scan";

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/demo failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_blocked",
    });

    await expect(
      runPluginsCommand(["plugins", "install", "demo", "--dangerously-force-unsafe-install"]),
    ).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
  });

  it("does not fall back to hook pack for npm installs when a no-flag security scan blocks", async () => {
    primeBlockedNpmPluginInstall({
      spec: "@acme/unsafe-plugin",
      pluginId: "unsafe-plugin",
    });

    await expect(runPluginsCommand(["plugins", "install", "@acme/unsafe-plugin"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(installHooksFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain('Plugin "unsafe-plugin" installation blocked');
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("does not fall back to hook pack for npm installs when security scan fails under dangerous force unsafe install", async () => {
    const cfg = {} as OpenClawConfig;
    const pluginInstallError = "plugin security scan failed";

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/demo failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_failed",
    });

    await expect(
      runPluginsCommand(["plugins", "install", "demo", "--dangerously-force-unsafe-install"]),
    ).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
  });

  it("still falls back to local hook pack when dangerous force unsafe install is set for non-security errors", async () => {
    const localHookDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-hook-pack-"));
    const cfg = {} as OpenClawConfig;
    const installedCfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "path",
              sourcePath: localHookDir,
            },
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.plugin.json",
      code: "missing_openclaw_extensions",
    });
    installHooksFromPath.mockResolvedValue({
      ok: true,
      hookPackId: "demo-hooks",
      hooks: ["command-audit"],
      targetDir: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
    });
    recordHookInstall.mockReturnValue(installedCfg);

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        localHookDir,
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(localHookDir, { recursive: true, force: true });
    }

    expect(installHooksFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: localHookDir,
      }),
    );
    expect(runtimeLogs.some((line) => line.includes("Installed hook pack: demo-hooks"))).toBe(true);
  });

  it("still falls back to npm hook pack when dangerous force unsafe install is set for non-security errors", async () => {
    const cfg = {} as OpenClawConfig;
    const installedCfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.2.3",
            },
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/@acme/demo-hooks failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.plugin.json",
      code: "missing_openclaw_extensions",
    });
    installHooksFromNpmSpec.mockResolvedValue({
      ok: true,
      hookPackId: "demo-hooks",
      hooks: ["command-audit"],
      targetDir: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
      npmResolution: {
        name: "@acme/demo-hooks",
        spec: "@acme/demo-hooks@1.2.3",
        integrity: "sha256-demo",
      },
    });
    recordHookInstall.mockReturnValue(installedCfg);

    await runPluginsCommand([
      "plugins",
      "install",
      "@acme/demo-hooks",
      "--dangerously-force-unsafe-install",
    ]);

    expect(installHooksFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo-hooks",
      }),
    );
    expect(runtimeLogs.some((line) => line.includes("Installed hook pack: demo-hooks"))).toBe(true);
  });

  it("does not fall back to npm when ClawHub rejects a real package", async () => {
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: 'Use "openclaw skills install demo" instead.',
      code: "skill_package",
    });

    await expect(runPluginsCommand(["plugins", "install", "demo"])).rejects.toThrow("__exit__:1");

    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain('Use "openclaw skills install demo" instead.');
  });

  it("falls back to installing hook packs from npm specs", async () => {
    const { installedCfg } = primeHookPackNpmFallback();

    await runPluginsCommand(["plugins", "install", "@acme/demo-hooks"]);

    expect(installHooksFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo-hooks",
      }),
    );
    expect(recordHookInstall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        hookId: "demo-hooks",
        hooks: ["command-audit"],
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("Installed hook pack: demo-hooks"))).toBe(true);
  });

  it("passes force through as overwrite mode for hook-pack npm fallback installs", async () => {
    primeHookPackNpmFallback();

    await runPluginsCommand(["plugins", "install", "@acme/demo-hooks", "--force"]);

    expect(installHooksFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo-hooks",
        mode: "update",
      }),
    );
  });
});
