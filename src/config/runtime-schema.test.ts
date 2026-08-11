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
import {
  clearRuntimeConfigSnapshot,
  setRuntimeAmbientEnvTriggers,
  setRuntimeConfigSnapshot,
} from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const mockLoadConfig = vi.hoisted(() => vi.fn<() => OpenClawConfig>());
const mockReadConfigFileSnapshot = vi.hoisted(() =>
  vi.fn<(options?: { observe?: boolean }) => Promise<ConfigFileSnapshot>>(),
);
const mockLoadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const mockGetCurrentPluginMetadataSnapshot = vi.hoisted(() => vi.fn());

let readBestEffortRuntimeConfigSchema: typeof import("./runtime-schema.js").readBestEffortRuntimeConfigSchema;
let loadGatewayRuntimeConfigSchema: typeof import("./runtime-schema.js").loadGatewayRuntimeConfigSchema;

function explicitMainRoster(): OpenClawConfig {
  return { agents: { list: [{ id: "main" }] } };
}

vi.mock("./config.js", () => {
  return {
    getRuntimeConfig: () => mockLoadConfig(),
    loadConfig: () => mockLoadConfig(),
    readConfigFileSnapshot: (...args: Parameters<typeof mockReadConfigFileSnapshot>) =>
      mockReadConfigFileSnapshot(...args),
  };
});

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: (...args: unknown[]) => mockLoadPluginManifestRegistry(...args),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: (...args: unknown[]) =>
    mockLoadPluginManifestRegistry(...args),
}));

// Partial mock: schema ownership planning still reaches real bindings such as
// resolvePluginMetadataEnvFingerprint through the auto-enable detect path.
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (...args: unknown[]) => ({
    manifestRegistry: mockLoadPluginManifestRegistry(...args),
  }),
  resolvePluginMetadataSnapshot: (...args: unknown[]) =>
    mockGetCurrentPluginMetadataSnapshot(...args) ?? {
      manifestRegistry: mockLoadPluginManifestRegistry(...args),
    },
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: (...args: unknown[]) =>
    mockGetCurrentPluginMetadataSnapshot(...args),
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

