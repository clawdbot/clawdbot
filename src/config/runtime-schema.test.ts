// Covers runtime schema defaults and generated runtime config behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRegistryVersion,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const mockLoadConfig = vi.hoisted(() => vi.fn<() => OpenClawConfig>());
const mockReadConfigFileSnapshot = vi.hoisted(() =>
  vi.fn<(options?: { observe?: boolean }) => Promise<ConfigFileSnapshot>>(),
);
const mockResolveConfigWidePluginManifestRegistry = vi.hoisted(() => vi.fn());

let readBestEffortRuntimeConfigSchema: typeof import("./runtime-schema.js").readBestEffortRuntimeConfigSchema;
let loadGatewayRuntimeConfigSchema: typeof import("./runtime-schema.js").loadGatewayRuntimeConfigSchema;

function explicitMainRoster(): OpenClawConfig {
  return { agents: { list: [{ id: "main" }] } };
}

vi.mock("./config.js", () => {
  return {
    getRuntimeConfig: () => mockLoadConfig(),
    loadConfig: () => mockLoadConfig(),
    readConfigFileSnapshotWithPluginMetadata: async (
      ...args: Parameters<typeof mockReadConfigFileSnapshot>
    ) => ({ snapshot: await mockReadConfigFileSnapshot(...args) }),
  };
});

vi.mock("./io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: (...args: unknown[]) =>
    mockResolveConfigWidePluginManifestRegistry(...args),
}));

function makeSnapshot(params: { valid: boolean; config?: OpenClawConfig }): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: params.config ?? {},
    resolved: params.config ?? {},
    sourceConfig: params.config ?? {},
    valid: params.valid,
    config: params.config ?? {},
    runtimeConfig: params.config ?? {},
    issues: params.valid ? [] : [{ path: "gateway", message: "invalid" }],
    warnings: [],
    legacyIssues: [],
  };
}

function makeManifestRegistry() {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "demo",
        name: "Demo",
        description: "Demo plugin",
        origin: "bundled",
        channels: [],
        configUiHints: {},
        configSchema: {
          type: "object",
          properties: {
            mode: { type: "string" },
          },
        },
      },
      {
        id: "telegram",
        name: "Telegram",
        description: "Telegram plugin",
        origin: "bundled",
        channels: ["telegram"],
        channelCatalogMeta: {
          id: "telegram",
          label: "Telegram",
          blurb: "Telegram channel",
        },
        channelConfigs: {
          telegram: {
            schema: {
              type: "object",
              properties: {
                botToken: { type: "string" },
              },
            },
            uiHints: {},
          },
        },
      },
      {
        id: "slack",
        name: "Slack",
        description: "Slack plugin",
        origin: "bundled",
        channels: ["slack"],
        channelCatalogMeta: {
          id: "slack",
          label: "Slack",
          blurb: "Slack channel",
        },
        channelConfigs: {
          slack: {
            schema: {
              type: "object",
              properties: {
                botToken: { type: "string" },
              },
            },
            uiHints: {},
          },
        },
      },
      {
        id: "matrix",
        name: "Matrix",
        description: "Matrix plugin",
        origin: "workspace",
        channels: ["matrix"],
        channelCatalogMeta: {
          id: "matrix",
          label: "Matrix",
          blurb: "Matrix channel",
        },
        channelConfigs: {
          matrix: {
            schema: {
              type: "object",
              properties: {
                homeserver: { type: "string" },
              },
            },
            uiHints: {},
          },
        },
      },
    ],
  };
}

async function readSchemaNodes() {
  const result = await readBestEffortRuntimeConfigSchema();
  const schema = result.schema as { properties?: Record<string, unknown> };
  const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
  const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;
  const pluginsNode = schema.properties?.plugins as Record<string, unknown> | undefined;
  const pluginProps = pluginsNode?.properties as Record<string, unknown> | undefined;
  const entriesNode = pluginProps?.entries as Record<string, unknown> | undefined;
  const entryProps = entriesNode?.properties as Record<string, unknown> | undefined;
  return { channelProps, entryProps };
}

function getManifestRegistryLoadArg(index = 0): Record<string, unknown> | undefined {
  const arg = mockResolveConfigWidePluginManifestRegistry.mock.calls[index]?.[0];
  return arg && typeof arg === "object" ? (arg as Record<string, unknown>) : undefined;
}

