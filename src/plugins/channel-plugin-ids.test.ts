import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const listPotentialConfiguredChannelIds = vi.hoisted(() => vi.fn());
const hasPotentialConfiguredChannels = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());

vi.mock("../channels/config-presence.js", () => ({
  listPotentialConfiguredChannelIds,
  hasPotentialConfiguredChannels,
}));

vi.mock("./manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry,
  };
});

import {
  resolveConfiguredChannelPluginIds,
  resolveGatewayStartupPluginIds,
} from "./channel-plugin-ids.js";

function createManifestRegistryFixture() {
  return {
    plugins: [
      {
        id: "demo-channel",
        channels: ["demo-channel"],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "demo-other-channel",
        channels: ["demo-other-channel"],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "browser",
        channels: [],
        origin: "bundled",
        enabledByDefault: true,
        providers: [],
        cliBackends: [],
      },
      {
        id: "demo-provider-plugin",
        channels: [],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: ["demo-provider"],
        cliBackends: ["demo-cli"],
      },
      {
        id: "activation-only-channel-plugin",
        channels: [],
        activation: {
          onChannels: ["activation-only-channel"],
        },
        origin: "bundled",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "workspace-activation-channel-plugin",
        channels: [],
        activation: {
          onChannels: ["workspace-activation-channel"],
        },
        origin: "workspace",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "global-activation-channel-plugin",
        channels: [],
        activation: {
          onChannels: ["global-activation-channel"],
        },
        origin: "global",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "voice-call",
        channels: [],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "memory-core",
        kind: "memory",
        channels: [],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "memory-lancedb",
        kind: "memory",
        channels: [],
        origin: "bundled",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "demo-global-sidecar",
        channels: [],
        origin: "global",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
    ],
    diagnostics: [],
  };
}

function expectStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  expected: readonly string[];
}) {
  expect(
    resolveGatewayStartupPluginIds({
      config: params.config,
      ...(params.activationSourceConfig !== undefined
        ? { activationSourceConfig: params.activationSourceConfig }
        : {}),
      workspaceDir: "/tmp",
      env: process.env,
    }),
  ).toEqual(params.expected);
  expect(loadPluginManifestRegistry).toHaveBeenCalled();
}

function expectStartupPluginIdsCase(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  expected: readonly string[];
}) {
  expectStartupPluginIds(params);
}

function createStartupConfig(params: {
  enabledPluginIds?: string[];
  providerIds?: string[];
  modelId?: string;
  channelIds?: string[];
  allowPluginIds?: string[];
  noConfiguredChannels?: boolean;
  memorySlot?: string;
}) {
  return {
    ...(params.noConfiguredChannels
      ? {
          channels: {},
        }
      : params.channelIds?.length
        ? {
            channels: Object.fromEntries(
              params.channelIds.map((channelId) => [channelId, { enabled: true }]),
            ),
          }
        : {}),
    ...(params.enabledPluginIds?.length
      ? {
          plugins: {
            ...(params.allowPluginIds?.length ? { allow: params.allowPluginIds } : {}),
            ...(params.memorySlot ? { slots: { memory: params.memorySlot } } : {}),
            entries: Object.fromEntries(
              params.enabledPluginIds.map((pluginId) => [pluginId, { enabled: true }]),
            ),
          },
        }
      : params.allowPluginIds?.length
        ? {
            plugins: {
              allow: params.allowPluginIds,
            },
          }
        : params.memorySlot
          ? {
              plugins: {
                slots: {
                  memory: params.memorySlot,
                },
              },
            }
          : {}),
    ...(params.providerIds?.length
      ? {
          models: {
            providers: Object.fromEntries(
              params.providerIds.map((providerId) => [
                providerId,
                {
                  baseUrl: "https://example.com",
                  models: [],
                },
              ]),
            ),
          },
        }
      : {}),
    ...(params.modelId
      ? {
          agents: {
            defaults: {
              model: { primary: params.modelId },
              models: {
                [params.modelId]: {},
              },
            },
          },
        }
      : {}),
  } as OpenClawConfig;
}

