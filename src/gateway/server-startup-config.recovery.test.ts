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

vi.mock("../config/mutate.js", () => ({
  replaceConfigFile: vi.fn(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: { config: OpenClawConfig }) => applyPluginAutoEnable(params),
}));

let loadGatewayStartupConfigSnapshot: typeof import("./server-startup-config.js").loadGatewayStartupConfigSnapshot;
let configIo: typeof import("../config/io.js");
let configMutate: typeof import("../config/mutate.js");

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

function buildDefaultSnapshot(): ConfigFileSnapshot {
  return buildSnapshot({
    valid: true,
    raw: `${JSON.stringify(validConfig)}\n`,
    config: validConfig,
  });
}

function installConfigIoMockDefaults() {
  const readSnapshot = vi.mocked(configIo.readConfigFileSnapshot);
  const readSnapshotWithPluginMetadata = vi.mocked(
    configIo.readConfigFileSnapshotWithPluginMetadata,
  );
  const writeConfig = vi.mocked(configIo.writeConfigFile);

  readSnapshot.mockReset();
  readSnapshotWithPluginMetadata.mockReset();
  writeConfig.mockReset();

  const defaultSnapshot = buildDefaultSnapshot();
  readSnapshot.mockResolvedValue(defaultSnapshot);
  readSnapshotWithPluginMetadata.mockImplementation(async () => {
    const snapshot = (await readSnapshot()) as ConfigFileSnapshot | undefined;
    if (!snapshot) {
      throw new Error(
        "configIo.readConfigFileSnapshot mock returned no snapshot; " +
          "mock readConfigFileSnapshotWithPluginMetadata with { snapshot, pluginMetadataSnapshot }.",
      );
    }
    return snapshot.valid ? { snapshot, pluginMetadataSnapshot } : { snapshot };
  });
  writeConfig.mockResolvedValue(undefined);
}

describe("gateway startup config validation", () => {
  beforeAll(async () => {
    ({ loadGatewayStartupConfigSnapshot } = await import("./server-startup-config.js"));
    configIo = await import("../config/io.js");
    configMutate = await import("../config/mutate.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.isNixMode.value = false;
    installConfigIoMockDefaults();
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

  it("reuses a CLI preflight snapshot without rereading config", async () => {
    const snapshot = buildTestConfigSnapshot({
      path: configPath,
      exists: true,
      raw: `${JSON.stringify(validConfig)}\n`,
      parsed: validConfig,
      valid: true,
      config: validConfig,
      issues: [],
      legacyIssues: [],
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: false,
        log,
        initialSnapshotRead: {
          snapshot,
          pluginMetadataSnapshot,
        },
      }),
    ).resolves.toEqual({
      snapshot,
      wroteConfig: false,
      pluginMetadataSnapshot,
    });

    expect(configIo.readConfigFileSnapshotWithPluginMetadata).not.toHaveBeenCalled();
    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: validConfig,
      env: process.env,
      manifestRegistry: pluginManifestRegistry,
    });
  });

  it("preserves empty model allowlist entries through runtime-only startup auto-enable", async () => {
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
    vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata).mockResolvedValueOnce({
      snapshot: initialSnapshot,
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
      snapshot: {
        ...initialSnapshot,
        runtimeConfig: autoEnabledConfig,
        config: autoEnabledConfig,
      },
      wroteConfig: false,
      pluginMetadataSnapshot,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
      manifestRegistry: pluginManifestRegistry,
    });
    expect(configMutate.replaceConfigFile).not.toHaveBeenCalled();
    expect(configIo.readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(1);
    expect(initialSnapshot.sourceConfig.agents?.defaults?.models).toEqual({
      "dos-ai/dos-ai": {},
      "dos-ai/dos-auto": {},
    });
    expect(initialSnapshot.sourceConfig.channels?.telegram).toBeUndefined();
    expect(autoEnabledConfig.agents?.defaults?.models).toEqual({
      "dos-ai/dos-ai": {},
      "dos-ai/dos-auto": {},
    });
    expect(autoEnabledConfig.channels?.telegram).toEqual({
      enabled: true,
    });
    expect(log.info).toHaveBeenCalledWith(
      "gateway: auto-enabled plugins for this runtime without writing config:\n- Telegram configured, enabled automatically.",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps plugin auto-enable runtime-only in Nix mode", async () => {
    const sourceConfig = {
      channels: {
        telegram: {
          botToken: "test-token",
        },
      },
      gateway: { mode: "local" },
    } as unknown as OpenClawConfig;
    const autoEnabledConfig = {
      ...sourceConfig,
      plugins: {
        allow: ["telegram"],
      },
    } as unknown as OpenClawConfig;
    const snapshot = {
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
    vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata).mockResolvedValueOnce({
      snapshot,
      pluginMetadataSnapshot,
    });
    applyPluginAutoEnable.mockReturnValueOnce({
      config: autoEnabledConfig,
      changes: ["Telegram configured, enabled automatically."],
      autoEnabledReasons: {},
    });
    configMocks.isNixMode.value = true;
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: false,
        log,
      }),
    ).resolves.toEqual({
      snapshot: {
        ...snapshot,
        runtimeConfig: autoEnabledConfig,
        config: autoEnabledConfig,
      },
      wroteConfig: false,
      pluginMetadataSnapshot,
    });

    expect(configMutate.replaceConfigFile).not.toHaveBeenCalled();
    expect(configIo.readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "gateway: auto-enabled plugins for this runtime without writing config:\n- Telegram configured, enabled automatically.",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rejects invalid config before startup without automatic recovery", async () => {
    const invalidSnapshot = buildSnapshot({ valid: false, raw: "{ invalid json" });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(
      `Invalid config at ${configPath}.\ngateway.mode: Expected 'local' or 'remote'\nRun "openclaw doctor --fix" to repair, then retry.\nIf startup is still blocked, inspect the adjacent .bak backup before restoring it manually.`,
    );
  });

  it("rejects legacy config entries in Nix mode", async () => {
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
  });

  it("rejects plugin-local startup invalidity without degraded startup", async () => {
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
    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(`Invalid config at ${configPath}.`);
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

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(`Invalid config at ${configPath}.`);
  });

  it("rejects stale model provider api enum values during startup", async () => {
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
    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: false,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(`Invalid config at ${configPath}.`);

    expect(configMutate.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("rejects prefixed JSON without startup suffix repair", async () => {
    const invalidSnapshot = buildSnapshot({
      valid: false,
      raw: `Found and updated: False\n${JSON.stringify(validConfig)}\n`,
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(`Invalid config at ${configPath}.`);
  });
});
