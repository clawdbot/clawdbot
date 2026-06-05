// Startup config recovery tests cover prepared snapshots, plugin metadata,
// auto-enable behavior, model defaults, and recovery diagnostics.
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
const pluginMetadataSnapshot = vi.hoisted((): PluginMetadataSnapshot => {
  const emptyOwners = {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
  };
  const zeroMetrics = {
    registrySnapshotMs: 0,
    manifestRegistryMs: 0,
    ownerMapsMs: 0,
    totalMs: 0,
    indexPluginCount: 0,
    manifestPluginCount: 0,
  };
  return {
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
    owners: emptyOwners,
    metrics: zeroMetrics,
  };
});
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
const telegramAutoEnableChange = "Telegram configured, enabled automatically.";
const runtimeOnlyAutoEnableLog = `gateway: auto-enabled plugins for this runtime without writing config:\n- ${telegramAutoEnableChange}`;
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

function buildRuntimeSnapshot(
  sourceConfig: OpenClawConfig,
  runtimeConfig: OpenClawConfig = sourceConfig,
): ConfigFileSnapshot {
  return {
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
}

function mockStartupSnapshot(snapshot: ConfigFileSnapshot) {
  vi.mocked(configIo.readConfigFileSnapshotWithPluginMetadata).mockResolvedValueOnce({
    snapshot,
    pluginMetadataSnapshot,
  });
}

async function expectStartupResult(params: {
  snapshot: ConfigFileSnapshot;
  log?: ReturnType<typeof testStartupLog>;
  initialSnapshotRead?: Parameters<
    typeof loadGatewayStartupConfigSnapshot
  >[0]["initialSnapshotRead"];
}) {
  await expect(
    loadTestStartup({
      minimalTestGateway: false,
      log: params.log,
      initialSnapshotRead: params.initialSnapshotRead,
    }),
  ).resolves.toEqual({
    snapshot: params.snapshot,
    wroteConfig: false,
    pluginMetadataSnapshot,
  });
}

function expectPluginAutoEnableFor(config: OpenClawConfig) {
  expect(applyPluginAutoEnable).toHaveBeenCalledWith({
    config,
    env: process.env,
    manifestRegistry: pluginManifestRegistry,
  });
}

function mockRuntimeAutoEnable(config: OpenClawConfig) {
  applyPluginAutoEnable.mockReturnValueOnce({
    config,
    changes: [telegramAutoEnableChange],
    autoEnabledReasons: {},
  });
}

function expectRuntimeOnlyAutoEnableLogged(log: ReturnType<typeof testStartupLog>) {
  expect(log.info).toHaveBeenCalledWith(runtimeOnlyAutoEnableLog);
  expect(log.warn).not.toHaveBeenCalled();
}

function withRuntimeConfig(
  snapshot: ConfigFileSnapshot,
  runtimeConfig: OpenClawConfig,
): ConfigFileSnapshot {
  return {
    ...snapshot,
    runtimeConfig,
    config: runtimeConfig,
  };
}

function buildInvalidConfigSnapshot(params: {
  rawConfig: unknown;
  config?: OpenClawConfig;
  issues: ConfigFileSnapshot["issues"];
  warnings?: ConfigFileSnapshot["warnings"];
  legacyIssues?: ConfigFileSnapshot["legacyIssues"];
}) {
  return buildTestConfigSnapshot({
    path: configPath,
    exists: true,
    raw: `${JSON.stringify(params.rawConfig)}\n`,
    parsed: params.rawConfig,
    valid: false,
    config: params.config ?? (params.rawConfig as OpenClawConfig),
    issues: params.issues,
    warnings: params.warnings,
    legacyIssues: params.legacyIssues ?? [],
  });
}

function pluginSlotRawConfig(gatewayMode: string) {
  return {
    gateway: { mode: gatewayMode },
    plugins: { slots: { memory: "source-only-pack" } },
  };
}

function enabledPluginRawConfig(gatewayMode: string) {
  return {
    gateway: { mode: gatewayMode },
    plugins: {
      entries: {
        feishu: { enabled: true },
      },
    },
  };
}

function testStartupLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

function loadTestStartup(params: {
  minimalTestGateway?: boolean;
  log?: ReturnType<typeof testStartupLog>;
  initialSnapshotRead?: Parameters<
    typeof loadGatewayStartupConfigSnapshot
  >[0]["initialSnapshotRead"];
}) {
  return loadGatewayStartupConfigSnapshot({
    minimalTestGateway: params.minimalTestGateway ?? true,
    log: params.log ?? testStartupLog(),
    initialSnapshotRead: params.initialSnapshotRead,
  });
}

async function expectStartupRejects(message: string | RegExp, minimalTestGateway = true) {
  await expect(loadTestStartup({ minimalTestGateway })).rejects.toThrow(message);
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
  writeConfig.mockResolvedValue({
    persistedHash: "test-persisted-hash",
    persistedConfig: validConfig,
  });
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
    const snapshot = buildRuntimeSnapshot(sourceConfig, runtimeConfig);
    mockStartupSnapshot(snapshot);
    const log = testStartupLog();

    await expectStartupResult({ snapshot, log });

    expect(configIo.readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(1);
    expectPluginAutoEnableFor(sourceConfig);
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
    const log = testStartupLog();

    await expectStartupResult({
      snapshot,
      log,
      initialSnapshotRead: {
        snapshot,
        pluginMetadataSnapshot,
      },
    });

    expect(configIo.readConfigFileSnapshotWithPluginMetadata).not.toHaveBeenCalled();
    expectPluginAutoEnableFor(validConfig);
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
    const initialSnapshot = buildRuntimeSnapshot(sourceConfig);
    mockStartupSnapshot(initialSnapshot);
    mockRuntimeAutoEnable(autoEnabledConfig);
    const log = testStartupLog();

    await expectStartupResult({
      snapshot: withRuntimeConfig(initialSnapshot, autoEnabledConfig),
      log,
    });

    expectPluginAutoEnableFor(sourceConfig);
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
    expectRuntimeOnlyAutoEnableLogged(log);
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
    const snapshot = buildRuntimeSnapshot(sourceConfig);
    mockStartupSnapshot(snapshot);
    mockRuntimeAutoEnable(autoEnabledConfig);
    configMocks.isNixMode.value = true;
    const log = testStartupLog();

    await expectStartupResult({
      snapshot: withRuntimeConfig(snapshot, autoEnabledConfig),
      log,
    });

    expect(configMutate.replaceConfigFile).not.toHaveBeenCalled();
    expect(configIo.readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(1);
    expectRuntimeOnlyAutoEnableLogged(log);
  });

  it("rejects invalid config before startup without automatic recovery", async () => {
    const invalidSnapshot = buildSnapshot({ valid: false, raw: "{ invalid json" });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);

    await expectStartupRejects(
      `Invalid config at ${configPath}.\ngateway.mode: Expected 'local' or 'remote'\nRun "openclaw doctor --fix" to repair, then retry.\nIf startup is still blocked, inspect the adjacent .bak backup before restoring it manually.`,
    );
  });

  it("does not suggest doctor repair for plugin packaging compiled-output failures", async () => {
    const rawConfig = pluginSlotRawConfig("local");
    const invalidSnapshot = buildInvalidConfigSnapshot({
      rawConfig,
      config: rawConfig as OpenClawConfig,
      issues: [
        {
          path: "plugins.slots.memory",
          message: "plugin not found: source-only-pack",
        },
      ],
      warnings: [
        {
          path: "plugins",
          message:
            "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
        },
      ],
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);

    const start = loadTestStartup({});
    await expect(start).rejects.toThrow(
      `Invalid config at ${configPath}.\nplugins.slots.memory: plugin not found: source-only-pack\nThis is a plugin packaging issue, not a local config problem.\nUpdate or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.`,
    );
    await start.catch((error: unknown) => {
      expect(String(error)).not.toContain("openclaw doctor --fix");
    });
  });

  it("keeps doctor repair guidance for mixed plugin packaging and core invalidity", async () => {
    const rawConfig = pluginSlotRawConfig("invalid");
    const invalidSnapshot = buildInvalidConfigSnapshot({
      rawConfig,
      config: rawConfig as unknown as OpenClawConfig,
      issues: [
        {
          path: "plugins.slots.memory",
          message: "plugin not found: source-only-pack",
        },
        {
          path: "gateway.mode",
          message: "Expected 'local' or 'remote'",
        },
      ],
      warnings: [
        {
          path: "plugins",
          message:
            "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js.",
        },
      ],
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);

    await expectStartupRejects('Run "openclaw doctor --fix" to repair, then retry.');
  });

  it("rejects legacy config entries in Nix mode", async () => {
    const legacySnapshot = buildInvalidConfigSnapshot({
      rawConfig: {
        heartbeat: { model: "anthropic/claude-3-5-haiku-20241022", every: "30m" },
      },
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
    mockStartupSnapshot(legacySnapshot);
    configMocks.isNixMode.value = true;

    await expectStartupRejects(
      "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
    );
  });

  it("rejects plugin-local startup invalidity without degraded startup", async () => {
    const rawConfig = enabledPluginRawConfig("local");
    const invalidSnapshot = buildInvalidConfigSnapshot({
      rawConfig,
      config: rawConfig as OpenClawConfig,
      issues: [
        {
          path: "plugins.entries.feishu",
          message:
            "plugin feishu: plugin requires OpenClaw >=2026.4.23, but this host is 2026.4.22; skipping load",
        },
      ],
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    await expectStartupRejects(`Invalid config at ${configPath}.`);
  });

  it("keeps mixed plugin and core startup invalidity fatal", async () => {
    const rawConfig = enabledPluginRawConfig("invalid");
    const invalidSnapshot = buildInvalidConfigSnapshot({
      rawConfig,
      config: rawConfig as unknown as OpenClawConfig,
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
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);

    await expectStartupRejects(`Invalid config at ${configPath}.`);
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
    const invalidSnapshot = buildInvalidConfigSnapshot({
      rawConfig: config,
      config,
      issues: [
        {
          path: "models.providers.openrouter.api",
          message:
            'Invalid option: expected one of "openai-completions"|"openai-responses"|"openai-chatgpt-responses"|"anthropic-messages"|"google-generative-ai"|"github-copilot"|"bedrock-converse-stream"|"ollama"|"azure-openai-responses"',
        },
        {
          path: "models.providers.openrouter.models.0.api",
          message:
            'Invalid option: expected one of "openai-completions"|"openai-responses"|"openai-chatgpt-responses"|"anthropic-messages"|"google-generative-ai"|"github-copilot"|"bedrock-converse-stream"|"ollama"|"azure-openai-responses"',
        },
      ],
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    await expectStartupRejects(`Invalid config at ${configPath}.`, false);

    expect(configMutate.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("rejects prefixed JSON without startup suffix repair", async () => {
    const invalidSnapshot = buildSnapshot({
      valid: false,
      raw: `Found and updated: False\n${JSON.stringify(validConfig)}\n`,
    });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);

    await expectStartupRejects(`Invalid config at ${configPath}.`);
  });
});