describe("resolveGatewayStartupPluginIds", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockReset().mockImplementation((config: OpenClawConfig) => {
      if (Object.prototype.hasOwnProperty.call(config, "channels")) {
        return Object.keys(config.channels ?? {});
      }
      return ["demo-channel"];
    });
    hasPotentialConfiguredChannels.mockReset().mockImplementation((config: OpenClawConfig) => {
      if (Object.prototype.hasOwnProperty.call(config, "channels")) {
        return Object.keys(config.channels ?? {}).length > 0;
      }
      return true;
    });
    loadPluginManifestRegistry.mockReset().mockReturnValue(createManifestRegistryFixture());
  });

  it.each([
    [
      "includes only configured channel plugins at idle startup",
      createStartupConfig({
        enabledPluginIds: ["voice-call"],
        modelId: "demo-cli/demo-model",
      }),
      ["demo-channel", "browser", "voice-call"],
    ],
    [
      "keeps bundled startup sidecars with enabledByDefault at idle startup",
      {} as OpenClawConfig,
      ["demo-channel", "browser"],
    ],
    [
      "keeps provider plugins out of idle startup when only provider config references them",
      createStartupConfig({
        providerIds: ["demo-provider"],
      }),
      ["demo-channel", "browser"],
    ],
    [
      "includes explicitly enabled non-channel sidecars in startup scope",
      createStartupConfig({
        enabledPluginIds: ["demo-global-sidecar", "voice-call"],
      }),
      ["demo-channel", "browser", "voice-call", "demo-global-sidecar"],
    ],
    [
      "keeps default-enabled startup sidecars when a restrictive allowlist permits them",
      createStartupConfig({
        allowPluginIds: ["browser"],
        noConfiguredChannels: true,
      }),
      ["browser"],
    ],
    [
      "includes every configured channel plugin and excludes other channels",
      createStartupConfig({
        channelIds: ["demo-channel", "demo-other-channel"],
      }),
      ["demo-channel", "demo-other-channel", "browser"],
    ],
  ] as const)("%s", (_name, config, expected) => {
    expectStartupPluginIdsCase({ config, expected });
  });

  it("keeps effective-only bundled sidecars behind restrictive allowlists", () => {
    const rawConfig = createStartupConfig({
      allowPluginIds: ["browser"],
    });
    const effectiveConfig = {
      ...rawConfig,
      plugins: {
        allow: ["browser"],
        entries: {
          "voice-call": {
            enabled: true,
          },
          "memory-core": {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    expectStartupPluginIdsCase({
      config: effectiveConfig,
      activationSourceConfig: rawConfig,
      expected: ["demo-channel", "browser"],
    });
  });

  it("includes the explicitly selected memory slot plugin in startup scope", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        enabledPluginIds: ["memory-lancedb"],
        memorySlot: "memory-lancedb",
      }),
      expected: ["demo-channel", "browser", "memory-lancedb"],
    });
  });

  it("normalizes the raw memory slot id before startup filtering", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        enabledPluginIds: ["memory-core"],
        memorySlot: "Memory-Core",
      }),
      expected: ["demo-channel", "browser", "memory-core"],
    });
  });

  it("does not include non-selected memory plugins only because they are enabled", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        enabledPluginIds: ["memory-lancedb"],
      }),
      expected: ["demo-channel", "browser"],
    });
  });
});

describe("resolveConfiguredChannelPluginIds", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockReset().mockImplementation((config: OpenClawConfig) => {
      if (Object.prototype.hasOwnProperty.call(config, "channels")) {
        return Object.keys(config.channels ?? {});
      }
      return [];
    });
    hasPotentialConfiguredChannels.mockReset().mockImplementation((config: OpenClawConfig) => {
      if (Object.prototype.hasOwnProperty.call(config, "channels")) {
        return Object.keys(config.channels ?? {}).length > 0;
      }
      return false;
    });
    loadPluginManifestRegistry.mockReset().mockReturnValue(createManifestRegistryFixture());
  });

  it("uses manifest activation channel ownership before falling back to direct channel lists", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: createStartupConfig({
          channelIds: ["activation-only-channel"],
        }),
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual(["activation-only-channel-plugin"]);
  });

  it("keeps bundled activation owners behind restrictive allowlists", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: createStartupConfig({
          channelIds: ["activation-only-channel"],
          allowPluginIds: ["browser"],
        }),
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual([]);
  });

  it("blocks bundled activation owners when explicitly denied", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: {
          channels: {
            "activation-only-channel": { enabled: true },
          },
          plugins: {
            deny: ["activation-only-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual([]);
  });

  it("blocks bundled activation owners when plugins are globally disabled", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: {
          channels: {
            "activation-only-channel": { enabled: true },
          },
          plugins: {
            enabled: false,
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual([]);
  });

  it("filters untrusted workspace activation owners from configured-channel runtime planning", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: createStartupConfig({
          channelIds: ["workspace-activation-channel"],
        }),
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual([]);
  });

  it("filters untrusted global activation owners from configured-channel runtime planning", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: createStartupConfig({
          channelIds: ["global-activation-channel"],
        }),
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual([]);
  });

  it("keeps explicitly enabled global activation owners eligible for configured-channel runtime planning", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: createStartupConfig({
          channelIds: ["global-activation-channel"],
          enabledPluginIds: ["global-activation-channel-plugin"],
        }),
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual(["global-activation-channel-plugin"]);
  });

  it("does not treat auto-enabled non-bundled channel owners as explicitly trusted", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: createStartupConfig({
          channelIds: ["global-activation-channel"],
          enabledPluginIds: ["global-activation-channel-plugin"],
        }),
        activationSourceConfig: createStartupConfig({
          channelIds: ["global-activation-channel"],
        }),
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual([]);
  });

  it("blocks bundled activation owners when explicitly disabled", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: {
          channels: {
            "activation-only-channel": { enabled: true },
          },
          plugins: {
            entries: {
              "activation-only-channel-plugin": {
                enabled: false,
              },
            },
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: process.env,
      }),
    ).toEqual([]);
  });
});
