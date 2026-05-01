import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, ModelDefinitionConfig, OpenClawConfig } from "../config/types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn((params: { config: OpenClawConfig }) => ({
    config: params.config,
    changes: [] as string[],
    autoEnabledReasons: {} as Record<string, string[]>,
  })),
);
const configMocks = vi.hoisted(() => ({
  isNixMode: { value: false },
}));
const pluginManifestRegistry = vi.hoisted(() => ({ plugins: [], diagnostics: [] }));
const pluginMetadataSnapshot = vi.hoisted(
  (): PluginMetadataSnapshot => ({
    policyHash: "policy",
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "policy",
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: pluginManifestRegistry,
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  }),
);
vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotWithPluginMetadata: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
  recoverConfigFromJsonRootSuffix: vi.fn(),
  writeConfigFile: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  get isNixMode() {
    return configMocks.isNixMode.value;
  },
  resolveStateDir: vi.fn(() => "/tmp/openclaw-state"),
}));

vi.mock("../config/runtime-overrides.js", () => ({
  applyConfigOverrides: vi.fn((config: OpenClawConfig) => config),
}));

vi.mock("../config/recovery-policy.js", () => ({
  isPluginLocalInvalidConfigSnapshot: vi.fn((snapshot: ConfigFileSnapshot) => {
    if (snapshot.valid || snapshot.legacyIssues.length > 0 || snapshot.issues.length === 0) {
      return false;
    }
    return snapshot.issues.every((issue) => issue.path.startsWith("plugins.entries."));
  }),
  shouldAttemptLastKnownGoodRecovery: vi.fn((snapshot: ConfigFileSnapshot) => {
    if (snapshot.valid) {
      return false;
    }
    return !(
      snapshot.legacyIssues.length === 0 &&
      snapshot.issues.length > 0 &&
      snapshot.issues.every((issue) => issue.path.startsWith("plugins.entries."))
    );
  }),
}));

vi.mock("../config/mutate.js", () => ({
  replaceConfigFile: vi.fn(),
}));

vi.mock("../config/validation.js", () => ({
  validateConfigObjectWithPlugins: vi.fn((config: OpenClawConfig) => ({
    ok: true,
    config,
    warnings: [],
  })),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: { config: OpenClawConfig }) => applyPluginAutoEnable(params),
}));

vi.mock("./config-recovery-notice.js", () => ({
  enqueueConfigRecoveryNotice: vi.fn(),
}));

let loadGatewayStartupConfigSnapshot: typeof import("./server-startup-config.js").loadGatewayStartupConfigSnapshot;
let configIo: typeof import("../config/io.js");
let configMutate: typeof import("../config/mutate.js");
let recoveryNotice: typeof import("./config-recovery-notice.js");

const configPath = "/tmp/openclaw-startup-recovery.json";
const validConfig = {
  gateway: {
    mode: "local",
  },
} as OpenClawConfig;

function testModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 8192,
    maxTokens: 4096,
  };
}

function buildSnapshot(params: {
  valid: boolean;
  raw: string;
  config?: OpenClawConfig;
}): ConfigFileSnapshot {
  return buildTestConfigSnapshot({
    path: configPath,
    exists: true,
    raw: params.raw,
    parsed: params.config ?? null,
    valid: params.valid,
    config: params.config ?? ({} as OpenClawConfig),
    issues: params.valid ? [] : [{ path: "gateway.mode", message: "Expected 'local' or 'remote'" }],
    legacyIssues: [],
  });
}

