import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "../plugins/official-external-plugin-catalog.js";
import {
  applyExclusiveSlotSelection,
  buildPluginSnapshotReport,
  enablePluginInConfig,
  findBundledPluginSourceMock,
  installHooksFromNpmSpec,
  installHooksFromPath,
  installPluginFromNpmPackArchive,
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
const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;
const PROFILE_STATE_ROOT = "/tmp/openclaw-ledger-profile";

const OFFICIAL_EXTERNAL_NPM_INSTALLS_WITHOUT_INTEGRITY = listOfficialExternalPluginCatalogEntries()
  .map((entry) => {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const install = resolveOfficialExternalPluginInstall(entry);
    const npmSpec = install?.npmSpec?.trim();
    if (!pluginId || !npmSpec || install?.expectedIntegrity) {
      return null;
    }
    return { pluginId, npmSpec };
  })
  .filter((entry): entry is { pluginId: string; npmSpec: string } => Boolean(entry))
  .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

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
      clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clawpackSpecVersion: 1,
      clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      clawpackSize: 4096,
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

function createNpmPackPluginInstallResult(
  pluginId = "demo",
): Awaited<ReturnType<typeof installPluginFromNpmPackArchive>> {
  return {
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version: "1.2.3",
    extensions: ["dist/index.js"],
    manifestName: `@openclaw/${pluginId}`,
    npmTarballName: `openclaw-${pluginId}-1.2.3.tgz`,
    npmResolution: {
      name: `@openclaw/${pluginId}`,
      version: "1.2.3",
      resolvedSpec: `@openclaw/${pluginId}@1.2.3`,
      integrity: "sha512-pack-demo",
      shasum: "packdemosha",
      resolvedAt: "2026-05-06T00:00:00.000Z",
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

type MockWithCalls = {
  mock: {
    calls: readonly (readonly unknown[])[];
  };
};

type PluginInstallCall = {
  archivePath?: string;
  dangerouslyForceUnsafeInstall?: boolean;
  dryRun?: boolean;
  expectedIntegrity?: string;
  expectedPluginId?: string;
  extensionsDir?: string;
  logger?: {
    info?: unknown;
    warn?: unknown;
  };
  marketplace?: string;
  mode?: string;
  path?: string;
  plugin?: string;
  spec?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
};

type PersistedInstallRecord = Record<string, unknown>;

function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  if (call.length <= argIndex) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function marketplaceInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromMarketplace, callIndex) as PluginInstallCall;
}

function clawHubInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromClawHub, callIndex) as PluginInstallCall;
}

function npmInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromNpmSpec, callIndex) as PluginInstallCall;
}

function npmPackInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromNpmPackArchive, callIndex) as PluginInstallCall;
}

function gitInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromGitSpec, callIndex) as PluginInstallCall;
}

function pathInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromPath, callIndex) as PluginInstallCall;
}

function hookPathInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installHooksFromPath, callIndex) as PluginInstallCall;
}

function hookNpmInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installHooksFromNpmSpec, callIndex) as PluginInstallCall;
}

function persistedInstallRecords(callIndex = 0): Record<string, PersistedInstallRecord> {
  return mockCallArg(writePersistedInstalledPluginIndexInstallRecords, callIndex) as Record<
    string,
    PersistedInstallRecord
  >;
}

function persistedInstallRecord(pluginId: string, callIndex = 0): PersistedInstallRecord {
  const record = persistedInstallRecords(callIndex)[pluginId];
  if (!record) {
    throw new Error(`Expected persisted install record for ${pluginId}`);
  }
  return record;
}

function replaceConfigCall(callIndex = 0): { baseHash?: string; nextConfig?: OpenClawConfig } {
  return mockCallArg(replaceConfigFile, callIndex) as {
    baseHash?: string;
    nextConfig?: OpenClawConfig;
  };
}

function recordHookInstallCall(callIndex = 0): PersistedInstallRecord {
  return mockCallArg(recordHookInstall, callIndex, 1) as PersistedInstallRecord;
}

