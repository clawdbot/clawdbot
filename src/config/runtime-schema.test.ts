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
const mockLoadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const mockGetCurrentPluginMetadataSnapshot = vi.hoisted(() => vi.fn());

let readBestEffortRuntimeConfigSchema: typeof import("./runtime-schema.js").readBestEffortRuntimeConfigSchema;
let loadGatewayRuntimeConfigSchema: typeof import("./runtime-schema.js").loadGatewayRuntimeConfigSchema;
let buildRuntimeConfigSchemaForConfig: typeof import("./runtime-schema.js").buildRuntimeConfigSchemaForConfig;

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

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
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
  ({
    readBestEffortRuntimeConfigSchema,
    loadGatewayRuntimeConfigSchema,
    buildRuntimeConfigSchemaForConfig,
  } = await import("./runtime-schema.js"));
});

afterEach(() => {
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

  // Codex review P2 on #123209: config validation filters denied replacements out of channel
  // schema ownership. The operator-facing runtime schema has to make the same choice, or config UI
  // offers the disabled plugin's fields and authors config that validation then rejects.
  it.each([
    { label: "its plugin id", denied: "clickclack-plus" },
    // Gateway startup canonicalizes policy lists through the registry, so an operator may deny a
    // plugin by any alias it declares.
    { label: "one of its declared aliases", denied: "clickclack-legacy" },
  ])(
    "describes the fallback channel schema when the replacement is denied by $label",
    ({ denied }) => {
      mockLoadConfig.mockReturnValue({
        ...explicitMainRoster(),
        plugins: { deny: [denied] },
      });
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "clickclack-plus",
            origin: "workspace",
            channels: ["clickclack"],
            legacyPluginIds: ["clickclack-legacy"],
            channelConfigs: {
              clickclack: {
                preferOver: ["clickclack-core"],
                schema: {
                  type: "object",
                  properties: { plusToken: { type: "string" } },
                  additionalProperties: false,
                },
              },
            },
          },
          {
            id: "clickclack-core",
            origin: "workspace",
            channels: ["clickclack"],
            channelConfigs: {
              clickclack: {
                schema: {
                  type: "object",
                  properties: { coreToken: { type: "string" } },
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
      const clickclack = channels?.properties?.clickclack as {
        properties?: Record<string, unknown>;
      };

      expect(clickclack?.properties).toHaveProperty("coreToken");
      expect(clickclack?.properties).not.toHaveProperty("plusToken");
    },
  );

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

describe("buildRuntimeConfigSchemaForConfig", () => {
  // Write acknowledgements redact the committed config. If the schema followed the active runtime
  // config instead of the one passed in, a write that activates a replacement would be redacted
  // under the previous owner's hints and could return a field the new owner marks sensitive.
  function twoClaimantRegistry() {
    return {
      diagnostics: [],
      plugins: [
        {
          id: "clickclack-plus",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              preferOver: ["clickclack-core"],
              schema: {
                type: "object",
                properties: { plusToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
        {
          id: "clickclack-core",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: {
                type: "object",
                properties: { coreToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
      ],
    };
  }

  function clickclackProperties(result: { schema: unknown }) {
    const schema = result.schema as { properties?: Record<string, unknown> };
    const channels = schema.properties?.channels as { properties?: Record<string, unknown> };
    return (channels?.properties?.clickclack as { properties?: Record<string, unknown> })
      ?.properties;
  }

  it("follows the config it is given, not the active runtime config", () => {
    // Active runtime config denies the replacement, so ambient ownership is the fallback.
    mockLoadConfig.mockReturnValue({
      ...explicitMainRoster(),
      plugins: { deny: ["clickclack-plus"] },
    });
    mockLoadPluginManifestRegistry.mockReturnValue(twoClaimantRegistry());

    expect(clickclackProperties(loadGatewayRuntimeConfigSchema())).toHaveProperty("coreToken");

    // The committed config does not deny it, so the acknowledgement must describe the replacement.
    // The committed config is authored as persisted, so it is its own source half.
    const committed = { ...explicitMainRoster() };
    const properties = clickclackProperties(
      buildRuntimeConfigSchemaForConfig(committed, committed),
    );

    expect(properties).toHaveProperty("plusToken");
    expect(properties).not.toHaveProperty("coreToken");
  });

  it("describes the fallback when the committed config denies the replacement", () => {
    mockLoadConfig.mockReturnValue(explicitMainRoster());
    mockLoadPluginManifestRegistry.mockReturnValue(twoClaimantRegistry());

    const committed = {
      ...explicitMainRoster(),
      plugins: { deny: ["clickclack-plus"] },
    };
    const properties = clickclackProperties(
      buildRuntimeConfigSchemaForConfig(committed, committed),
    );

    expect(properties).toHaveProperty("coreToken");
    expect(properties).not.toHaveProperty("plusToken");
  });

  it("reads explicit selection from the authored config, not the runtime-shaped one", () => {
    // Regression: the builder handed the ownership policy its runtime-shaped config as the
    // authored one. That half carries `plugins.entries.<id>.config` records that validation
    // seeds from each enabled plugin's own config schema once the authored config has a
    // `plugins` key, and explicit selection counts any entry carrying a `config` record — so
    // every claimant read as hand-picked, the replacement's `preferOver` edge was set aside,
    // and the displaced first registrant's schema surfaced for the contested channel.
    mockLoadConfig.mockReturnValue(explicitMainRoster());
    // The displaced claimant registers first, so a suppressed edge hands it the channel and the
    // schemas disagree between the two readings.
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "clickclack-core",
          origin: "global",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: {
                type: "object",
                properties: { coreToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
        {
          id: "clickclack-plus",
          origin: "global",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              preferOver: ["clickclack-core"],
              schema: {
                type: "object",
                properties: { plusToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
      ],
    });

    // Authored config: a `plugins` key that hand-picks nothing. Validation's runtime shape of
    // exactly this config seeds an empty entry config for every enabled claimant.
    const authored = { ...explicitMainRoster(), plugins: {} };
    const runtimeShaped = {
      ...explicitMainRoster(),
      plugins: {
        entries: { "clickclack-core": { config: {} }, "clickclack-plus": { config: {} } },
      },
    };
    const properties = clickclackProperties(
      buildRuntimeConfigSchemaForConfig(runtimeShaped, authored),
    );

    expect(properties).toHaveProperty("plusToken");
    expect(properties).not.toHaveProperty("coreToken");
  });
});

describe("sensitivity survives schema displacement", () => {
  // A displaced plugin's config can remain under the shared channel when the replacement accepts
  // additional properties. Sensitivity belongs to the field, not to whoever won the schema, so
  // dropping the displaced hints would leave a retained secret with no hint and no name-shaped
  // fallback, and redaction would emit it.
  it("keeps a displaced claimant's sensitive hint on the surviving channel", () => {
    mockLoadConfig.mockReturnValue(explicitMainRoster());
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "clickclack-plus",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              preferOver: ["clickclack-core"],
              schema: {
                type: "object",
                properties: { plusToken: { type: "string" } },
                additionalProperties: true,
              },
              uiHints: { plusToken: { sensitive: true } },
            },
          },
        },
        {
          id: "clickclack-core",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: {
                type: "object",
                properties: { opaqueValue: { type: "string" } },
                additionalProperties: false,
              },
              // Innocuously named, so nothing recovers this if the hint is dropped.
              uiHints: { opaqueValue: { sensitive: true } },
            },
          },
        },
      ],
    });

    const { uiHints } = loadGatewayRuntimeConfigSchema();

    expect(uiHints["channels.clickclack.plusToken"]?.sensitive).toBe(true);
    expect(uiHints["channels.clickclack.opaqueValue"]?.sensitive).toBe(true);
  });
});

// Codex P1 3809323449 on #123209: redaction gates on `sensitive === true ||
// hasSensitiveUrlHintTag(hint)`, so a union carrying only `sensitive` still drops a URL-embedded
// credential that the displaced owner alone tagged `url-secret`.
describe("url-secret tags survive schema displacement", () => {
  it("keeps a displaced claimant's url-secret tag on the surviving channel", () => {
    mockLoadConfig.mockReturnValue(explicitMainRoster());
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "clickclack-plus",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              preferOver: ["clickclack-core"],
              schema: {
                type: "object",
                properties: { plusToken: { type: "string" } },
                additionalProperties: true,
              },
              uiHints: { plusToken: { sensitive: true } },
            },
          },
        },
        {
          id: "clickclack-core",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: {
                type: "object",
                properties: { endpoint: { type: "string" } },
                additionalProperties: false,
              },
              // Not `sensitive`; the credential rides in the URL, which is what the tag is for.
              uiHints: { endpoint: { label: "Endpoint", tags: ["url-secret"] } },
            },
          },
        },
      ],
    });

    const { uiHints } = loadGatewayRuntimeConfigSchema();

    expect(uiHints["channels.clickclack.endpoint"]?.tags).toContain("url-secret");
  });

  it("leaves the owner's own labels and tags intact", () => {
    mockLoadConfig.mockReturnValue(explicitMainRoster());
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "clickclack-plus",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              preferOver: ["clickclack-core"],
              schema: {
                type: "object",
                properties: { endpoint: { type: "string" } },
                additionalProperties: true,
              },
              uiHints: { endpoint: { label: "Plus endpoint", tags: ["advanced"] } },
            },
          },
        },
        {
          id: "clickclack-core",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: { type: "object", properties: { endpoint: { type: "string" } } },
              uiHints: { endpoint: { label: "Core endpoint", tags: ["url-secret"] } },
            },
          },
        },
      ],
    });

    const { uiHints } = loadGatewayRuntimeConfigSchema();
    const hint = uiHints["channels.clickclack.endpoint"];

    expect(hint?.label).toBe("Plus endpoint");
    expect(hint?.tags).toEqual(expect.arrayContaining(["advanced", "url-secret"]));
  });
});