describe("gateway startup config recovery", () => {
  beforeAll(async () => {
    ({ loadGatewayStartupConfigSnapshot } = await import("./server-startup-config.js"));
    configIo = await import("../config/io.js");
    configMutate = await import("../config/mutate.js");
    recoveryNotice = await import("./config-recovery-notice.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.isNixMode.value = false;
    vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata).mockImplementation(async () => ({
      snapshot: await vi.mocked(configIo.readConfigFileSnapshot)(),
    }));
  });

  it("runs startup plugin auto-enable against source config without persisting runtime defaults", async () => {
    const sourceConfig = {
      browser: { enabled: false },
      gateway: { mode: "local" },
      plugins: {
        allow: ["bench-plugin"],
        entries: {
          browser: { enabled: false },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      ...sourceConfig,
      plugins: {
        ...sourceConfig.plugins,
        entries: {
          ...sourceConfig.plugins?.entries,
          "memory-core": {
            config: {
              dreaming: {
                enabled: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const snapshot = {
      ...buildTestConfigSnapshot({
        path: configPath,
        exists: true,
        raw: `${JSON.stringify(sourceConfig)}\n`,
        parsed: sourceConfig,
        valid: true,
        config: runtimeConfig,
        issues: [],
        legacyIssues: [],
      }),
      sourceConfig,
      resolved: sourceConfig,
      runtimeConfig,
      config: runtimeConfig,
    } satisfies ConfigFileSnapshot;
    vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata).mockResolvedValueOnce({
      snapshot,
      pluginMetadataSnapshot,
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: false,
        log,
      }),
    ).resolves.toEqual({
      snapshot,
      wroteConfig: false,
      pluginMetadataSnapshot,
    });

    expect(configIo.readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(1);
    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
      manifestRegistry: pluginManifestRegistry,
    });
    expect(configMutate.replaceConfigFile).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("preserves empty model allowlist entries through startup auto-enable writes", async () => {
    const sourceConfig = {
      agents: {
        defaults: {
          model: { primary: "dos-ai/dos-ai" },
          models: {
            "dos-ai/dos-ai": {},
            "dos-ai/dos-auto": {},
          },
        },
      },
      gateway: { mode: "local" },
      models: {
        mode: "replace",
        providers: {
          "dos-ai": {
            baseUrl: "https://dos.example.test/v1",
            apiKey: "test-key",
            api: "openai-completions",
            models: [testModel("dos-ai", "DOS AI"), testModel("dos-auto", "DOS Auto")],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const autoEnabledConfig = {
      ...sourceConfig,
      channels: {
        telegram: { enabled: true },
      },
    } as unknown as OpenClawConfig;
    const initialSnapshot = {
      ...buildTestConfigSnapshot({
        path: configPath,
        exists: true,
        raw: `${JSON.stringify(sourceConfig)}\n`,
        parsed: sourceConfig,
        valid: true,
        config: sourceConfig,
        issues: [],
        legacyIssues: [],
      }),
      sourceConfig,
      resolved: sourceConfig,
      runtimeConfig: sourceConfig,
      config: sourceConfig,
    } satisfies ConfigFileSnapshot;
    const postWriteSnapshot = {
      ...buildTestConfigSnapshot({
        path: configPath,
        exists: true,
        raw: `${JSON.stringify(autoEnabledConfig)}\n`,
        parsed: autoEnabledConfig,
        valid: true,
        config: autoEnabledConfig,
        issues: [],
        legacyIssues: [],
      }),
      sourceConfig: autoEnabledConfig,
      resolved: autoEnabledConfig,
      runtimeConfig: autoEnabledConfig,
      config: autoEnabledConfig,
    } satisfies ConfigFileSnapshot;
    vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata)
      .mockResolvedValueOnce({
        snapshot: initialSnapshot,
        pluginMetadataSnapshot,
      })
      .mockResolvedValueOnce({
        snapshot: postWriteSnapshot,
        pluginMetadataSnapshot,
      });
    applyPluginAutoEnable.mockReturnValueOnce({
      config: autoEnabledConfig,
      changes: ["Telegram configured, enabled automatically."],
      autoEnabledReasons: {},
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: false,
        log,
      }),
    ).resolves.toEqual({
      snapshot: postWriteSnapshot,
      wroteConfig: true,
      pluginMetadataSnapshot,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
      manifestRegistry: pluginManifestRegistry,
    });
    expect(configMutate.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            models: {
              "dos-ai/dos-ai": {},
              "dos-ai/dos-auto": {},
            },
          }),
        }),
      }),
      afterWrite: { mode: "auto" },
    });
    expect(postWriteSnapshot.sourceConfig.agents?.defaults?.models).toEqual({
      "dos-ai/dos-ai": {},
      "dos-ai/dos-auto": {},
    });
    expect(postWriteSnapshot.config.agents?.defaults?.models).toEqual({
      "dos-ai/dos-ai": {},
      "dos-ai/dos-auto": {},
    });
  });

  it("restores last-known-good config before startup validation", async () => {
    const invalidSnapshot = buildSnapshot({ valid: false, raw: "{ invalid json" });
    const recoveredSnapshot = buildSnapshot({
      valid: true,
      raw: `${JSON.stringify(validConfig)}\n`,
      config: validConfig,
    });
    vi.mocked(configIo.readConfigFileSnapshot)
      .mockResolvedValueOnce(invalidSnapshot)
      .mockResolvedValueOnce(recoveredSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(true);
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log,
      }),
    ).resolves.toEqual({
      snapshot: recoveredSnapshot,
      wroteConfig: true,
    });

    expect(configIo.recoverConfigFromLastKnownGood).toHaveBeenCalledWith({
      snapshot: invalidSnapshot,
      reason: "startup-invalid-config",
    });
    expect(log.warn).toHaveBeenCalledWith(
      `gateway: invalid config was restored from last-known-good backup: ${configPath}; Rejected validation details: gateway.mode: Expected 'local' or 'remote'.`,
    );
    expect(recoveryNotice.enqueueConfigRecoveryNotice).toHaveBeenCalledWith({
      cfg: recoveredSnapshot.config,
      phase: "startup",
      reason: "startup-invalid-config",
      configPath,
      issues: [{ path: "gateway.mode", message: "Expected 'local' or 'remote'" }],
    });
  });

  it("keeps startup validation loud when last-known-good recovery is unavailable", async () => {
    const invalidSnapshot = buildSnapshot({ valid: false, raw: "{ invalid json" });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(false);
    vi.mocked(configIo.recoverConfigFromJsonRootSuffix).mockResolvedValueOnce(false);

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(
      `Invalid config at ${configPath}.\ngateway.mode: Expected 'local' or 'remote'\nRun "openclaw doctor --fix" to repair, then retry.`,
    );

    expect(recoveryNotice.enqueueConfigRecoveryNotice).not.toHaveBeenCalled();
  });

  it("rejects legacy config entries in Nix mode before recovery", async () => {
    const legacySnapshot = buildTestConfigSnapshot({
      path: configPath,
      exists: true,
      raw: `${JSON.stringify({
        heartbeat: { model: "anthropic/claude-3-5-haiku-20241022", every: "30m" },
      })}\n`,
      parsed: {
        heartbeat: { model: "anthropic/claude-3-5-haiku-20241022", every: "30m" },
      },
      valid: false,
      config: {} as OpenClawConfig,
      issues: [
        {
          path: "heartbeat",
          message:
            "top-level heartbeat is not a valid config path; use agents.defaults.heartbeat (cadence/target/model settings) or channels.defaults.heartbeat (showOk/showAlerts/useIndicator).",
        },
      ],
      legacyIssues: [
        {
          path: "heartbeat",
          message:
            "top-level heartbeat is not a valid config path; use agents.defaults.heartbeat (cadence/target/model settings) or channels.defaults.heartbeat (showOk/showAlerts/useIndicator).",
        },
      ],
    });
    vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata).mockResolvedValueOnce({
      snapshot: legacySnapshot,
      pluginMetadataSnapshot,
    });
    configMocks.isNixMode.value = true;

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(
      "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
    );

    expect(configIo.recoverConfigFromLastKnownGood).not.toHaveBeenCalled();
    expect(configIo.recoverConfigFromJsonRootSuffix).not.toHaveBeenCalled();
    expect(recoveryNotice.enqueueConfigRecoveryNotice).not.toHaveBeenCalled();
  });

  it("continues startup in degraded mode for plugin-local startup invalidity", async () => {
    const invalidSnapshot = buildTestConfigSnapshot({
      path: configPath,
      exists: true,
      raw: `${JSON.stringify({
        gateway: { mode: "local" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      })}\n`,
      parsed: {
        gateway: { mode: "local" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      },
      valid: false,
      config: {
        gateway: { mode: "local" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      } as OpenClawConfig,
      issues: [
        {
          path: "plugins.entries.feishu",
          message:
            "plugin feishu: plugin requires OpenClaw >=2026.4.23, but this host is 2026.4.22; skipping load",
        },
      ],
      legacyIssues: [],
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log,
      }),
    ).resolves.toEqual({
      snapshot: expect.objectContaining({
        valid: true,
        issues: [],
        warnings: invalidSnapshot.issues,
      }),
      wroteConfig: false,
      degradedPluginConfig: true,
    });

    expect(configIo.recoverConfigFromLastKnownGood).not.toHaveBeenCalled();
    expect(configIo.recoverConfigFromJsonRootSuffix).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      `gateway: skipped plugin config validation issue at plugins.entries.feishu: plugin feishu: plugin requires OpenClaw >=2026.4.23, but this host is 2026.4.22; skipping load. Run "openclaw doctor --fix" to quarantine the plugin config.`,
    );
    expect(recoveryNotice.enqueueConfigRecoveryNotice).not.toHaveBeenCalled();
  });

  it("keeps mixed plugin and core startup invalidity fatal", async () => {
    const invalidSnapshot = buildTestConfigSnapshot({
      path: configPath,
      exists: true,
      raw: `${JSON.stringify({
        gateway: { mode: "invalid" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      })}\n`,
      parsed: {
        gateway: { mode: "invalid" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      },
      valid: false,
      config: {
        gateway: { mode: "invalid" },
        plugins: {
          entries: {
            feishu: { enabled: true },
          },
        },
      } as unknown as OpenClawConfig,
      issues: [
        {
          path: "gateway.mode",
          message: "Expected 'local' or 'remote'",
        },
        {
          path: "plugins.entries.feishu.config.token",
          message: "invalid config: must be string",
        },
      ],
      legacyIssues: [],
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(false);
    vi.mocked(configIo.recoverConfigFromJsonRootSuffix).mockResolvedValueOnce(false);

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(`Invalid config at ${configPath}.`);

    expect(configIo.recoverConfigFromLastKnownGood).toHaveBeenCalledWith({
      snapshot: invalidSnapshot,
      reason: "startup-invalid-config",
    });
  });

  it("skips providers with stale model api enum values during startup", async () => {
    const config = {
      gateway: { mode: "local" },
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai",
            models: [
              {
                id: "openai/gpt-4o-mini",
                name: "OpenRouter GPT-4o Mini",
                api: "openai",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            api: "anthropic-messages",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const invalidSnapshot = buildTestConfigSnapshot({
      path: configPath,
      exists: true,
      raw: `${JSON.stringify(config)}\n`,
      parsed: config,
      valid: false,
      config,
      issues: [
        {
          path: "models.providers.openrouter.api",
          message:
            'Invalid option: expected one of "openai-completions"|"openai-responses"|"openai-codex-responses"|"anthropic-messages"|"google-generative-ai"|"github-copilot"|"bedrock-converse-stream"|"ollama"|"azure-openai-responses"',
        },
        {
          path: "models.providers.openrouter.models.0.api",
          message:
            'Invalid option: expected one of "openai-completions"|"openai-responses"|"openai-codex-responses"|"anthropic-messages"|"google-generative-ai"|"github-copilot"|"bedrock-converse-stream"|"ollama"|"azure-openai-responses"',
        },
      ],
      legacyIssues: [],
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await loadGatewayStartupConfigSnapshot({
      minimalTestGateway: false,
      log,
    });

    expect(result.wroteConfig).toBe(false);
    expect(result.degradedProviderApi).toBe(true);
    expect(result.snapshot.valid).toBe(true);
    expect(result.snapshot.sourceConfig.models?.providers?.openrouter).toBeUndefined();
    expect(result.snapshot.sourceConfig.models?.providers?.anthropic).toEqual(
      config.models?.providers?.anthropic,
    );
    expect(configIo.recoverConfigFromLastKnownGood).not.toHaveBeenCalled();
    expect(configMutate.replaceConfigFile).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'gateway: skipped model provider openrouter; configured provider api is invalid. Run "openclaw doctor --fix" to repair the config.',
    );
  });

  it("strips a valid JSON suffix when last-known-good recovery is unavailable", async () => {
    const invalidSnapshot = buildSnapshot({
      valid: false,
      raw: `Found and updated: False\n${JSON.stringify(validConfig)}\n`,
    });
    const repairedSnapshot = buildSnapshot({
      valid: true,
      raw: `${JSON.stringify(validConfig)}\n`,
      config: validConfig,
    });
    vi.mocked(configIo.readConfigFileSnapshot)
      .mockResolvedValueOnce(invalidSnapshot)
      .mockResolvedValueOnce(repairedSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(false);
    vi.mocked(configIo.recoverConfigFromJsonRootSuffix).mockResolvedValueOnce(true);
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log,
      }),
    ).resolves.toEqual({
      snapshot: repairedSnapshot,
      wroteConfig: true,
    });

    expect(configIo.recoverConfigFromJsonRootSuffix).toHaveBeenCalledWith(invalidSnapshot);
    expect(log.warn).toHaveBeenCalledWith(
      `gateway: invalid config was repaired by stripping a non-JSON prefix: ${configPath}`,
    );
  });
});