function runtimeLogsContain(fragment: string): boolean {
  return runtimeLogs.some((line) => line.includes(fragment));
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
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
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

  it("refuses plugin installs in Nix mode before installer side effects", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";

    await expect(runPluginsCommand(["plugins", "install", "@acme/demo"])).rejects.toThrow(
      "OPENCLAW_NIX_MODE=1",
    );

    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(installPluginFromPath).not.toHaveBeenCalled();
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("exits when --marketplace is combined with --link", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--link"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("--link is not supported with --marketplace.");
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
  });

  it("exits when --force is combined with --link", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "./plugin", "--link", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("--force is not supported with --link.");
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("exits when marketplace install fails", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]),
    ).rejects.toThrow("__exit__:1");

    expect(marketplaceInstallCall().marketplace).toBe("local/repo");
    expect(marketplaceInstallCall().plugin).toBe("alpha");
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("passes the active profile extensions dir to marketplace installs", async () => {
    const extensionsDir = useProfileExtensionsDir();

    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]),
    ).rejects.toThrow("__exit__:1");

    expect(marketplaceInstallCall().extensionsDir).toBe(extensionsDir);
    expect(marketplaceInstallCall().marketplace).toBe("local/repo");
    expect(marketplaceInstallCall().plugin).toBe("alpha");
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

    expect(persistedInstallRecord("alpha").source).toBe("marketplace");
    expect(persistedInstallRecord("alpha").installPath).toBe(cliInstallPath("alpha"));
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
    expect(replaceConfigCall().baseHash).toBe("mock");
    expect(replaceConfigCall().nextConfig).toBe(enabledCfg);
    expect(runtimeLogsContain("slot adjusted")).toBe(true);
    expect(runtimeLogsContain("Installed plugin: alpha")).toBe(true);
  });

  it("passes force through as overwrite mode for marketplace installs", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(marketplaceInstallCall().marketplace).toBe("local/repo");
    expect(marketplaceInstallCall().plugin).toBe("alpha");
    expect(marketplaceInstallCall().mode).toBe("update");
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

    expect(clawHubInstallCall().spec).toBe("clawhub:demo");
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("clawhub");
    expect(record.spec).toBe("clawhub:demo");
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.version).toBe("1.2.3");
    expect(record.clawhubPackage).toBe("demo");
    expect(record.clawhubFamily).toBe("code-plugin");
    expect(record.clawhubChannel).toBe("official");
    expect(record.clawpackSha256).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(record.clawpackSpecVersion).toBe(1);
    expect(record.clawpackManifestSha256).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(record.clawpackSize).toBe(4096);
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
    expect(runtimeLogsContain("Installed plugin: demo")).toBe(true);
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

    expect(clawHubInstallCall().extensionsDir).toBe(extensionsDir);
    expect(clawHubInstallCall().spec).toBe("clawhub:demo");
  });

  it("does not persist incomplete config entries for config-gated bundled installs", async () => {
    const pluginId = "config-required-plugin";
    const cfg = {
      plugins: {
        entries: {
          [pluginId]: {
            config: {},
          },
        },
        load: {
          paths: ["/existing/plugin"],
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    findBundledPluginSourceMock.mockReturnValue({
      pluginId,
      localPath: `/app/dist/extensions/${pluginId}`,
      configSchema: {
        type: "object",
        required: ["token"],
        properties: {
          token: {
            type: "string",
          },
        },
      },
      requiresConfig: true,
    });

    await runPluginsCommand(["plugins", "install", pluginId]);

    const writtenConfig = writeConfigFile.mock.calls.at(-1)?.[0] as OpenClawConfig;
    expect(writtenConfig.plugins?.entries?.[pluginId]).toBeUndefined();
    expect(writtenConfig.plugins?.load?.paths).toEqual(["/existing/plugin"]);
    const record = persistedInstallRecord(pluginId);
    expect(record.source).toBe("path");
    expect(String(record.sourcePath)).toContain(pluginId);
    expect(String(record.installPath)).toContain(pluginId);
    expect(enablePluginInConfig).not.toHaveBeenCalled();
    expect(applyExclusiveSlotSelection).not.toHaveBeenCalled();
    expect(runtimeLogsContain("requires configuration first")).toBe(true);
  });

  it("enables config-gated bundled installs when provider-backed config is explicit", async () => {
    const pluginId = "config-required-plugin";
    const cfg = {
      plugins: {
        entries: {
          [pluginId]: {
            config: {
              token: "sk-test",
            },
          },
        },
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig(pluginId);
    loadConfig.mockReturnValue(cfg);
    findBundledPluginSourceMock.mockReturnValue({
      pluginId,
      localPath: `/app/dist/extensions/${pluginId}`,
      configSchema: {
        type: "object",
        required: ["token"],
        properties: {
          token: {
            type: "string",
          },
        },
      },
      requiresConfig: true,
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });

    await runPluginsCommand(["plugins", "install", pluginId]);

    expect(enablePluginInConfig).toHaveBeenCalledTimes(1);
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
    expect(runtimeLogsContain("requires configuration first")).toBe(false);
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

    expect(clawHubInstallCall().spec).toBe("clawhub:demo");
    expect(clawHubInstallCall().mode).toBe("update");
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

    expect(clawHubInstallCall().spec).toBe("clawhub:demo@1.2.3");
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("clawhub");
    expect(record.spec).toBe("clawhub:demo@1.2.3");
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.version).toBe("1.2.3");
    expect(record.clawhubPackage).toBe("demo");
    expect(record.clawpackSha256).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(record.clawpackSpecVersion).toBe(1);
    expect(record.clawpackManifestSha256).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(record.clawpackSize).toBe(4096);
  });

  it("resolves exact official external plugin ids through their npm package", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("brave");
    loadConfig.mockReturnValue(cfg);
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult("brave"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "brave"]);

    expect(findBundledPluginSourceMock).toHaveBeenCalledWith({
      lookup: { kind: "pluginId", value: "brave" },
    });
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(npmInstallCall().spec).toBe("@openclaw/brave-plugin");
    expect(npmInstallCall().expectedPluginId).toBe("brave");
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    const record = persistedInstallRecord("brave");
    expect(record.source).toBe("npm");
    expect(record.spec).toBe("@openclaw/brave-plugin");
    expect(record.installPath).toBe(cliInstallPath("brave"));
    expect(record.version).toBe("1.2.3");
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
  });

  it("passes third-party external catalog integrity with catalog install trust", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("wecom-openclaw-plugin");
    loadConfig.mockReturnValue(cfg);
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpec.mockResolvedValue(
      createNpmPluginInstallResult("wecom-openclaw-plugin"),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "wecom"]);

    expect(npmInstallCall().spec).toBe("@wecom/wecom-openclaw-plugin@2026.4.23");
    expect(npmInstallCall().expectedPluginId).toBe("wecom-openclaw-plugin");
    expect(npmInstallCall().expectedIntegrity).toBe(
      "sha512-bnzfdIEEu1/LFvcdyjaTkyxt27w6c7dqhkPezU62OWaqmcdFsUGR3T55USK/O9pIKsNcnL1Tnu1pqKYCWHFgWQ==",
    );
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
  });

  it.each(OFFICIAL_EXTERNAL_NPM_INSTALLS_WITHOUT_INTEGRITY)(
    "keeps official external npm installs trusted without integrity for $pluginId",
    async ({ pluginId, npmSpec }) => {
      const cfg = createEmptyPluginConfig();
      const enabledCfg = createEnabledPluginConfig(pluginId);
      loadConfig.mockReturnValue(cfg);
      findBundledPluginSourceMock.mockReturnValue(undefined);
      installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult(pluginId));
      enablePluginInConfig.mockReturnValue({ config: enabledCfg });
      applyExclusiveSlotSelection.mockReturnValue({
        config: enabledCfg,
        warnings: [],
      });

      await runPluginsCommand(["plugins", "install", pluginId]);

      expect(findBundledPluginSourceMock).toHaveBeenCalledWith({
        lookup: { kind: "pluginId", value: pluginId },
      });
      expect(installPluginFromClawHub).not.toHaveBeenCalled();
      expect(npmInstallCall().spec).toBe(npmSpec);
      expect(npmInstallCall().expectedPluginId).toBe(pluginId);
      expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
      expect(npmInstallCall().expectedIntegrity).toBeUndefined();
    },
  );

  it("passes third-party external catalog integrity to hook-pack fallback", async () => {
    loadConfig.mockReturnValue(createEmptyPluginConfig());
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.extensions",
      code: "missing_openclaw_extensions",
    });
    installHooksFromNpmSpec.mockResolvedValue({
      ok: false,
      error:
        "aborted: npm package integrity drift detected for @wecom/wecom-openclaw-plugin@2026.4.23",
    });

    await expect(runPluginsCommand(["plugins", "install", "wecom"])).rejects.toThrow("__exit__:1");

    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(hookNpmInstallCall().spec).toBe("@wecom/wecom-openclaw-plugin@2026.4.23");
    expect(hookNpmInstallCall().expectedIntegrity).toBe(
      "sha512-bnzfdIEEu1/LFvcdyjaTkyxt27w6c7dqhkPezU62OWaqmcdFsUGR3T55USK/O9pIKsNcnL1Tnu1pqKYCWHFgWQ==",
    );
  });

  it("installs ordinary bare plugin specs through npm without ClawHub lookup", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("demo");
    loadConfig.mockReturnValue(cfg);
    installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult("demo"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "demo"]);

    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(npmInstallCall().spec).toBe("demo");
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("npm");
    expect(record.spec).toBe("demo");
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.version).toBe("1.2.3");
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
  });

  it("passes bare npm selectors through npm without ClawHub lookup", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("demo");
    loadConfig.mockReturnValue(cfg);
    installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult("demo"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "demo@beta"]);

    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(npmInstallCall().spec).toBe("demo@beta");
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

    expect(npmInstallCall().spec).toBe("demo");
    expect(npmInstallCall().mode).toBe("install");
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(persistedInstallRecord("demo").source).toBe("npm");
    expect(persistedInstallRecord("demo").spec).toBe("demo");
    expect(persistedInstallRecord("demo").installPath).toBe(cliInstallPath("demo"));
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
  });

  it("installs npm-pack archives through npm install semantics", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("demo");
    const archivePath = "/tmp/openclaw-demo-1.2.3.tgz";

    loadConfig.mockReturnValue(cfg);
    installPluginFromNpmPackArchive.mockResolvedValue(createNpmPackPluginInstallResult("demo"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", `npm-pack:${archivePath}`]);

    expect(npmPackInstallCall().archivePath).toBe(archivePath);
    expect(npmPackInstallCall().mode).toBe("install");
    expect(installPluginFromPath).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("npm");
    expect(record.spec).toBe("@openclaw/demo@1.2.3");
    expect(record.sourcePath).toBe(archivePath);
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.version).toBe("1.2.3");
    expect(record.artifactKind).toBe("npm-pack");
    expect(record.artifactFormat).toBe("tgz");
    expect(record.npmIntegrity).toBe("sha512-pack-demo");
    expect(record.npmShasum).toBe("packdemosha");
    expect(record.npmTarballName).toBe("openclaw-demo-1.2.3.tgz");
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
  });

  it("keeps npm-prefixed official plugin ids on explicit npm semantics", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("brave");

    loadConfig.mockReturnValue(cfg);
    installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult("brave"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "npm:brave"]);

    expect(npmInstallCall().spec).toBe("brave");
    expect(npmInstallCall().expectedPluginId).toBeUndefined();
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBeUndefined();
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
  });

  it("marks explicit official npm package installs as trusted", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("discord");

    loadConfig.mockReturnValue(cfg);
    installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult("discord"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "npm:@openclaw/discord"]);

    expect(npmInstallCall().spec).toBe("@openclaw/discord");
    expect(npmInstallCall().expectedPluginId).toBe("discord");
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
  });

  it("marks scoped official npm package installs as trusted", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("discord");

    loadConfig.mockReturnValue(cfg);
    installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult("discord"));
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "@openclaw/discord"]);

    expect(npmInstallCall().spec).toBe("@openclaw/discord");
    expect(npmInstallCall().expectedPluginId).toBe("discord");
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
  });

  it("marks catalog npm package installs with alternate selectors as trusted", async () => {
    const cfg = createEmptyPluginConfig();
    const enabledCfg = createEnabledPluginConfig("wecom-openclaw-plugin");

    loadConfig.mockReturnValue(cfg);
    installPluginFromNpmSpec.mockResolvedValue(
      createNpmPluginInstallResult("wecom-openclaw-plugin"),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "@wecom/wecom-openclaw-plugin@latest"]);

    // Alternate selectors stay trusted by catalog package name, but must not
    // inherit catalog integrity unless the install spec matches exactly.
    expect(npmInstallCall().spec).toBe("@wecom/wecom-openclaw-plugin@latest");
    expect(npmInstallCall().expectedPluginId).toBe("wecom-openclaw-plugin");
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(npmInstallCall().expectedIntegrity).toBeUndefined();
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
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

    expect(npmInstallCall().extensionsDir).toBe(extensionsDir);
    expect(npmInstallCall().spec).toBe("demo");
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

    expect(npmInstallCall().spec).toBe("demo");
    expect(npmInstallCall().mode).toBe("update");
    expect(npmInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
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

  it("adds a Git PATH hint when npm plugin dependency install cannot spawn git", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: [
        "npm install failed:",
        "npm error code ENOENT",
        "npm error syscall spawn git",
        "npm error path git",
      ].join("\n"),
    });
    installHooksFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    await expect(
      runPluginsCommand(["plugins", "install", "npm:@openclaw/whatsapp"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "one of this plugin's npm dependencies is fetched from a git URL",
    );
    expect(runtimeErrors.at(-1)).toContain("winget install --id Git.Git -e");
    expect(runtimeErrors.at(-1)).toContain("Also not a valid hook pack");
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

    expect(npmInstallCall().spec).toBe("memory-lancedb");
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("Package not found on npm: memory-lancedb.");
  });

  it("rejects empty npm: prefix installs before resolver lookup", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);

    await expect(runPluginsCommand(["plugins", "install", "npm:"])).rejects.toThrow("__exit__:1");

    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("Unsupported npm plugin spec: missing package.");
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

    expect(gitInstallCall().spec).toBe("git:github.com/acme/demo@v1.2.3");
    expect(gitInstallCall().mode).toBe("install");
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("git");
    expect(record.spec).toBe("git:github.com/acme/demo@v1.2.3");
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.gitUrl).toBe("https://github.com/acme/demo.git");
    expect(record.gitRef).toBe("v1.2.3");
    expect(record.gitCommit).toBe("abc123");
    expect(writeConfigFile).toHaveBeenCalledWith(enabledCfg);
  });

  it("rejects --pin for git installs and points at git refs", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);

    await expect(
      runPluginsCommand(["plugins", "install", "git:github.com/acme/demo", "--pin"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromGitSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("openclaw plugins install git:<repo>@<ref>");
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

    expect(marketplaceInstallCall().marketplace).toBe("local/repo");
    expect(marketplaceInstallCall().plugin).toBe("alpha");
    expect(marketplaceInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
  });

  it("passes dangerous force unsafe install to npm installs", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo", "--dangerously-force-unsafe-install"]);

    expect(npmInstallCall().spec).toBe("demo");
    expect(npmInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
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

    expect(pathInstallCall().path).toBe(tmpRoot);
    expect(pathInstallCall().dryRun).toBe(true);
    expect(pathInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
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

    expect(hookPathInstallCall().path).toBe(tmpRoot);
    expect(hookPathInstallCall().dryRun).toBe(true);
    expect(hookPathInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
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

    expect(hookPathInstallCall().path).toBe(tmpRoot);
    expect(hookPathInstallCall().mode).toBe("install");
    expect(hookPathInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
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

    expect(pathInstallCall().extensionsDir).toBe(extensionsDir);
    expect(pathInstallCall().path).toBe(localPluginDir);
  });
  it("passes force through as overwrite mode for npm installs", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo", "--force"]);

    expect(npmInstallCall().spec).toBe("demo");
    expect(npmInstallCall().mode).toBe("update");
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

    expect(pathInstallCall().path).toBe(localPluginDir);
    expect(pathInstallCall().dryRun).toBe(true);
    expect(pathInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
    expect(typeof pathInstallCall().logger?.info).toBe("function");
    expect(typeof pathInstallCall().logger?.warn).toBe("function");
    expect(
      runtimeLogsContain(
        "forced despite dangerous code patterns via --dangerously-force-unsafe-install",
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

    expect(hookPathInstallCall().path).toBe(localHookDir);
    expect(runtimeLogsContain("Installed hook pack: demo-hooks")).toBe(true);
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

    expect(hookNpmInstallCall().spec).toBe("@acme/demo-hooks");
    expect(runtimeLogsContain("Installed hook pack: demo-hooks")).toBe(true);
  });

  it("does not fall back to npm when explicit ClawHub rejects a real package", async () => {
    parseClawHubPluginSpec.mockReturnValue({ name: "demo" });
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: 'Use "openclaw skills install demo" instead.',
      code: "skill_package",
    });

    await expect(runPluginsCommand(["plugins", "install", "clawhub:demo"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain('Use "openclaw skills install demo" instead.');
  });

  it("falls back to installing hook packs from npm specs", async () => {
    const { installedCfg } = primeHookPackNpmFallback();

    await runPluginsCommand(["plugins", "install", "@acme/demo-hooks"]);

    expect(hookNpmInstallCall().spec).toBe("@acme/demo-hooks");
    expect(recordHookInstallCall().hookId).toBe("demo-hooks");
    expect(recordHookInstallCall().hooks).toEqual(["command-audit"]);
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogsContain("Installed hook pack: demo-hooks")).toBe(true);
  });

  it("passes force through as overwrite mode for hook-pack npm fallback installs", async () => {
    primeHookPackNpmFallback();

    await runPluginsCommand(["plugins", "install", "@acme/demo-hooks", "--force"]);

    expect(hookNpmInstallCall().spec).toBe("@acme/demo-hooks");
    expect(hookNpmInstallCall().mode).toBe("update");
  });
});