describe("channel ownership excludes claimants activation never selects", () => {
  // Candidate discovery only returns plugins involved in a preferOver relationship. A third
  // claimant is therefore never enabled by auto-enable, but "not disabled" reads as active, and a
  // closer install origin then hands it the strict schema. The operator's real configuration is
  // validated against a plugin the runtime never activates, which can block Gateway startup.
  it("does not give the schema to an unrelated claimant with a closer origin", () => {
    mockLoadConfig.mockReturnValue({
      ...explicitMainRoster(),
      // A genuinely configured channel: an empty block is no presence signal at all, so
      // activation materializes no candidates and there is correctly nothing to narrow with.
      channels: { clickclack: { enabled: true, token: "x" } },
    });
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "clickclack-plus",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              preferOver: ["clickclack-core"],
              schema: {
                type: "object",
                properties: { plusToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
        {
          id: "clickclack-core",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: {
                type: "object",
                properties: { coreToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
        {
          // Closest origin, but no preferOver edge, so auto-enable never makes it a candidate.
          id: "clickclack-other",
          origin: "config",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: {
                type: "object",
                properties: { otherToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
      ],
    });

    const schema = loadGatewayRuntimeConfigSchema().schema as {
      properties?: Record<string, unknown>;
    };
    const channels = schema.properties?.channels as { properties?: Record<string, unknown> };
    const clickclack = channels?.properties?.clickclack as {
      properties?: Record<string, unknown>;
    };

    expect(clickclack?.properties).not.toHaveProperty("otherToken");
  });
  // Codex P1 3809638011 on #123209: `plugins.entries.<id>.enabled: true` is explicit activation at
  // startup (`config-activation-shared.ts:110`), which bypasses auto-enable candidate discovery
  // entirely. Narrowing to the candidate set alone would report this claimant inactive while the
  // runtime runs it — the same config/runtime disagreement, in the other direction.
  // Codex P1 3809838313 on #123209: explicit selection is keyed by whatever the operator wrote.
  // A legacy alias or a padded/cased variant still activates the plugin at startup, so canonicalizing
  // only the queried id leaves those spellings looking inactive here while the runtime runs them.
  it("honors an explicit enable written under a legacy alias", () => {
    mockLoadConfig.mockReturnValue({
      ...explicitMainRoster(),
      channels: { clickclack: { enabled: true, token: "x" } },
      plugins: { entries: { "  ClickClack-Other  ": { enabled: true } } },
    });
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "clickclack-plus",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              preferOver: ["clickclack-core"],
              schema: {
                type: "object",
                properties: { plusToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
        {
          id: "clickclack-core",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: {
                type: "object",
                properties: { coreToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
        {
          id: "clickclack-other",
          origin: "config",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: {
                type: "object",
                properties: { otherToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
      ],
    });

    const schema = loadGatewayRuntimeConfigSchema().schema as {
      properties?: Record<string, unknown>;
    };
    const channels = schema.properties?.channels as { properties?: Record<string, unknown> };
    const clickclack = channels?.properties?.clickclack as {
      properties?: Record<string, unknown>;
    };

    expect(clickclack?.properties).toHaveProperty("otherToken");
  });

  it("keeps an explicitly enabled claimant active even when it is not a candidate", () => {
    mockLoadConfig.mockReturnValue({
      ...explicitMainRoster(),
      channels: { clickclack: { enabled: true, token: "x" } },
      plugins: { entries: { "clickclack-other": { enabled: true } } },
    });
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "clickclack-plus",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              preferOver: ["clickclack-core"],
              schema: {
                type: "object",
                properties: { plusToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
        {
          id: "clickclack-core",
          origin: "workspace",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: {
                type: "object",
                properties: { coreToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
        {
          // Closest origin and hand-enabled by the operator, so startup activates it and channel
          // registration keeps it as the first owner.
          id: "clickclack-other",
          origin: "config",
          channels: ["clickclack"],
          channelConfigs: {
            clickclack: {
              schema: {
                type: "object",
                properties: { otherToken: { type: "string" } },
                additionalProperties: false,
              },
            },
          },
        },
      ],
    });

    const schema = loadGatewayRuntimeConfigSchema().schema as {
      properties?: Record<string, unknown>;
    };
    const channels = schema.properties?.channels as { properties?: Record<string, unknown> };
    const clickclack = channels?.properties?.clickclack as {
      properties?: Record<string, unknown>;
    };

    expect(clickclack?.properties).toHaveProperty("otherToken");
  });
});