function makeAcmeChatPlugin(params: { id: string; extraProperty: string; preferOver?: string[] }) {
  return {
    id: params.id,
    origin: "global",
    rootDir: `/fake/${params.id}`,
    source: `/fake/${params.id}/index.js`,
    manifestPath: `/fake/${params.id}/openclaw.plugin.json`,
    channels: ["acmechat"],
    channelConfigs: {
      acmechat: {
        ...(params.preferOver ? { preferOver: params.preferOver } : {}),
        schema: {
          type: "object",
          properties: { [params.extraProperty]: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
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
  const arg = mockLoadPluginManifestRegistry.mock.calls[index]?.[0];
  return arg && typeof arg === "object" ? (arg as Record<string, unknown>) : undefined;
}

function getCurrentMetadataSnapshotArg(index = 0): Record<string, unknown> | undefined {
  const arg = mockGetCurrentPluginMetadataSnapshot.mock.calls[index]?.[0];
  return arg && typeof arg === "object" ? (arg as Record<string, unknown>) : undefined;
}

beforeAll(async () => {
  ({ readBestEffortRuntimeConfigSchema, loadGatewayRuntimeConfigSchema } =
    await import("./runtime-schema.js"));
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
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
    mockLoadPluginManifestRegistry.mockReturnValue(makeManifestRegistry());
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
      manifestRegistryLoadCount: mockLoadPluginManifestRegistry.mock.calls.length,
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(explicitMainRoster());
    mockLoadPluginManifestRegistry.mockReturnValue(makeManifestRegistry());
  });

  it("merges manifest plugin metadata for valid configs", async () => {
    const { channelProps, entryProps, loadArg, manifestRegistryLoadCount } = validConfigSchemaCase;
    expect(manifestRegistryLoadCount).toBe(1);
    expect(loadArg?.config).toEqual({
      ...explicitMainRoster(),
      plugins: { entries: { demo: { enabled: true } } },
    });
    expect(loadArg).not.toHaveProperty("cache", false);
    expect(loadArg).not.toHaveProperty("bundledChannelConfigCollector");
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

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    const loadArg = getManifestRegistryLoadArg();
    expect(loadArg?.config).toEqual({
      ...explicitMainRoster(),
      plugins: { enabled: true },
    });
    expect(loadArg).not.toHaveProperty("cache", false);
    expect(loadArg).not.toHaveProperty("bundledChannelConfigCollector");
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
    mockLoadPluginManifestRegistry.mockReturnValue(makeManifestRegistry());
  });

  it("uses manifest metadata instead of booting plugin runtime", () => {
    const result = loadGatewayRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    const loadArg = getManifestRegistryLoadArg();
    expect(loadArg?.config).toEqual({
      ...explicitMainRoster(),
      plugins: { entries: { demo: { enabled: true } } },
    });
    expect(loadArg).not.toHaveProperty("bundledChannelConfigCollector");
    expect(channelProps).toHaveProperty("telegram");
    expect(channelProps).toHaveProperty("matrix");
  });

  it("projects strict heartbeat visibility for external channels and their accounts", () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
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
    mockLoadPluginManifestRegistry.mockReturnValue({
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

  it("reuses the current gateway plugin metadata snapshot for config schema requests", () => {
    mockGetCurrentPluginMetadataSnapshot.mockReturnValueOnce({
      manifestRegistry: {
        diagnostics: [],
        plugins: [
          {
            id: "telegram",
            name: "Telegram",
            description: "Telegram plugin",
            origin: "bundled",
            channels: ["telegram"],
          },
          {
            id: "matrix",
            name: "Matrix",
            description: "Matrix plugin",
            origin: "workspace",
            channels: ["matrix"],
            channelConfigs: {
              matrix: {
                schema: {
                  type: "object",
                  properties: {
                    homeserver: { type: "string" },
                  },
                },
              },
            },
          },
        ],
      },
    });

    const result = loadGatewayRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelProps = channelsNode?.properties as Record<string, unknown> | undefined;

    expect(mockGetCurrentPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
    const metadataArg = getCurrentMetadataSnapshotArg();
    expect(metadataArg?.config).toEqual({
      ...explicitMainRoster(),
      plugins: { entries: { demo: { enabled: true } } },
    });
    expect(mockLoadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(channelProps).toHaveProperty("telegram");
    expect(JSON.stringify(channelProps?.telegram)).toContain("botToken");
    expect(channelProps).toHaveProperty("matrix");
  });

  // Gateway startup publishes the auto-enabled runtime config as the active snapshot, so its
  // generated `enabled: true` entries would read as operator selections and let the replacement
  // win the tie that authored selection already decided for the plugin it supersedes.
  it("ranks channel schema ownership from the published source config, not auto-enable's generated entries", () => {
    const authoredSelection = {
      ...explicitMainRoster(),
      plugins: { entries: { "openclaw-acmechat": { config: {} } } },
    };
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        makeAcmeChatPlugin({ id: "openclaw-acmechat", extraProperty: "legacyOption" }),
        makeAcmeChatPlugin({
          id: "acme-chat-thread-guard",
          extraProperty: "threadGuard",
          preferOver: ["openclaw-acmechat"],
        }),
      ],
    });
    mockLoadConfig.mockReturnValue({
      ...explicitMainRoster(),
      plugins: {
        entries: {
          "openclaw-acmechat": { config: {} },
          "acme-chat-thread-guard": { enabled: true },
        },
      },
    });
    setRuntimeConfigSnapshot(mockLoadConfig(), authoredSelection);

    const result = loadGatewayRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channels = schema.properties?.channels as { properties?: Record<string, unknown> };

    expect(JSON.stringify(channels.properties?.acmechat)).toContain("legacyOption");
  });

  // #120332 round 45 (P2): the gateway's ambient env-trigger policy reaches ownership planning.
  // Under `ambientEnvTriggers: "suppress"` an env-only channel is excluded from startup and
  // loader suppression, so its claims must not decide ANOTHER configured channel's claimant
  // fate — a default "allow" plan would advertise the schema of a fallback the gateway never
  // needs while superseding the plugin it actually serves.
  it("honors the gateway's ambient env-trigger policy in advertised channel schemas", () => {
    const makeClaimant = (params: {
      id: string;
      channels: Record<string, string>;
      preferOver?: string[];
    }) => ({
      id: params.id,
      origin: "global",
      rootDir: `/fake/${params.id}`,
      source: `/fake/${params.id}/index.js`,
      manifestPath: `/fake/${params.id}/openclaw.plugin.json`,
      enabledByDefault: true,
      channels: Object.keys(params.channels),
      channelConfigs: Object.fromEntries(
        Object.entries(params.channels).map(([channelId, extraProperty]) => [
          channelId,
          {
            ...(params.preferOver ? { preferOver: params.preferOver } : {}),
            schema: {
              type: "object",
              properties: { [extraProperty]: { type: "string" } },
              additionalProperties: false,
            },
          },
        ]),
      ),
    });
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        // Discovery-first claimant of the config-configured channel; also the incumbent of the
        // env-only clickclack channel, where a replacement edge kills it plugin-globally.
        makeClaimant({
          id: "acme-aa-multi",
          channels: { clickclack: "aOption", acmey: "aOption" },
        }),
        makeClaimant({
          id: "clickclack-bb-rep",
          channels: { clickclack: "bOption" },
          preferOver: ["acme-aa-multi"],
        }),
        makeClaimant({ id: "acme-cc-fallback", channels: { acmey: "cOption" } }),
      ],
    });
    mockLoadConfig.mockReturnValue({
      ...explicitMainRoster(),
      channels: { acmey: { token: "y" } },
    });
    process.env.CLICKCLACK_BOT_TOKEN = "token";
    try {
      const acmeySchemaText = () => {
        const schema = loadGatewayRuntimeConfigSchema().schema as {
          properties?: Record<string, unknown>;
        };
        const channels = schema.properties?.channels as { properties?: Record<string, unknown> };
        return JSON.stringify(channels.properties?.acmey);
      };

      // Default policy: the env-only clickclack channel joins the plan, its replacement kills
      // the multi-channel incumbent, and the configured channel falls back to its other claimant.
      expect(acmeySchemaText()).toContain("cOption");

      // Suppressed ambient triggers: clickclack is outside the plan exactly as it is outside
      // loader suppression, so the configured channel keeps its discovery-first claimant.
      setRuntimeAmbientEnvTriggers("suppress");
      expect(acmeySchemaText()).toContain("aOption");
    } finally {
      delete process.env.CLICKCLACK_BOT_TOKEN;
    }
  });

  // #120332 round 48 (P2): a landed channel registration outranks prediction. When a planned
  // replacement fails to load and the suppressed incumbent is restored, the advertised schema
  // must follow the plugin actually serving the channel — not the failed replacement's plan.
  it("advertises the landed channel owner's schema over the planned replacement", () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        makeAcmeChatPlugin({ id: "openclaw-acmechat", extraProperty: "legacyOption" }),
        makeAcmeChatPlugin({
          id: "acme-chat-thread-guard",
          extraProperty: "threadGuard",
          preferOver: ["openclaw-acmechat"],
        }),
      ],
    });
    mockLoadConfig.mockReturnValue({
      ...explicitMainRoster(),
      channels: { acmechat: { token: "x" } },
    });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.channels.push({
      pluginId: "openclaw-acmechat",
      plugin: { id: "acmechat" },
    } as (typeof activeRegistry.channels)[number]);
    setActivePluginRegistry(activeRegistry, "landed-owner-registry");

    const result = loadGatewayRuntimeConfigSchema();
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channels = schema.properties?.channels as { properties?: Record<string, unknown> };

    expect(JSON.stringify(channels.properties?.acmechat)).toContain("legacyOption");
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

    expect(mockLoadPluginManifestRegistry).toHaveBeenCalledTimes(3);
    for (const call of mockLoadPluginManifestRegistry.mock.calls) {
      expect(call[0]).toHaveProperty("config");
      expect(call[0]).not.toHaveProperty("bundledChannelConfigCollector");
    }
    expect(getActivePluginRegistry()).toBe(activeRegistry);
    expect(getActivePluginRegistryKey()).toBe("startup-registry");
    expect(getActivePluginRegistryVersion()).toBe(versionBefore);
  });
});