beforeAll(async () => {
  ({ readBestEffortRuntimeConfigSchema, loadGatewayRuntimeConfigSchema } =
    await import("./runtime-schema.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

describe("readBestEffortRuntimeConfigSchema", () => {
  let validConfigSchemaCase: {
    channelProps: Record<string, unknown> | undefined;
    entryProps: Record<string, unknown> | undefined;
    loadArg: Record<string, unknown> | undefined;
    manifestRegistryLoadCount: number;
  };

  beforeAll(async () => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(explicitMainRoster());
    mockResolveConfigWidePluginManifestRegistry.mockReturnValue(makeManifestRegistry());
    mockReadConfigFileSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        valid: true,
        config: {
          ...explicitMainRoster(),
          plugins: { entries: { demo: { enabled: true } } },
        },
      }),
    );

    const { channelProps, entryProps } = await readSchemaNodes();
    validConfigSchemaCase = {
      channelProps,
      entryProps,
      loadArg: getManifestRegistryLoadArg(),
      manifestRegistryLoadCount: mockResolveConfigWidePluginManifestRegistry.mock.calls.length,
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(explicitMainRoster());
    mockResolveConfigWidePluginManifestRegistry.mockReturnValue(makeManifestRegistry());
  });

  it("merges manifest plugin metadata for valid configs", async () => {
    const { channelProps, entryProps, loadArg, manifestRegistryLoadCount } = validConfigSchemaCase;
    expect(manifestRegistryLoadCount).toBe(1);
    expect(loadArg?.config).toEqual({
      ...explicitMainRoster(),
      plugins: { entries: { demo: { enabled: true } } },
    });
    expect(channelProps).toHaveProperty("telegram");
    expect(channelProps).toHaveProperty("matrix");
    expect(entryProps).toHaveProperty("demo");
  });

  it("reads the best-effort CLI schema without observing configuration health", async () => {
    mockReadConfigFileSnapshot.mockResolvedValueOnce(
      makeSnapshot({ valid: true, config: explicitMainRoster() }),
    );

    await readBestEffortRuntimeConfigSchema();

    expect(mockReadConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
  });

  it("falls back to bundled channel metadata when config is invalid", async () => {
    mockReadConfigFileSnapshot.mockResolvedValueOnce(makeSnapshot({ valid: false }));

    const { channelProps, entryProps } = await readSchemaNodes();

    expect(mockResolveConfigWidePluginManifestRegistry).toHaveBeenCalledTimes(1);
    const loadArg = getManifestRegistryLoadArg();
    expect(loadArg?.config).toEqual({
      ...explicitMainRoster(),
      plugins: { enabled: true },
    });
    expect(loadArg?.allowCurrent).toBe(false);
    expect(channelProps).toHaveProperty("telegram");
    expect(channelProps).toHaveProperty("slack");
    expect(entryProps?.demo).toBeUndefined();
  });
});

describe("loadGatewayRuntimeConfigSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({
      ...explicitMainRoster(),
      plugins: { entries: { demo: { enabled: true } } },
    });
    mockResolveConfigWidePluginManifestRegistry.mockReturnValue(makeManifestRegistry());
  });

  it("uses manifest metadata instead of booting plugin runtime", () => {
    const result = loadGatewayRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;

    expect(mockResolveConfigWidePluginManifestRegistry).toHaveBeenCalledTimes(1);
    const loadArg = getManifestRegistryLoadArg();
    expect(loadArg?.config).toEqual({
      ...explicitMainRoster(),
      plugins: { entries: { demo: { enabled: true } } },
    });
    expect(channelProps).toHaveProperty("telegram");
    expect(channelProps).toHaveProperty("matrix");
  });

  it("projects strict heartbeat visibility for external channels and their accounts", () => {
    mockResolveConfigWidePluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "external-chat",
          origin: "workspace",
          channels: ["external-chat"],
          channelConfigs: {
            "external-chat": {
              schema: {
                type: "object",
                properties: {
                  endpoint: { type: "string" },
                  accounts: {
                    type: "object",
                    additionalProperties: {
                      type: "object",
                      properties: { endpoint: { type: "string" } },
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
      ],
    });

    const result = loadGatewayRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channels = schema.properties?.channels as { properties?: Record<string, unknown> };
    const heartbeatVisibility = {
      type: "object",
      properties: {
        showOk: { type: "boolean" },
        showAlerts: { type: "boolean" },
        useIndicator: { type: "boolean" },
      },
      additionalProperties: false,
    };

    expect(channels.properties?.["external-chat"]).toMatchObject({
      additionalProperties: false,
      properties: {
        heartbeatVisibility,
        accounts: {
          additionalProperties: {
            additionalProperties: false,
            properties: { heartbeatVisibility },
          },
        },
      },
    });
  });

  it("projects canonical heartbeats into composed schemas and referenced open accounts", () => {
    mockResolveConfigWidePluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "external-chat",
          origin: "workspace",
          channels: ["external-chat"],
          channelConfigs: {
            "external-chat": {
              schema: {
                $defs: { Account: {} },
                anyOf: [
                  { type: "object", additionalProperties: true },
                  {
                    type: "object",
                    properties: {
                      accounts: {
                        type: "object",
                        additionalProperties: { $ref: "#/$defs/Account" },
                      },
                    },
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
        },
      ],
    });

    const result = loadGatewayRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channels = schema.properties?.channels as { properties?: Record<string, unknown> };
    const heartbeatVisibility = {
      type: "object",
      additionalProperties: false,
      properties: {
        showOk: { type: "boolean" },
        showAlerts: { type: "boolean" },
        useIndicator: { type: "boolean" },
      },
    };

    const projected = channels.properties?.["external-chat"] as Record<string, unknown>;
    expect(projected).toMatchObject({
      properties: { heartbeatVisibility },
      anyOf: [
        { additionalProperties: true, properties: { heartbeatVisibility } },
        {
          additionalProperties: false,
          properties: {
            heartbeatVisibility,
            accounts: {
              additionalProperties: { properties: { heartbeatVisibility } },
            },
          },
        },
      ],
    });
    expect(projected.$defs).toEqual({ Account: {} });
  });

  it("reuses prepared schema metadata without repeating JSON serialization", () => {
    const first = loadGatewayRuntimeConfigSchema();
    const stringify = vi.spyOn(JSON, "stringify");
    const second = loadGatewayRuntimeConfigSchema();
    const serializationCount = stringify.mock.calls.length;
    stringify.mockRestore();

    expect(second).toBe(first);
    expect(serializationCount).toBe(0);
  });

  it("rebuilds the schema when the prepared manifest registry is replaced", () => {
    const first = loadGatewayRuntimeConfigSchema();
    const registry = makeManifestRegistry();
    mockResolveConfigWidePluginManifestRegistry.mockReturnValue({
      ...registry,
      plugins: registry.plugins.map((plugin) =>
        plugin.id === "demo" ? Object.assign({}, plugin, { name: "Updated Demo" }) : plugin,
      ),
    });
    const second = loadGatewayRuntimeConfigSchema();

    expect(first.uiHints["plugins.entries.demo"]?.label).toBe("Demo");
    expect(second.uiHints["plugins.entries.demo"]?.label).toBe("Updated Demo");
  });

  it("does not activate or replace the active plugin registry across repeated schema loads (regression guard for #54816)", () => {
    // Each MCP connection triggers a config.schema / config.get gateway request which calls
    // loadGatewayRuntimeConfigSchema. The original bug caused a fresh full plugin registry to
    // be activated on every call, re-running registerFull for all channel plugins including
    // Feishu. Verify that repeated calls keep using manifest metadata without replacing the
    // already-active runtime registry or mutating its activation version.
    const activeRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(activeRegistry, "startup-registry");
    const versionBefore = getActivePluginRegistryVersion();

    loadGatewayRuntimeConfigSchema();
    loadGatewayRuntimeConfigSchema();
    loadGatewayRuntimeConfigSchema();

    expect(getActivePluginRegistry()).toBe(activeRegistry);
    expect(getActivePluginRegistryKey()).toBe("startup-registry");
    expect(getActivePluginRegistryVersion()).toBe(versionBefore);
  });
});
