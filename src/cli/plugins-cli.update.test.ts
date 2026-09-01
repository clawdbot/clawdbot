// Plugins CLI update tests cover plugin update command behavior and output.
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ClawHubTrustErrorCode } from "../infra/clawhub-install-trust.js";
import { resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import type { PluginCapabilityConsentReview } from "../plugins/capability-consent.js";
import {
  attachPluginInstallOwnerMigrations,
  resolvePluginInstallTransactionSink,
  type PluginInstallTransaction,
} from "../plugins/install-transaction.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import { VERSION } from "../version.js";
import {
  createTestInstalledPluginIndex,
  pluginCliConfigMock,
  notifyGatewayPluginMetadataChangedMock,
  readConfigFileSnapshotForWriteMock,
  readPersistedInstalledPluginIndexMock,
  refreshPluginRegistryMock,
  replaceConfigFileMock,
  resetPluginsCliTestState,
  restorePersistedInstalledPluginIndexIfCurrentMock,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  promptYesNoMock,
  setInstalledPluginIndexInstallRecords,
  setHookInstallRecords,
  updateNpmInstalledHookPacksMock,
  updateNpmInstalledPluginsMock,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";
import { registerPluginsCli } from "./plugins-cli.js";

const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;
const ORIGINAL_STDIN_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIGINAL_STDOUT_TTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

function restoreTty(): void {
  if (ORIGINAL_STDIN_TTY) {
    Object.defineProperty(process.stdin, "isTTY", ORIGINAL_STDIN_TTY);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  if (ORIGINAL_STDOUT_TTY) {
    Object.defineProperty(process.stdout, "isTTY", ORIGINAL_STDOUT_TTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

function createTrackedPluginConfig(params: {
  pluginId: string;
  spec: string;
  resolvedName?: string;
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "npm",
          spec: params.spec,
          installPath: `/tmp/${params.pluginId}`,
          ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
        },
      },
    },
  } as OpenClawConfig;
}

function createCapabilityConsentReview(): PluginCapabilityConsentReview {
  return {
    pluginId: "alpha",
    name: "Alpha plugin",
    version: "2.0.0",
    source: { kind: "npm", spec: "@acme/alpha", integrity: "sha512-alpha" },
    declared: {
      channels: [],
      providers: [],
      tools: ["read", "write"],
      contracts: ["gatewayMethodDispatch: alpha.run"],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    },
    grants: {
      hooks: {
        allowPromptInjection: { effective: true },
        allowConversationAccess: { effective: false },
      },
    },
    widened: { tools: ["write"] },
    trust: { disposition: "review-recommended", reasons: ["Community maintained"] },
    reviewToken: "reviewed-alpha-surface",
  };
}

function expectRestartNoticeLogged() {
  expect(
    pluginsCliRuntimeLogs.some((message) =>
      message.includes("Restart the gateway to load plugins and hooks."),
    ),
  ).toBe(true);
}

function expectInstallRecordsWrittenWithLease(records: unknown, config: unknown) {
  expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).toHaveBeenCalledWith(
    records,
    expect.objectContaining({
      config,
      filePath: expect.any(String),
      lease: expect.anything(),
    }),
  );
}

function expectSingleCallParams(mockFn: ReturnType<typeof vi.fn>) {
  expect(mockFn).toHaveBeenCalledTimes(1);
  const params = mockFn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (params === undefined) {
    throw new Error("expected call params");
  }
  return params;
}

function primeUpdateConfigSnapshot(params: {
  config: OpenClawConfig;
  configPath?: string;
  hash?: string;
  loadedConfig?: OpenClawConfig;
  parsed?: Record<string, unknown>;
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  valid?: boolean;
  includeFileHashesForWrite?: Record<string, string>;
  includeFileTargetsForWrite?: Record<string, string>;
}) {
  const configPath = params.configPath ?? path.join(process.cwd(), "openclaw.json5");
  const parsed = params.parsed ?? (params.config as Record<string, unknown>);
  const sourceConfig = params.sourceConfig ?? params.config;
  const runtimeConfig = params.runtimeConfig ?? params.config;
  const prepared = {
    snapshot: {
      path: configPath,
      exists: true,
      raw: JSON.stringify(parsed),
      parsed,
      resolved: sourceConfig,
      sourceConfig,
      runtimeConfig,
      valid: params.valid ?? true,
      config: runtimeConfig,
      hash: params.hash ?? "update-config",
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
    writeOptions: {
      assertConfigPathForWrite: () => {},
      expectedConfigPath: configPath,
      ownedConfigPathForWrite: configPath,
      includeFileHashesForWrite: params.includeFileHashesForWrite,
      includeFileTargetsForWrite: params.includeFileTargetsForWrite,
    },
  };
  pluginCliConfigMock.mockReturnValue(params.loadedConfig ?? params.config);
  readConfigFileSnapshotForWriteMock.mockResolvedValue(prepared);
  return prepared;
}

function primeBlockedUpdateConfig(section: "hooks" | "plugins", config: OpenClawConfig): void {
  const externalPath = path.join(
    path.parse(process.cwd()).root,
    "external-openclaw",
    `${section}.json5`,
  );
  primeUpdateConfigSnapshot({
    config,
    parsed: { [section]: { $include: externalPath } },
    includeFileTargetsForWrite: {
      [externalPath]: externalPath,
    },
  });
}

function primePluginUpdate(
  config: OpenClawConfig,
  outcomes: Awaited<ReturnType<typeof updateNpmInstalledPluginsMock>>["outcomes"] = [],
  changed = false,
  transactions?: PluginInstallTransaction[],
  installOwnerMigrations?: Readonly<Record<string, string>>,
): void {
  updateNpmInstalledPluginsMock.mockImplementation(async (params: unknown) => {
    resolvePluginInstallTransactionSink(params as object)?.push(...(transactions ?? []));
    const result = {
      config,
      changed,
      outcomes,
    };
    return installOwnerMigrations
      ? attachPluginInstallOwnerMigrations(result, installOwnerMigrations)
      : result;
  });
}

function primeBravePluginRecordUpdate(config: OpenClawConfig) {
  const previousRecords = {
    brave: {
      source: "npm",
      spec: "@openclaw/brave-plugin@2026.6.11-beta.2",
      installPath: "/tmp/brave-beta",
      resolvedName: "@openclaw/brave-plugin",
      resolvedVersion: "2026.6.11-beta.2",
    },
  } as const;
  const nextRecords = {
    brave: {
      ...previousRecords.brave,
      spec: "@openclaw/brave-plugin@2026.6.11",
      installPath: "/tmp/brave-stable",
      resolvedVersion: "2026.6.11",
    },
  } as const;
  setInstalledPluginIndexInstallRecords(previousRecords);
  primePluginUpdate(
    {
      ...config,
      plugins: {
        ...config.plugins,
        installs: nextRecords,
      },
    } as OpenClawConfig,
    [{ pluginId: "brave", status: "updated", message: "Updated brave." }],
    true,
  );
  return { previousRecords, nextRecords };
}

async function expectSkippedClawHubPluginUpdate(params: {
  code: ClawHubTrustErrorCode;
  message: string;
  expectedLog: string;
  spec?: string;
}): Promise<void> {
  const config = {
    plugins: {
      installs: {
        demo: {
          source: "clawhub",
          spec: params.spec ?? "clawhub:@openclaw/plugin-demo",
          clawhubPackage: "@openclaw/plugin-demo",
        },
      },
    },
  } as OpenClawConfig;
  pluginCliConfigMock.mockReturnValue(config);
  setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
  primePluginUpdate(config, [
    {
      pluginId: "demo",
      status: "skipped",
      code: params.code,
      message: params.message,
    },
  ]);
  updateNpmInstalledHookPacksMock.mockResolvedValue({ outcomes: [], changed: false, config });

  await expect(runPluginsCommand(["plugins", "update", "demo"])).rejects.toThrow("__exit__:1");

  expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
  expect(pluginsCliRuntimeLogs.at(-1)).toContain(params.expectedLog);
}

describe("plugins cli update", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  afterEach(() => {
    restoreTty();
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
    }
  });

  it("documents the install policy warning acknowledgement in update help", () => {
    const program = new Command();
    registerPluginsCli(program);

    const pluginsCommand = program.commands.find((command) => command.name() === "plugins");
    const updateCommand = pluginsCommand?.commands.find((command) => command.name() === "update");
    const helpText = updateCommand?.helpInformation() ?? "";

    expect(helpText).toContain("--dangerously-force-unsafe-install");
    expect(helpText).toContain("--acknowledge-install-policy-warning");
    expect(helpText).toContain("--accept-capabilities");
    expect(helpText).toContain("Deprecated no-op");
    expect(helpText).toContain("Acknowledge");
    expect(helpText).toContain("security.installPolicy");
    expect(helpText).toMatch(/blocks and\s+failures remain terminal/u);
  });

  it("refuses plugin updates in Nix mode before package-manager work", async () => {
    const previous = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      await expect(runPluginsCommand(["plugins", "update", "--all"])).rejects.toThrow(
        "OPENCLAW_NIX_MODE=1",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previous;
      }
    }

    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("previews plugin updates in Nix mode without acquiring a lease or writing state", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    const config = createTrackedPluginConfig({
      pluginId: "alpha",
      spec: "@acme/alpha@1.0.0",
    });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config, [
      {
        pluginId: "alpha",
        status: "updated",
        message: "Would update alpha: 1.0.0 -> 1.1.0.",
      },
    ]);
    const lifecycleLease = await import("../plugins/plugin-lifecycle-lease.js");
    const acquireLease = vi.spyOn(lifecycleLease, "withPluginLifecycleLease");

    try {
      await runPluginsCommand(["plugins", "update", "alpha", "--dry-run"]);

      expect(updateNpmInstalledPluginsMock).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, pluginIds: ["alpha"] }),
      );
      expect(acquireLease).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
      expect(pluginsCliRuntimeLogs).toContain("Would update alpha: 1.0.0 -> 1.1.0.");
    } finally {
      acquireLease.mockRestore();
    }
  });

  it.each([
    { id: "missing-plugin", args: [] },
    { id: "missing-plugin", args: ["--dry-run"] },
    { id: "constructor", args: [] },
    { id: "@acme/missing-plugin@beta", args: [] },
  ])("rejects untracked update target $id $args", async ({ id, args }) => {
    const config = {} as OpenClawConfig;
    primeUpdateConfigSnapshot({ config });
    primePluginUpdate(config, [
      { pluginId: id, status: "skipped", message: `No install record for "${id}".` },
    ]);

    await expect(runPluginsCommand(["plugins", "update", id, ...args])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(`No tracked plugin or hook pack found for "${id}".`);
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("rejects an npm update target shared by multiple tracked plugins", async () => {
    const config = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@acme/shared",
            installPath: "/tmp/alpha",
            resolvedName: "@acme/shared",
          },
          beta: {
            source: "npm",
            spec: "@acme/shared",
            installPath: "/tmp/beta",
            resolvedName: "@acme/shared",
          },
        },
      },
    } as OpenClawConfig;
    primeUpdateConfigSnapshot({ config });
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});

    await expect(runPluginsCommand(["plugins", "update", "@acme/shared@beta"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      'No tracked plugin or hook pack found for "@acme/shared@beta".',
    );
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a stale child-keyed owner", args: ["pack/one"] },
    { label: "update all", args: ["--all"] },
  ])("rejects ambiguous package paths for $label", async ({ args }) => {
    const sharedPath = "/tmp/openclaw-ambiguous-update-pack";
    const installRecords = {
      "pack/one": {
        source: "npm" as const,
        spec: "@acme/pack",
        installPath: sharedPath,
      },
      "pack/two": {
        source: "npm" as const,
        spec: "@acme/pack",
        installPath: sharedPath,
      },
    };
    const config = {} as OpenClawConfig;
    primeUpdateConfigSnapshot({ config });
    setInstalledPluginIndexInstallRecords(installRecords);

    await expect(runPluginsCommand(["plugins", "update", ...args])).rejects.toThrow("__exit__:1");

    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it.each([
    ["demo-hooks", undefined],
    ["@acme/demo-hooks", "@acme/demo-hooks"],
  ])("updates tracked hook packs through plugins update (%s)", async (target, specOverride) => {
    const cfg = {} as OpenClawConfig;
    const nextConfig = cfg;

    primeUpdateConfigSnapshot({ config: cfg });
    setHookInstallRecords({
      "demo-hooks": {
        source: "npm",
        spec: "@acme/demo-hooks@1.0.0",
        installPath: "/tmp/hooks/demo-hooks",
        resolvedName: "@acme/demo-hooks",
      },
    });
    primePluginUpdate(cfg);
    updateNpmInstalledHookPacksMock.mockResolvedValue({
      config: nextConfig,
      changed: true,
      outcomes: [
        {
          hookId: "demo-hooks",
          status: "updated",
          message: 'Updated hook pack "demo-hooks": 1.0.0 -> 1.1.0.',
        },
      ],
    });

    await runPluginsCommand(["plugins", "update", target, "--dangerously-force-unsafe-install"]);

    const hookUpdateParams = expectSingleCallParams(updateNpmInstalledHookPacksMock);
    expect(hookUpdateParams.config).toEqual({ ...cfg, plugins: { installs: {} } });
    expect(hookUpdateParams.hookIds).toEqual(["demo-hooks"]);
    expect(hookUpdateParams.specOverrides).toEqual(
      specOverride ? { "demo-hooks": specOverride } : undefined,
    );
    expect(hookUpdateParams.dangerouslyForceUnsafeInstall).toBe(true);
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(configWriteMock).toHaveBeenCalledWith(nextConfig);
    expect(replaceConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig, baseHash: "update-config" }),
    );
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expectRestartNoticeLogged();
  });

  it("uses the mutation-start snapshot for updater input and hook selection", async () => {
    const loadedConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const snapshotConfig = {
      plugins: {
        entries: {
          alpha: { enabled: false },
        },
      },
    } as OpenClawConfig;
    const installRecords = {
      alpha: {
        source: "npm",
        spec: "@openclaw/alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
    } as const;
    primeUpdateConfigSnapshot({
      config: snapshotConfig,
      loadedConfig,
      runtimeConfig: {
        ...snapshotConfig,
        messages: {
          ackReactionScope: "group-mentions",
        },
      },
    });
    setInstalledPluginIndexInstallRecords(installRecords);
    setHookInstallRecords({
      "new-hooks": {
        source: "npm",
        spec: "@acme/new-hooks@1.0.0",
        installPath: "/home/test/.openclaw/hooks/new-hooks",
      },
    });
    updateNpmInstalledPluginsMock.mockImplementation(
      async (params: { config: OpenClawConfig }) => ({
        config: params.config,
        changed: false,
        outcomes: [],
      }),
    );
    updateNpmInstalledHookPacksMock.mockImplementation(
      async (params: { config: OpenClawConfig }) => ({
        config: params.config,
        changed: false,
        outcomes: [],
      }),
    );

    await runPluginsCommand(["plugins", "update", "--all"]);

    const pluginUpdateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    const hookUpdateParams = expectSingleCallParams(updateNpmInstalledHookPacksMock);
    expect(pluginUpdateParams.config).toEqual({
      ...snapshotConfig,
      messages: {
        ackReactionScope: "group-mentions",
      },
      plugins: {
        ...snapshotConfig.plugins,
        installs: installRecords,
      },
    });
    expect(hookUpdateParams.hookIds).toEqual(["new-hooks"]);
  });

  it("uses persisted install records instead of retired config records", async () => {
    const cfg = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const persistedRecords = {
      alpha: {
        source: "npm",
        spec: "@openclaw/alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
    } as const;
    primeUpdateConfigSnapshot({
      config: cfg,
      parsed: {
        plugins: {
          installs: {
            alpha: {
              source: "npm",
              spec: "${PLUGIN_SPEC}",
              installPath: "${PLUGIN_PATH}",
            },
          },
        },
      },
    });
    setInstalledPluginIndexInstallRecords(persistedRecords);
    primePluginUpdate({
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: persistedRecords,
      },
    } as OpenClawConfig);

    await runPluginsCommand(["plugins", "update", "alpha"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.config).toEqual({
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: persistedRecords,
      },
    });
  });

  it("rejects invalid config snapshots before updater side effects", async () => {
    const cfg = createTrackedPluginConfig({
      pluginId: "alpha",
      spec: "@openclaw/alpha@1.0.0",
    });
    primeUpdateConfigSnapshot({
      config: cfg,
      valid: false,
    });
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});

    await expect(runPluginsCommand(["plugins", "update", "alpha"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toBe(
      "Cannot update plugins or hooks while the config is invalid.",
    );
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("allows index-only legacy id migration when an included plugins section has no references", async () => {
    const cfg = { plugins: {} } as OpenClawConfig;
    const pluginRecords = createTrackedPluginConfig({
      pluginId: "voice-call",
      spec: "@openclaw/voice-call@1.0.0",
    }).plugins?.installs;
    const nextConfig = {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: {
          "@openclaw/voice-call": {
            source: "npm",
            spec: "@openclaw/voice-call@1.1.0",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(pluginRecords ?? {});
    primePluginUpdate(
      nextConfig,
      [
        {
          pluginId: "@openclaw/voice-call",
          status: "updated",
          message: "Updated @openclaw/voice-call.",
        },
      ],
      true,
      undefined,
      { "voice-call": "@openclaw/voice-call" },
    );

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(runtimeErrors).toEqual([]);
    expect(updateNpmInstalledPluginsMock).toHaveBeenCalledOnce();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expectInstallRecordsWrittenWithLease(nextConfig.plugins?.installs, cfg);
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("blocks child load-path cleanup beside include-owned plugin config", async () => {
    const pluginId = "@acme/demo";
    const cfg = {
      plugins: {
        load: { paths: ["/tmp/demo/index.js"] },
      },
    } as OpenClawConfig;
    const pluginRecords = {
      [pluginId]: {
        source: "git",
        spec: "https://github.com/acme/demo.git#v1.0.0",
        installPath: "/tmp/demo",
      },
    } as const;
    const nextConfig = {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: pluginRecords,
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(pluginRecords);
    primePluginUpdate(
      nextConfig,
      [{ pluginId, status: "updated", message: `Updated ${pluginId}.` }],
      true,
    );

    await expect(runPluginsCommand(["plugins", "update", pluginId])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("external or unresolved top-level $include");
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("does not rewrite source config for persisted install record-only updates", async () => {
    const cfg = {
      gateway: {
        mode: "local",
        port: 18889,
      },
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
      channels: {
        discord: {
          enabled: true,
        },
      },
      plugins: {
        entries: {
          brave: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const sourceCfg = structuredClone(cfg);
    delete sourceCfg.gateway;
    primeUpdateConfigSnapshot({
      config: cfg,
      parsed: sourceCfg as Record<string, unknown>,
      runtimeConfig: cfg,
      sourceConfig: sourceCfg,
    });
    const { nextRecords } = primeBravePluginRecordUpdate(cfg);

    await runPluginsCommand(["plugins", "update", "brave"]);

    expect(runtimeErrors).toEqual([]);
    expectInstallRecordsWrittenWithLease(nextRecords, sourceCfg);
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
      config: sourceCfg,
      installRecords: nextRecords,
      reason: "source-changed",
    });
    expect(notifyGatewayPluginMetadataChangedMock).toHaveBeenCalledWith(cfg);
    expectRestartNoticeLogged();
  });

  it("commits a moved managed npm load path with its replacement record", async () => {
    const previousInstallPath = "/tmp/openclaw/npm/projects/brave-v1/node_modules/brave";
    const nextInstallPath = "/tmp/openclaw/npm/projects/brave-v2/node_modules/brave";
    const customPath = "/tmp/custom-plugin";
    const cfg = {
      plugins: {
        load: { paths: [previousInstallPath, customPath] },
      },
    } as OpenClawConfig;
    const previousRecords = {
      brave: {
        source: "npm" as const,
        spec: "@openclaw/brave-plugin@1.0.0",
        installPath: previousInstallPath,
      },
    };
    const nextRecords = {
      brave: {
        ...previousRecords.brave,
        spec: "@openclaw/brave-plugin@2.0.0",
        installPath: nextInstallPath,
      },
    };
    const nextConfig = {
      plugins: {
        load: { paths: [nextInstallPath, customPath] },
        installs: nextRecords,
      },
    } as OpenClawConfig;
    primeUpdateConfigSnapshot({ config: cfg });
    setInstalledPluginIndexInstallRecords(previousRecords);
    primePluginUpdate(
      nextConfig,
      [{ pluginId: "brave", status: "updated", message: "Updated brave." }],
      true,
    );

    await runPluginsCommand(["plugins", "update", "brave"]);

    expectInstallRecordsWrittenWithLease(nextRecords, {
      plugins: {
        load: { paths: [nextInstallPath, customPath] },
      },
    });
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: {
        plugins: {
          load: { paths: [nextInstallPath, customPath] },
        },
      },
      baseHash: "update-config",
      writeOptions: expect.objectContaining({
        afterWrite: { mode: "restart", reason: "plugin source changed" },
      }),
    });
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
      config: {
        plugins: {
          load: { paths: [nextInstallPath, customPath] },
        },
      },
      installRecords: nextRecords,
      reason: "source-changed",
    });
    expect(notifyGatewayPluginMetadataChangedMock).not.toHaveBeenCalled();
  });

  it("rolls back persisted install records when source config changes during a records-only update", async () => {
    const cfg = {
      gateway: {
        mode: "local",
        port: 18889,
      },
      plugins: {
        entries: {
          brave: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const changedCfg = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        port: 18890,
      },
    } as OpenClawConfig;
    const initialSnapshot = primeUpdateConfigSnapshot({ config: cfg });
    const changedSnapshot = {
      ...initialSnapshot,
      snapshot: {
        ...initialSnapshot.snapshot,
        raw: JSON.stringify(changedCfg),
        parsed: changedCfg as Record<string, unknown>,
        resolved: changedCfg,
        sourceConfig: changedCfg,
        runtimeConfig: changedCfg,
        config: changedCfg,
        hash: "changed-config",
      },
    };
    readConfigFileSnapshotForWriteMock
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(changedSnapshot);
    const { previousRecords, nextRecords } = primeBravePluginRecordUpdate(cfg);
    const rollback = vi.fn(async () => undefined);
    const commit = vi.fn(async () => undefined);
    primePluginUpdate(
      { ...cfg, plugins: { ...cfg.plugins, installs: nextRecords } },
      [{ pluginId: "brave", status: "updated", message: "Updated brave." }],
      true,
      [{ rollback, commit }],
    );
    const previousPersistedIndex = createTestInstalledPluginIndex({
      policyHash: "previous-policy",
      installRecords: previousRecords,
      plugins: [
        recordInstalledPluginIndexInstallOwner(
          {
            pluginId: "brave",
            manifestPath: "/tmp/brave-beta/openclaw.plugin.json",
            manifestHash: "brave-v1",
            source: "/tmp/brave-beta/index.js",
            rootDir: "/tmp/brave-beta",
            origin: "global",
            enabled: true,
            startup: { sidecar: false, memory: false, agentHarnesses: [] },
            compat: [],
          },
          "brave",
        ),
      ],
    });
    readPersistedInstalledPluginIndexMock.mockResolvedValue(previousPersistedIndex);

    await expect(runPluginsCommand(["plugins", "update", "brave"])).rejects.toThrow(
      "config changed since last load",
    );

    expectInstallRecordsWrittenWithLease(nextRecords, cfg);
    expect(restorePersistedInstalledPluginIndexIfCurrentMock).toHaveBeenCalledWith(
      previousPersistedIndex,
      expect.any(Number),
      expect.objectContaining({
        filePath: expect.any(String),
        lease: expect.anything(),
      }),
    );
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expect(notifyGatewayPluginMetadataChangedMock).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs.join("\n")).not.toContain("Updated");
  });

  it("rolls back persisted install records when included config changes during a records-only update", async () => {
    const includePath = "/tmp/plugins.json5";
    const includeTarget = "/tmp/plugins.json5";
    const cfg = { plugins: {} } as OpenClawConfig;
    const initialSnapshot = primeUpdateConfigSnapshot({
      config: cfg,
      parsed: {
        plugins: {
          $include: includePath,
        },
      },
      includeFileHashesForWrite: {
        [includePath]: "include-start",
      },
      includeFileTargetsForWrite: {
        [includePath]: includeTarget,
      },
    });
    const changedSnapshot = {
      ...initialSnapshot,
      writeOptions: {
        ...initialSnapshot.writeOptions,
        includeFileHashesForWrite: {
          [includePath]: "include-changed",
        },
      },
    };
    readConfigFileSnapshotForWriteMock
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(changedSnapshot);
    const pluginId = "@openclaw/brave-plugin";
    const previousRecords = {
      [pluginId]: {
        source: "npm" as const,
        spec: `${pluginId}@1.0.0`,
        installPath: "/tmp/brave-beta",
      },
    };
    const nextRecords = {
      [pluginId]: {
        ...previousRecords[pluginId],
        spec: `${pluginId}@2.0.0`,
        installPath: "/tmp/brave-stable",
      },
    };
    setInstalledPluginIndexInstallRecords(previousRecords);
    primePluginUpdate(
      { ...cfg, plugins: { installs: nextRecords } },
      [{ pluginId, status: "updated", message: `Updated ${pluginId}.` }],
      true,
    );
    const previousPersistedIndex = createTestInstalledPluginIndex({
      policyHash: "previous-policy",
      installRecords: previousRecords,
    });
    readPersistedInstalledPluginIndexMock.mockResolvedValue(previousPersistedIndex);

    await expect(runPluginsCommand(["plugins", "update", pluginId])).rejects.toThrow(
      "included config changed since last load",
    );

    expectInstallRecordsWrittenWithLease(nextRecords, cfg);
    expect(restorePersistedInstalledPluginIndexIfCurrentMock).toHaveBeenCalledWith(
      previousPersistedIndex,
      expect.any(Number),
      expect.objectContaining({
        filePath: expect.any(String),
        lease: expect.anything(),
      }),
    );
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  });

  it("rolls back persisted install records when records-only update invalidates config", async () => {
    const cfg = {
      plugins: {
        entries: {
          brave: {
            enabled: true,
            config: {
              oldOption: true,
            },
          },
        },
      },
    } as OpenClawConfig;
    const initialSnapshot = primeUpdateConfigSnapshot({ config: cfg });
    const invalidSnapshot = {
      ...initialSnapshot,
      snapshot: {
        ...initialSnapshot.snapshot,
        valid: false,
        issues: [
          {
            path: "plugins.entries.brave.config.oldOption",
            message: "invalid config for plugin brave: must NOT have additional properties",
          },
        ],
      },
    };
    readConfigFileSnapshotForWriteMock
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(invalidSnapshot);
    const { previousRecords, nextRecords } = primeBravePluginRecordUpdate(cfg);
    const previousPersistedIndex = createTestInstalledPluginIndex({
      policyHash: "previous-policy",
      installRecords: previousRecords,
    });
    readPersistedInstalledPluginIndexMock.mockResolvedValue(previousPersistedIndex);

    await expect(runPluginsCommand(["plugins", "update", "brave"])).rejects.toThrow(
      "invalid config for plugin brave",
    );

    expectInstallRecordsWrittenWithLease(nextRecords, cfg);
    expect(restorePersistedInstalledPluginIndexIfCurrentMock).toHaveBeenCalledWith(
      previousPersistedIndex,
      expect.any(Number),
      expect.objectContaining({
        filePath: expect.any(String),
        lease: expect.anything(),
      }),
    );
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  });

  it("blocks legacy plugin id migration before updater side effects", async () => {
    const cfg = {
      plugins: {
        entries: {
          "voice-call": { enabled: true },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      "voice-call": {
        source: "npm",
        spec: "@openclaw/voice-call",
        installPath: "/tmp/voice-call",
      },
    });

    await expect(runPluginsCommand(["plugins", "update", "voice-call"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("blocks catalog-declared plugin id migration before updater side effects", async () => {
    const cfg = {
      plugins: {
        entries: {
          "fish-audio": { enabled: true },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      "fish-audio": {
        source: "npm",
        spec: "@openclaw/fish-audio-speech@2026.7.2-beta.7",
        resolvedName: "@openclaw/fish-audio-speech",
        resolvedSpec: "@openclaw/fish-audio-speech@2026.7.2-beta.7",
        installPath: "/tmp/fish-audio",
      },
    });

    await expect(runPluginsCommand(["plugins", "update", "fish-audio"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("blocks managed npm load-path reconciliation before updater side effects", async () => {
    const installPath = "/tmp/openclaw/npm/projects/demo-v1/node_modules/demo";
    const cfg = {
      plugins: {
        load: { paths: [installPath] },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      demo: {
        source: "npm",
        spec: "@acme/demo@1.0.0",
        installPath,
      },
    });

    await expect(runPluginsCommand(["plugins", "update", "demo"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "ClawHub",
      record: {
        source: "clawhub",
        spec: "clawhub:@openclaw/voice-call",
        clawhubPackage: "@openclaw/voice-call",
        installPath: "/tmp/voice-call",
      },
    },
    {
      label: "git",
      record: {
        source: "git",
        spec: "https://github.com/openclaw/voice-call.git",
        installPath: "/tmp/voice-call",
      },
    },
    {
      label: "marketplace",
      record: {
        source: "marketplace",
        marketplaceSource: "acme",
        marketplacePlugin: "voice-call",
        installPath: "/tmp/voice-call",
      },
    },
  ] as const)(
    "blocks possible $label id migration before updater side effects",
    async ({ record }) => {
      const cfg = {
        plugins: {
          entries: {
            "voice-call": { enabled: true },
          },
        },
      } as OpenClawConfig;
      primeBlockedUpdateConfig("plugins", cfg);
      setInstalledPluginIndexInstallRecords({
        "voice-call": record,
      });

      await expect(runPluginsCommand(["plugins", "update", "voice-call"])).rejects.toThrow(
        "__exit__:1",
      );

      expect(runtimeErrors.at(-1)).toContain(
        "Config plugins are stored in an external or unresolved top-level $include",
      );
      expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
    },
  );

  it("blocks possible legacy id migration when an included plugins section is unresolved", async () => {
    const externalPath = path.join(
      path.parse(process.cwd()).root,
      "external-openclaw",
      "plugins.json5",
    );
    const cfg = { plugins: {} } as OpenClawConfig;
    primeUpdateConfigSnapshot({
      config: cfg,
      parsed: { plugins: { $include: externalPath } },
      sourceConfig: { plugins: { $include: externalPath } } as unknown as OpenClawConfig,
      includeFileTargetsForWrite: {
        [externalPath]: externalPath,
      },
    });
    setInstalledPluginIndexInstallRecords({
      "voice-call": {
        source: "npm",
        spec: "@openclaw/voice-call",
        installPath: "/tmp/voice-call",
      },
    });

    await expect(runPluginsCommand(["plugins", "update", "voice-call"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("ignores retired plugin records during hook-only ownership checks", async () => {
    const cfg = {
      plugins: {
        installs: {
          legacy: {
            source: "npm",
            spec: "@openclaw/legacy@1.0.0",
            installPath: "/tmp/legacy",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setHookInstallRecords({
      "demo-hooks": {
        source: "npm",
        spec: "@acme/demo-hooks@1.0.0",
        installPath: "/tmp/hooks/demo-hooks",
      },
    });

    await runPluginsCommand(["plugins", "update", "demo-hooks"]);

    expect(runtimeErrors).toEqual([]);
    const hookUpdateParams = expectSingleCallParams(updateNpmInstalledHookPacksMock);
    expect(hookUpdateParams.config).toEqual({
      ...cfg,
      plugins: { installs: {} },
    });
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("skips an exact orphan path record during bulk update", async () => {
    const cfg = {
      plugins: {
        installs: {
          linked: {
            source: "path",
            sourcePath: "/tmp/linked",
            installPath: "/tmp/linked",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    primePluginUpdate(cfg, [
      { pluginId: "linked", status: "skipped", message: "Skipping linked." },
    ]);
    const installedIndexModule = await import("../plugins/installed-plugin-index.js");
    const indexSpy = vi.spyOn(installedIndexModule, "loadInstalledPluginIndex").mockReturnValue(
      createTestInstalledPluginIndex({
        policyHash: "orphan-path-update",
        installRecords: cfg.plugins?.installs ?? {},
      }),
    );
    try {
      await runPluginsCommand(["plugins", "update", "--all"]);

      expect(runtimeErrors).toEqual([]);
      expect(updateNpmInstalledPluginsMock).toHaveBeenCalledOnce();
      expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
    } finally {
      indexSpy.mockRestore();
    }
  });

  it("preserves skip behavior for ClawHub records missing package metadata", async () => {
    const cfg = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      demo: {
        source: "clawhub",
        spec: "clawhub:demo",
        installPath: "/tmp/demo",
      },
    });
    primePluginUpdate(cfg, [
      {
        pluginId: "demo",
        status: "skipped",
        message: 'Skipping "demo" (missing ClawHub package metadata).',
      },
    ]);

    await runPluginsCommand(["plugins", "update", "demo"]);

    expect(runtimeErrors).toEqual([]);
    expect(updateNpmInstalledPluginsMock).toHaveBeenCalledOnce();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("exits when update is called without id and without --all", async () => {
    pluginCliConfigMock.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await expect(runPluginsCommand(["plugins", "update"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("Provide a plugin or hook-pack id, or use --all.");
    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
  });

  it("reports no tracked plugins or hook packs when update --all has empty install records", async () => {
    pluginCliConfigMock.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs.at(-1)).toBe("No tracked plugins or hook packs to update.");
  });

  it("passes dangerous force unsafe install to plugin updates", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "openclaw-codex-app-server@beta",
    });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand([
      "plugins",
      "update",
      "openclaw-codex-app-server",
      "--dangerously-force-unsafe-install",
    ]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.config).toEqual(config);
    expect(updateParams.pluginIds).toEqual(["openclaw-codex-app-server"]);
    expect(updateParams.dangerouslyForceUnsafeInstall).toBe(true);
    expect(
      pluginsCliRuntimeLogs.filter((message) =>
        message.includes(
          "--dangerously-force-unsafe-install is deprecated and no longer affects plugin updates",
        ),
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      updateChannel: "beta" as const,
      registryLine: "beta",
      spec: "@openclaw/codex@2026.6.8-beta.1",
    },
    {
      updateChannel: "stable" as const,
      registryLine: "latest",
      spec: "@openclaw/codex@2026.5.28",
    },
  ])(
    "passes the $updateChannel channel to probe $registryLine for targeted exact pins",
    async ({ updateChannel, spec }) => {
      const config = createTrackedPluginConfig({
        pluginId: "codex",
        spec,
        resolvedName: "@openclaw/codex",
      });
      config.update = { channel: updateChannel };
      pluginCliConfigMock.mockReturnValue(config);
      setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
      primePluginUpdate(config);

      await runPluginsCommand(["plugins", "update", "codex"]);

      const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
      expect(updateParams.pluginIds).toEqual(["codex"]);
      expect(updateParams.syncOfficialPluginInstalls).toBeUndefined();
      expect(updateParams.updateChannel).toBe(updateChannel);
      expect(updateParams.officialPluginUpdateChannel).toBe(
        resolveRegistryUpdateChannel({ configChannel: updateChannel, currentVersion: VERSION }),
      );
    },
  );

  it("passes the inferred core channel to a targeted update without enabling catalog sync", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex",
      resolvedName: "@openclaw/codex",
    });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "codex"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.syncOfficialPluginInstalls).toBeUndefined();
    expect(updateParams.updateChannel).toBeUndefined();
    expect(updateParams.officialPluginUpdateChannel).toBe(
      resolveRegistryUpdateChannel({ currentVersion: VERSION }),
    );
  });

  it("syncs official catalog specs with beta channel context for update --all", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex@2026.6.8-beta.1",
      resolvedName: "@openclaw/codex",
    });
    config.update = { channel: "beta" };
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "--all"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.pluginIds).toEqual(["codex"]);
    expect(updateParams.syncOfficialPluginInstalls).toBe(true);
    expect(updateParams.officialPluginUpdateChannel).toBe("beta");
    expect(updateParams.updateChannel).toBeUndefined();
  });

  it("infers the official catalog channel from the installed core for update --all", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex",
      resolvedName: "@openclaw/codex",
    });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "--all"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.officialPluginUpdateChannel).toBe(
      resolveRegistryUpdateChannel({ currentVersion: VERSION }),
    );
  });

  it("passes extended-stable channel and installed core version to update --all", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex",
      resolvedName: "@openclaw/codex",
    });
    config.update = { channel: "extended-stable" };
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        officialPluginUpdateChannel: "extended-stable",
        syncOfficialPluginInstalls: true,
        coreVersion: expect.any(String),
      }),
    );
  });

  it("binds explicit update acceptance to the reviewed capability surface", async () => {
    setTty(false);
    const config = createTrackedPluginConfig({ pluginId: "alpha", spec: "@acme/alpha" });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "alpha", "--accept-capabilities"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.pluginIds).toEqual(["alpha"]);
    expect(updateParams).not.toHaveProperty("acknowledgeCapabilities");
    const consent = updateParams.onCapabilityConsent;
    if (typeof consent !== "function") {
      throw new Error("expected explicit plugin capability consent callback");
    }
    await expect(consent(createCapabilityConsentReview())).resolves.toEqual({
      reviewToken: "reviewed-alpha-surface",
    });
    expect(promptYesNoMock).not.toHaveBeenCalled();
  });

  it("shows widened capabilities and requests consent for interactive plugin updates", async () => {
    setTty(true);
    const config = createTrackedPluginConfig({ pluginId: "alpha", spec: "@acme/alpha" });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "alpha"]);

    const consent = expectSingleCallParams(updateNpmInstalledPluginsMock).onCapabilityConsent;
    if (typeof consent !== "function") {
      throw new Error("expected interactive plugin capability consent callback");
    }
    await expect(consent(createCapabilityConsentReview())).resolves.toEqual({
      reviewToken: "reviewed-alpha-surface",
    });

    expect(pluginsCliRuntimeLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Alpha plugin (alpha) @ 2.0.0"),
        expect.stringContaining("Integrity: sha512-alpha"),
        expect.stringContaining("Contracts: gatewayMethodDispatch: alpha.run"),
        expect.stringContaining("New tools: write"),
        expect.stringContaining("Conversation access: denied"),
        expect.stringContaining("Trust: review-recommended"),
      ]),
    );
    expect(promptYesNoMock).toHaveBeenCalledWith('Accept these capabilities and update "alpha"?');
  });

  it("does not pass an interactive ClawHub risk prompt to dry-run plugin updates", async () => {
    setTty(true);
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "clawhub:openclaw-codex-app-server",
    });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "openclaw-codex-app-server", "--dry-run"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.dryRun).toBe(true);
    expect(updateParams.onInstallPolicyWarning).toBeUndefined();
    expect(updateParams.onCapabilityConsent).toBeUndefined();
  });

  it("passes an install-policy warning prompt to interactive plugin updates", async () => {
    setTty(true);
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "openclaw-codex-app-server",
    });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    updateNpmInstalledPluginsMock.mockResolvedValue({ config, changed: false, outcomes: [] });

    await runPluginsCommand(["plugins", "update", "openclaw-codex-app-server"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.onInstallPolicyWarning).toEqual(expect.any(Function));
  });

  it("passes noninteractive install-policy acknowledgement to plugin updates", async () => {
    setTty(false);
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "openclaw-codex-app-server",
    });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    updateNpmInstalledPluginsMock.mockResolvedValue({ config, changed: false, outcomes: [] });

    await runPluginsCommand([
      "plugins",
      "update",
      "openclaw-codex-app-server",
      "--acknowledge-install-policy-warning",
    ]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.onInstallPolicyWarning).toEqual(expect.any(Function));
  });

  it("shares invocation-wide install-policy acknowledgement across bulk plugin and hook updates", async () => {
    setTty(false);
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "openclaw-codex-app-server",
    });
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    setHookInstallRecords({
      "demo-hooks": {
        source: "npm",
        spec: "@acme/demo-hooks@1.0.0",
        installPath: "/tmp/hooks/demo-hooks",
      },
    });
    primePluginUpdate(config);
    updateNpmInstalledHookPacksMock.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runPluginsCommand(["plugins", "update", "--all", "--acknowledge-install-policy-warning"]);

    const pluginAcknowledgement = expectSingleCallParams(
      updateNpmInstalledPluginsMock,
    ).onInstallPolicyWarning;
    const hookAcknowledgement = expectSingleCallParams(
      updateNpmInstalledHookPacksMock,
    ).onInstallPolicyWarning;
    if (typeof pluginAcknowledgement !== "function") {
      throw new Error("expected plugin install-policy acknowledgement callback");
    }
    expect(hookAcknowledgement).toBe(pluginAcknowledgement);
    await expect(
      pluginAcknowledgement({
        targetName: "openclaw-codex-app-server",
        targetType: "plugin",
        requestMode: "update",
      }),
    ).resolves.toEqual({ status: "approved" });
    await expect(
      pluginAcknowledgement({
        targetName: "demo-hooks",
        targetType: "plugin",
        requestMode: "update",
      }),
    ).resolves.toEqual({ status: "approved" });
  });

  it("keeps durable state when transaction cleanup fails after the write", async () => {
    const cfg = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const previousRecords = {
      alpha: {
        source: "npm" as const,
        spec: "@openclaw/alpha@1.0.0",
      },
    };
    const nextRecords = {
      alpha: {
        source: "npm" as const,
        spec: "@openclaw/alpha@1.1.0",
      },
    };
    const runtimeConfig = {
      ...cfg,
      messages: {
        ackReactionScope: "group-mentions",
      },
    } as OpenClawConfig;
    const nextRuntimeConfig = {
      ...runtimeConfig,
      plugins: {
        ...runtimeConfig.plugins,
        installs: nextRecords,
      },
      messages: runtimeConfig.messages,
    } as OpenClawConfig;
    primeUpdateConfigSnapshot({
      config: cfg,
      runtimeConfig,
      includeFileHashesForWrite: {
        "/tmp/plugins.json5": "plugins-start-hash",
      },
    });
    setInstalledPluginIndexInstallRecords(previousRecords);
    const rollback = vi.fn(async () => undefined);
    const failedCommit = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const remainingCommit = vi.fn(async () => undefined);
    primePluginUpdate(
      nextRuntimeConfig,
      [{ pluginId: "alpha", status: "updated", message: "Updated alpha -> 1.1.0" }],
      true,
      [
        { commit: failedCommit, rollback },
        { commit: remainingCommit, rollback },
      ],
    );
    updateNpmInstalledHookPacksMock.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: nextRuntimeConfig,
    });

    await runPluginsCommand(["plugins", "update", "alpha"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPluginsMock);
    expect(updateParams.config).toEqual({
      ...runtimeConfig,
      plugins: {
        ...runtimeConfig.plugins,
        installs: previousRecords,
      },
    });
    expect(updateParams.pluginIds).toEqual(["alpha"]);
    expect(updateParams.dryRun).toBe(false);
    expectInstallRecordsWrittenWithLease(nextRecords, cfg);
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(failedCommit).toHaveBeenCalledOnce();
    expect(remainingCommit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
      config: cfg,
      installRecords: nextRecords,
      reason: "source-changed",
    });
    expect(notifyGatewayPluginMetadataChangedMock).toHaveBeenCalledWith(runtimeConfig);
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Plugin update committed");
    expect(pluginsCliRuntimeLogs).toContain("Updated alpha -> 1.1.0");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Restart is required");
    expectRestartNoticeLogged();
  });

  it("exits non-zero when a plugin update reports an error after persisting successes", async () => {
    const cfg = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.0.0",
          },
          beta: {
            source: "npm",
            spec: "@openclaw/beta@1.0.0",
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.1.0",
          },
          beta: {
            source: "npm",
            spec: "@openclaw/beta@1.0.0",
          },
        },
      },
    } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(cfg);
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    primePluginUpdate(
      nextConfig,
      [
        { pluginId: "alpha", status: "updated", message: "Updated alpha -> 1.1.0" },
        {
          pluginId: "beta",
          status: "error",
          message: "Failed to update beta: registry timeout",
          channelFallback: {
            requestedSpec: "@openclaw/beta@beta",
            usedSpec: "@openclaw/beta@latest",
            requestedLabel: "beta",
            usedLabel: "latest",
            reason: "failed",
            message: "Beta channel unavailable; tried latest.",
          },
        },
      ],
      true,
    );
    updateNpmInstalledHookPacksMock.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: nextConfig,
    });

    await expect(runPluginsCommand(["plugins", "update", "--all"])).rejects.toThrow("__exit__:1");

    expectInstallRecordsWrittenWithLease(nextConfig.plugins?.installs, {});
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
      config: {},
      installRecords: nextConfig.plugins?.installs,
      reason: "source-changed",
    });
    expect(runtimeErrors).toContain("Failed to update beta: registry timeout");
    expect(pluginsCliRuntimeLogs).toContain("Updated alpha -> 1.1.0");
    expect(pluginsCliRuntimeLogs).toContain("Beta channel unavailable; tried latest.");
    expect(pluginsCliRuntimeLogs).not.toContain("Failed to update beta: registry timeout");
  });

  it("exits non-zero when a ClawHub update is skipped because the target release is blocked", async () => {
    await expectSkippedClawHubPluginUpdate({
      code: "clawhub_download_blocked",
      message:
        "Skipped demo ClawHub update: ClawHub blocked this release; update was not started. Existing installed plugin left unchanged.",
      expectedLog: "ClawHub blocked this release",
    });
  });

  it("exits non-zero when a ClawHub update is skipped because security data is unavailable", async () => {
    await expectSkippedClawHubPluginUpdate({
      code: "clawhub_security_unavailable",
      message:
        'Skipped demo ClawHub update: ClawHub security data for "@openclaw/plugin-demo@1.1.0" is unavailable, so OpenClaw left the existing installed plugin unchanged. Try again later or choose a different version.',
      expectedLog: "security data",
    });
  });

  it("exits non-zero when a hook pack update reports an error", async () => {
    const cfg = {} as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(cfg);
    setHookInstallRecords({
      "demo-hooks": {
        source: "npm",
        spec: "@acme/demo-hooks@1.0.0",
        installPath: "/tmp/hooks/demo-hooks",
        resolvedName: "@acme/demo-hooks",
      },
    });
    primePluginUpdate(cfg);
    updateNpmInstalledHookPacksMock.mockResolvedValue({
      config: cfg,
      changed: false,
      outcomes: [
        {
          hookId: "demo-hooks",
          status: "error",
          message: 'Failed to update hook pack "demo-hooks": registry timeout',
        },
      ],
    });

    await expect(runPluginsCommand(["plugins", "update", "demo-hooks"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors).toContain('Failed to update hook pack "demo-hooks": registry timeout');
    expect(pluginsCliRuntimeLogs).not.toContain(
      'Failed to update hook pack "demo-hooks": registry timeout',
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
