import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

const listPotentialConfiguredChannelIds = vi.hoisted(() => vi.fn());
const listExplicitlyDisabledChannelIdsForConfig = vi.hoisted(() =>
  vi.fn((config: OpenClawConfig) => {
    return Object.entries(config.channels ?? {})
      .filter(([, value]) => {
        return (
          !!value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (value as { enabled?: unknown }).enabled === false
        );
      })
      .map(([channelId]) => channelId.toLowerCase());
  }),
);
const listPotentialConfiguredChannelPresenceSignals = vi.hoisted(() => vi.fn());
const hasPotentialConfiguredChannels = vi.hoisted(() => vi.fn());
const hasMeaningfulChannelConfig = vi.hoisted(() =>
  vi.fn((value: unknown) => {
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).some((key) => key !== "enabled")
    );
  }),
);
const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForInstalledIndex = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForPluginRegistry = vi.hoisted(() => vi.fn());
const loadPluginRegistrySnapshot = vi.hoisted(() => vi.fn());

vi.mock("../channels/config-presence.js", () => ({
  listPotentialConfiguredChannelIds,
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelPresenceSignals,
  hasPotentialConfiguredChannels,
  hasMeaningfulChannelConfig,
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("./plugin-registry-snapshot.js", () => ({ loadPluginRegistrySnapshot }));

vi.mock("./plugin-registry-contributions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry-contributions.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry,
  };
});

import {
  hasConfiguredChannelsForReadOnlyScope,
  listConfiguredAnnounceChannelIdsForConfig,
  listConfiguredChannelIdsForReadOnlyScope,
  listExplicitConfiguredChannelIdsForConfig,
  resolveConfiguredChannelPresencePolicy,
  resolveConfiguredDeferredChannelPluginIds,
  resolveConfiguredChannelPluginIds,
  resolveGatewayStartupPluginIds,
} from "./channel-plugin-ids.js";

function withManifestLoadPaths<T extends { id: string }>(
  plugin: T,
): T & Pick<PluginManifestRecord, "rootDir" | "source" | "manifestPath" | "skills" | "hooks"> {
  return {
    rootDir: `/tmp/plugins/${plugin.id}`,
    source: `/tmp/plugins/${plugin.id}/index.ts`,
    manifestPath: `/tmp/plugins/${plugin.id}/openclaw.plugin.json`,
    skills: [],
    hooks: [],
    ...plugin,
  };
}

function createManifestRegistryFixture(): PluginManifestRegistry {
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
        activation: {
          onConfigPaths: ["browser"],
        },
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
        id: "anthropic",
        channels: [],
        origin: "bundled",
        enabledByDefault: true,
        providers: ["anthropic"],
        cliBackends: ["claude-cli"],
      },
      {
        id: "openai",
        channels: [],
        origin: "bundled",
        enabledByDefault: true,
        providers: ["openai", "openai-codex"],
        cliBackends: ["codex-cli"],
      },
      {
        id: "google",
        channels: [],
        origin: "bundled",
        enabledByDefault: true,
        providers: ["google", "google-gemini-cli"],
        cliBackends: ["google-gemini-cli"],
      },
      {
        id: "codex",
        channels: [],
        activation: {
          onAgentHarnesses: ["codex"],
        },
        origin: "bundled",
        enabledByDefault: undefined,
        providers: ["codex"],
        cliBackends: [],
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
        id: "external-env-channel-plugin",
        channels: ["external-env-channel"],
        channelEnvVars: {
          "external-env-channel": ["EXTERNAL_ENV_CHANNEL_TOKEN"],
        },
        origin: "config",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "ambient-env-channel-plugin",
        channels: ["ambient-env-channel"],
        channelEnvVars: {
          "ambient-env-channel": ["HOME", "PATH"],
        },
        origin: "config",
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
      {
        id: "demo-global-startup-opt-out",
        channels: [],
        activation: {
          onStartup: false,
        },
        origin: "global",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
      {
        id: "demo-global-explicit-startup",
        channels: [],
        activation: {
          onStartup: true,
        },
        origin: "global",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      },
    ].map(withManifestLoadPaths) as PluginManifestRecord[],
    diagnostics: [],
  };
}

function createManifestRegistryFixtureWithWorkspaceDemoChannel(): PluginManifestRegistry {
  const fixture = createManifestRegistryFixture();
  return {
    ...fixture,
    plugins: [
      ...fixture.plugins,
      withManifestLoadPaths({
        id: "workspace-demo-channel-plugin",
        channels: ["demo-channel"],
        startupDeferConfiguredChannelFullLoadUntilAfterListen: true,
        origin: "workspace",
        enabledByDefault: undefined,
        providers: [],
        cliBackends: [],
      }),
    ],
  };
}

function normalizeStartupAgentHarnesses(record: PluginManifestRecord): readonly string[] {
  return [
    ...new Set([...(record.activation?.onAgentHarnesses ?? []), ...(record.cliBackends ?? [])]),
  ].toSorted((left, right) => left.localeCompare(right));
}

function hasRuntimeContractSurface(record: PluginManifestRecord): boolean {
  return record.providers.length > 0 || record.cliBackends.length > 0;
}

function hasPluginKind(record: PluginManifestRecord, kind: string): boolean {
  return Array.isArray(record.kind) ? record.kind.includes(kind as never) : record.kind === kind;
}

function createInstalledPluginRecordFixture(
  record: PluginManifestRecord,
): InstalledPluginIndexRecord {
  const memory = hasPluginKind(record, "memory");
  return {
    pluginId: record.id,
    manifestPath: record.manifestPath,
    manifestHash: `test-${record.id}`,
    source: record.source,
    rootDir: record.rootDir,
    origin: record.origin,
    enabled: true,
    ...(record.enabledByDefault === true ? { enabledByDefault: true } : {}),
    startup: {
      sidecar:
        record.activation?.onStartup === true ||
        (record.activation?.onStartup === undefined &&
          record.channels.length === 0 &&
          !hasRuntimeContractSurface(record) &&
          !memory),
      memory,
      deferConfiguredChannelFullLoadUntilAfterListen:
        record.startupDeferConfiguredChannelFullLoadUntilAfterListen === true,
      agentHarnesses: normalizeStartupAgentHarnesses(record),
    },
    compat: [],
  };
}

function createInstalledPluginIndexFixture(
  registry: PluginManifestRegistry = loadPluginManifestRegistry(),
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins: registry.plugins.map(createInstalledPluginRecordFixture),
    diagnostics: registry.diagnostics,
  };
}

function filterManifestRegistryForInstalledIndex(params: {
  pluginIds?: readonly string[];
  includeDisabled?: boolean;
}): PluginManifestRegistry {
  const registry = loadPluginManifestRegistry() as PluginManifestRegistry;
  const pluginIdSet = params.pluginIds?.length ? new Set(params.pluginIds) : null;
  return {
    ...registry,
    plugins: pluginIdSet
      ? registry.plugins.filter((plugin) => pluginIdSet.has(plugin.id))
      : registry.plugins,
  };
}

function useManifestRegistryFixture(
  registry: PluginManifestRegistry = createManifestRegistryFixture(),
) {
  const index = createInstalledPluginIndexFixture(registry);
  loadPluginManifestRegistry.mockReset().mockReturnValue(registry);
  loadPluginRegistrySnapshot.mockReset().mockReturnValue(index);
  return { registry, index };
}

function expectStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  expected: readonly string[];
}) {
  expect(
    resolveGatewayStartupPluginIds({
      config: params.config,
      ...(params.activationSourceConfig !== undefined
        ? { activationSourceConfig: params.activationSourceConfig }
        : {}),
      workspaceDir: "/tmp",
      env: params.env ?? process.env,
    }),
  ).toEqual(params.expected);
  expect(loadPluginManifestRegistry).toHaveBeenCalled();
}

function expectStartupPluginIdsCase(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  expected: readonly string[];
}) {
  expectStartupPluginIds(params);
}

function createStartupConfig(params: {
  enabledPluginIds?: string[];
  providerIds?: string[];
  modelId?: string;
  agentRuntimeId?: string;
  agentRuntimeIds?: string[];
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
              ...(params.agentRuntimeId
                ? {
                    agentRuntime: {
                      id: params.agentRuntimeId,
                      fallback: "none",
                    },
                  }
                : {}),
              models: {
                [params.modelId]: {},
              },
            },
            ...(params.agentRuntimeIds?.length
              ? {
                  list: params.agentRuntimeIds.map((runtime, index) => ({
                    id: `agent-${index + 1}`,
                    agentRuntime: { id: runtime },
                  })),
                }
              : {}),
          },
        }
      : params.agentRuntimeId || params.agentRuntimeIds?.length
        ? {
            agents: {
              defaults: params.agentRuntimeId
                ? {
                    agentRuntime: {
                      id: params.agentRuntimeId,
                      fallback: "none",
                    },
                  }
                : {},
              ...(params.agentRuntimeIds?.length
                ? {
                    list: params.agentRuntimeIds.map((runtime, index) => ({
                      id: `agent-${index + 1}`,
                      agentRuntime: { id: runtime },
                    })),
                  }
                : {}),
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
    listPotentialConfiguredChannelPresenceSignals
      .mockReset()
      .mockImplementation((config: OpenClawConfig) => {
        return listPotentialConfiguredChannelIds(config).map((channelId: string) => ({
          channelId,
          source: "config",
        }));
      });
    hasPotentialConfiguredChannels.mockReset().mockImplementation((config: OpenClawConfig) => {
      if (Object.prototype.hasOwnProperty.call(config, "channels")) {
        return Object.keys(config.channels ?? {}).length > 0;
      }
      return true;
    });
    useManifestRegistryFixture();
    loadPluginManifestRegistryForInstalledIndex
      .mockReset()
      .mockImplementation(filterManifestRegistryForInstalledIndex);
    loadPluginManifestRegistryForPluginRegistry
      .mockReset()
      .mockImplementation(() => loadPluginManifestRegistry());
  });

  it.each([
    [
      "includes only configured channel plugins at idle startup",
      createStartupConfig({
        enabledPluginIds: ["voice-call"],
        modelId: "demo-cli/demo-model",
      }),
      ["demo-channel", "browser", "voice-call", "memory-core"],
    ],
    [
      "keeps bundled startup sidecars with enabledByDefault at idle startup",
      {} as OpenClawConfig,
      ["demo-channel", "browser", "memory-core"],
    ],
    [
      "keeps provider plugins out of idle startup when only provider config references them",
      createStartupConfig({
        providerIds: ["demo-provider"],
      }),
      ["demo-channel", "browser", "memory-core"],
    ],
    [
      "includes explicitly enabled non-channel sidecars in startup scope",
      createStartupConfig({
        enabledPluginIds: ["demo-global-sidecar", "voice-call"],
      }),
      ["demo-channel", "browser", "voice-call", "memory-core", "demo-global-sidecar"],
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
      ["demo-channel", "demo-other-channel", "browser", "memory-core"],
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
      expected: ["browser"],
    });
  });

  it("does not let runtime-default plugin entries bypass the authored startup allowlist", () => {
    const activationSourceConfig = {
      channels: {},
      plugins: {
        allow: ["bench-plugin"],
        entries: {
          browser: {
            enabled: false,
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      ...activationSourceConfig,
      plugins: {
        ...activationSourceConfig.plugins,
        entries: {
          ...activationSourceConfig.plugins?.entries,
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

    expectStartupPluginIdsCase({
      config: runtimeConfig,
      activationSourceConfig,
      expected: [],
    });
  });

  it("keeps deprecated implicit startup sidecar fallback for legacy plugins", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        enabledPluginIds: ["demo-global-sidecar"],
        allowPluginIds: ["demo-global-sidecar"],
        noConfiguredChannels: true,
        memorySlot: "none",
      }),
      expected: ["demo-global-sidecar"],
    });
  });

  it("can disable deprecated implicit startup sidecar fallback for future-mode testing", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        enabledPluginIds: ["demo-global-sidecar"],
        allowPluginIds: ["demo-global-sidecar"],
        noConfiguredChannels: true,
        memorySlot: "none",
      }),
      env: {
        ...process.env,
        OPENCLAW_DISABLE_LEGACY_IMPLICIT_STARTUP_SIDECARS: "1",
      },
      expected: [],
    });
  });

  it("skips deprecated implicit startup sidecar fallback when activation.onStartup is false", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        enabledPluginIds: ["demo-global-startup-opt-out"],
        allowPluginIds: ["demo-global-startup-opt-out"],
        noConfiguredChannels: true,
        memorySlot: "none",
      }),
      expected: [],
    });
  });

  it("loads explicit startup plugins when activation.onStartup is true", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        enabledPluginIds: ["demo-global-explicit-startup"],
        allowPluginIds: ["demo-global-explicit-startup"],
        noConfiguredChannels: true,
        memorySlot: "none",
      }),
      env: {
        ...process.env,
        OPENCLAW_DISABLE_LEGACY_IMPLICIT_STARTUP_SIDECARS: "1",
      },
      expected: ["demo-global-explicit-startup"],
    });
  });

  it("starts bundled sidecars selected by root config activation paths", () => {
    const rawConfig = {
      browser: {
        enabled: true,
        defaultProfile: "docker-cdp",
      },
      channels: {},
    } satisfies OpenClawConfig;
    const effectiveConfig = {
      ...rawConfig,
      plugins: {
        entries: {
          browser: {
            enabled: true,
          },
        },
      },
    } satisfies OpenClawConfig;

    expectStartupPluginIdsCase({
      config: effectiveConfig,
      activationSourceConfig: rawConfig,
      expected: ["browser", "memory-core"],
    });
  });

  it("lets bundled root config activation paths bypass restrictive allowlists", () => {
    expectStartupPluginIdsCase({
      config: {
        browser: {
          enabled: true,
        },
        channels: {},
        plugins: {
          allow: ["telegram"],
        },
      },
      expected: ["browser"],
    });
  });

  it("does not bypass restrictive allowlists for disabled root config activation paths", () => {
    expectStartupPluginIdsCase({
      config: {
        browser: {
          enabled: false,
        },
        channels: {},
        plugins: {
          allow: ["telegram"],
        },
      },
      expected: [],
    });
  });

  it("does not let weak channel presence start untrusted workspace channel owners", () => {
    useManifestRegistryFixture(createManifestRegistryFixtureWithWorkspaceDemoChannel());
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    const config = {} as OpenClawConfig;

    expectStartupPluginIdsCase({
      config,
      env: {
        DEMO_CHANNEL_ANYTHING: "1",
      } as NodeJS.ProcessEnv,
      expected: ["demo-channel", "browser", "memory-core"],
    });
    expect(
      resolveConfiguredDeferredChannelPluginIds({
        config,
        workspaceDir: "/tmp",
        env: {
          DEMO_CHANNEL_ANYTHING: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual([]);
  });

  it("keeps explicitly trusted deferred channel owners eligible at startup", () => {
    useManifestRegistryFixture(createManifestRegistryFixtureWithWorkspaceDemoChannel());
    expect(
      resolveConfiguredDeferredChannelPluginIds({
        config: {
          channels: {
            "demo-channel": {
              token: "configured",
            },
          },
          plugins: {
            allow: ["workspace-demo-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
      }),
    ).toEqual(["workspace-demo-channel-plugin"]);
  });

  it("preserves explicit bundled channel config under restrictive allowlists", () => {
    expectStartupPluginIdsCase({
      config: {
        channels: {
          "demo-channel": {
            token: "configured",
          },
        },
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
      env: {},
      expected: ["demo-channel", "browser"],
    });
  });

  it("does not treat explicitly disabled stale channel config as startup intent", () => {
    expectStartupPluginIdsCase({
      config: {
        channels: {
          "demo-channel": {
            enabled: false,
            token: "stale",
          },
        },
      } as OpenClawConfig,
      env: {},
      expected: ["browser", "memory-core"],
    });
  });

  it("does not treat persisted auth alone as gateway startup intent", () => {
    listPotentialConfiguredChannelIds.mockImplementation(
      (
        _config: OpenClawConfig,
        _env: NodeJS.ProcessEnv,
        options?: { includePersistedAuthState?: boolean },
      ) => (options?.includePersistedAuthState === false ? [] : ["demo-channel"]),
    );

    expectStartupPluginIdsCase({
      config: {} as OpenClawConfig,
      env: {
        OPENCLAW_STATE_DIR: "/tmp/openclaw-with-persisted-demo-channel",
      } as NodeJS.ProcessEnv,
      expected: ["browser", "memory-core"],
    });
  });

  it("does not treat persisted auth alone as deferred channel startup intent", () => {
    useManifestRegistryFixture(createManifestRegistryFixtureWithWorkspaceDemoChannel());
    listPotentialConfiguredChannelIds.mockImplementation(
      (
        _config: OpenClawConfig,
        _env: NodeJS.ProcessEnv,
        options?: { includePersistedAuthState?: boolean },
      ) => (options?.includePersistedAuthState === false ? [] : ["demo-channel"]),
    );

    expect(
      resolveConfiguredDeferredChannelPluginIds({
        config: {
          plugins: {
            allow: ["workspace-demo-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-with-persisted-demo-channel",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual([]);
  });

  it("does not treat explicitly disabled stale channel config as deferred startup intent", () => {
    useManifestRegistryFixture(createManifestRegistryFixtureWithWorkspaceDemoChannel());

    expect(
      resolveConfiguredDeferredChannelPluginIds({
        config: {
          channels: {
            "demo-channel": {
              enabled: false,
              token: "stale",
            },
          },
          plugins: {
            allow: ["workspace-demo-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
      }),
    ).toEqual([]);
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

  it("includes the default memory slot plugin when the allowlist permits it", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        allowPluginIds: ["browser", "memory-core"],
        noConfiguredChannels: true,
      }),
      expected: ["browser", "memory-core"],
    });
  });

  it("does not include non-selected memory plugins only because they are enabled", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        enabledPluginIds: ["memory-lancedb"],
      }),
      expected: ["demo-channel", "browser", "memory-core"],
    });
  });

  it("includes required agent harness owner plugins when the default runtime is forced", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        agentRuntimeId: "codex",
        enabledPluginIds: ["codex"],
      }),
      expected: ["demo-channel", "browser", "codex", "memory-core"],
    });
  });

  it("includes required agent harness owner plugins when an agent override forces the runtime", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        agentRuntimeIds: ["codex"],
        enabledPluginIds: ["codex"],
      }),
      expected: ["demo-channel", "browser", "codex", "memory-core"],
    });
  });

  it("includes required agent harness owner plugins when env forces the runtime", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        enabledPluginIds: ["codex"],
      }),
      env: { OPENCLAW_AGENT_RUNTIME: "codex" },
      expected: ["demo-channel", "browser", "codex", "memory-core"],
    });
  });

  it("includes required CLI backend owner plugins when the default runtime is forced", () => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        agentRuntimeId: "demo-cli",
        enabledPluginIds: ["demo-provider-plugin"],
      }),
      expected: ["demo-channel", "browser", "demo-provider-plugin", "memory-core"],
    });
  });

  it.each([
    ["claude-cli", "anthropic"],
    ["codex-cli", "openai"],
    ["google-gemini-cli", "google"],
  ] as const)("includes the bundled %s CLI backend owner at startup", (runtime, pluginId) => {
    expectStartupPluginIdsCase({
      config: createStartupConfig({
        agentRuntimeId: runtime,
      }),
      expected: ["demo-channel", "browser", pluginId, "memory-core"],
    });
  });

  it("does not include required CLI backend owner plugins when they are explicitly disabled", () => {
    expectStartupPluginIdsCase({
      config: {
        agents: {
          defaults: {
            agentRuntime: {
              id: "demo-cli",
              fallback: "none",
            },
          },
        },
        plugins: {
          entries: {
            "demo-provider-plugin": {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig,
      expected: ["demo-channel", "browser", "memory-core"],
    });
  });

  it("does not include required agent harness owner plugins when they are explicitly disabled", () => {
    expectStartupPluginIdsCase({
      config: {
        agents: {
          defaults: {
            agentRuntime: {
              id: "codex",
              fallback: "none",
            },
          },
        },
        plugins: {
          entries: {
            codex: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig,
      expected: ["demo-channel", "browser", "memory-core"],
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
    listPotentialConfiguredChannelPresenceSignals
      .mockReset()
      .mockImplementation((config: OpenClawConfig) => {
        return listPotentialConfiguredChannelIds(config).map((channelId: string) => ({
          channelId,
          source: "config",
        }));
      });
    hasPotentialConfiguredChannels.mockReset().mockImplementation((config: OpenClawConfig) => {
      if (Object.prototype.hasOwnProperty.call(config, "channels")) {
        return Object.keys(config.channels ?? {}).length > 0;
      }
      return false;
    });
    useManifestRegistryFixture();
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

  it("keeps explicitly configured bundled channel owners under restrictive allowlists", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: {
          channels: {
            "demo-channel": {
              token: "configured",
            },
          },
          plugins: {
            allow: ["browser"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
      }),
    ).toEqual(["demo-channel"]);
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

  it("includes trusted external channel owners configured only by manifest env vars", () => {
    expect(
      resolveConfiguredChannelPluginIds({
        config: {
          plugins: {
            allow: ["external-env-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          EXTERNAL_ENV_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["external-env-channel-plugin"]);
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

describe("listConfiguredChannelIdsForReadOnlyScope", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockReset().mockReturnValue([]);
    listPotentialConfiguredChannelPresenceSignals.mockReset().mockReturnValue([]);
    hasPotentialConfiguredChannels.mockReset().mockReturnValue(false);
    hasMeaningfulChannelConfig.mockClear();
    useManifestRegistryFixture();
  });

  it("filters bundled ambient channel triggers through effective activation", () => {
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          plugins: {
            allow: ["memory-core"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          DEMO_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual([]);

    expect(
      hasConfiguredChannelsForReadOnlyScope({
        config: {
          plugins: {
            allow: ["memory-core"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          DEMO_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toBe(false);
  });

  it("returns reason-rich policy entries for blocked ambient channel triggers", () => {
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    expect(
      resolveConfiguredChannelPresencePolicy({
        config: {
          plugins: {
            allow: ["memory-core"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          DEMO_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual([
      {
        channelId: "demo-channel",
        sources: ["env"],
        effective: false,
        pluginIds: [],
        blockedReasons: ["not-in-allowlist"],
      },
    ]);
  });

  it("keeps explicitly enabled bundled ambient channel triggers", () => {
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          plugins: {
            entries: {
              "demo-channel": {
                enabled: true,
              },
            },
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          DEMO_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual(["demo-channel"]);
  });

  it("treats enabled-only channel config as explicit read-only intent", () => {
    expect(
      resolveConfiguredChannelPresencePolicy({
        config: {
          channels: {
            "demo-channel": {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
        includePersistedAuthState: false,
      }),
    ).toEqual([
      {
        channelId: "demo-channel",
        sources: ["explicit-config"],
        effective: true,
        pluginIds: ["demo-channel"],
        blockedReasons: [],
      },
    ]);

    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          channels: {
            "demo-channel": {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
        includePersistedAuthState: false,
      }),
    ).toEqual(["demo-channel"]);
  });

  it("does not treat disabled stale channel config as explicit read-only intent", () => {
    const config = {
      channels: {
        "demo-channel": {
          enabled: false,
          token: "stale-token",
        },
      },
    } as OpenClawConfig;

    expect(listExplicitConfiguredChannelIdsForConfig(config)).toEqual([]);
    expect(
      resolveConfiguredChannelPresencePolicy({
        config,
        workspaceDir: "/tmp",
        env: {},
        includePersistedAuthState: false,
      }),
    ).toEqual([]);
    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config,
        workspaceDir: "/tmp",
        env: {},
        includePersistedAuthState: false,
      }),
    ).toEqual([]);
  });

  it("treats disabled channel config as a hard read-only env suppressor", () => {
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    const config = {
      channels: {
        "Demo-Channel": {
          enabled: false,
          token: "stale-token",
        },
      },
      plugins: {
        entries: {
          "demo-channel": {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveConfiguredChannelPresencePolicy({
        config,
        workspaceDir: "/tmp",
        env: {
          DEMO_CHANNEL_TOKEN: "ambient",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual([]);
    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config,
        workspaceDir: "/tmp",
        env: {
          DEMO_CHANNEL_TOKEN: "ambient",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual([]);
  });

  it("treats disabled channel config as a hard persisted-auth suppressor", () => {
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "persisted-auth" },
    ]);

    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          channels: {
            "demo-channel": {
              enabled: false,
            },
          },
          plugins: {
            entries: {
              "demo-channel": {
                enabled: true,
              },
            },
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
      }),
    ).toEqual([]);
  });

  it("treats disabled channel config as a hard manifest-env suppressor", () => {
    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          channels: {
            "external-env-channel": {
              enabled: false,
            },
          },
          plugins: {
            allow: ["external-env-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          EXTERNAL_ENV_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual([]);
  });

  it("lets explicit bundled channel config bypass restrictive allowlists", () => {
    const config = {
      channels: {
        "demo-channel": {
          token: "configured",
        },
      },
      plugins: {
        allow: ["browser"],
      },
    } as OpenClawConfig;

    expect(
      resolveConfiguredChannelPresencePolicy({
        config,
        workspaceDir: "/tmp",
        env: {},
        includePersistedAuthState: false,
      }),
    ).toEqual([
      {
        channelId: "demo-channel",
        sources: ["explicit-config"],
        effective: true,
        pluginIds: ["demo-channel"],
        blockedReasons: [],
      },
    ]);
    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config,
        workspaceDir: "/tmp",
        env: {},
        includePersistedAuthState: false,
      }),
    ).toEqual(["demo-channel"]);
  });

  it("keeps explicitly configured bundled channels discovered from potential ids", () => {
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "config" },
    ]);

    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          channels: {
            "demo-channel": {
              token: "configured",
            },
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
        includePersistedAuthState: false,
      }),
    ).toEqual(["demo-channel"]);
  });

  it("blocks explicitly configured bundled channels when plugins are disabled or denied", () => {
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "config" },
    ]);

    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          channels: {
            "demo-channel": {
              token: "configured",
            },
          },
          plugins: {
            enabled: false,
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
        includePersistedAuthState: false,
      }),
    ).toEqual([]);

    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          channels: {
            "demo-channel": {
              token: "configured",
            },
          },
          plugins: {
            deny: ["demo-channel"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
        includePersistedAuthState: false,
      }),
    ).toEqual([]);
  });

  it("lists explicit configured channels without ambient env triggers", () => {
    expect(
      listExplicitConfiguredChannelIdsForConfig({
        channels: {
          defaults: {
            model: "sonnet-4.6",
          },
          "demo-channel": {
            token: "configured",
          },
          "demo-other-channel": {
            enabled: false,
          },
        },
      } as OpenClawConfig),
    ).toEqual(["demo-channel"]);
  });

  it("does not let disabled mixed-case channel config announce ambient matches", () => {
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    expect(
      listConfiguredAnnounceChannelIdsForConfig({
        config: {
          channels: {
            "Demo-Channel": {
              enabled: false,
              token: "stale-token",
            },
          },
          plugins: {
            entries: {
              "demo-channel": {
                enabled: true,
              },
            },
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          DEMO_CHANNEL_TOKEN: "ambient",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual([]);
  });

  it("uses effective read-only channel policy for announce channels", () => {
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel", "demo-other-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
      { channelId: "demo-other-channel", source: "config" },
    ]);

    expect(
      listConfiguredAnnounceChannelIdsForConfig({
        config: {
          channels: {
            "demo-other-channel": {
              token: "configured",
            },
          },
          plugins: {
            allow: ["demo-other-channel"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          DEMO_CHANNEL_TOKEN: "ambient",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["demo-other-channel"]);
  });

  it("does not treat activation-only declarations as channel ownership", () => {
    listPotentialConfiguredChannelIds.mockReturnValue(["activation-only-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "activation-only-channel", source: "env" },
    ]);

    expect(
      resolveConfiguredChannelPresencePolicy({
        config: {
          plugins: {
            entries: {
              "activation-only-channel-plugin": {
                enabled: true,
              },
            },
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          ACTIVATION_ONLY_CHANNEL_TOKEN: "ambient",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual([
      {
        channelId: "activation-only-channel",
        sources: ["env"],
        effective: false,
        pluginIds: [],
        blockedReasons: ["no-channel-owner"],
      },
    ]);
  });

  it("uses manifest env vars as read-only configured channel triggers", () => {
    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          plugins: {
            allow: ["external-env-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          EXTERNAL_ENV_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual(["external-env-channel"]);
  });

  it("ignores manifest env vars from untrusted external plugins", () => {
    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {} as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          EXTERNAL_ENV_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual([]);

    expect(
      hasConfiguredChannelsForReadOnlyScope({
        config: {} as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          EXTERNAL_ENV_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toBe(false);
  });

  it("ignores ambient or malformed manifest env vars as read-only configured channel triggers", () => {
    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          plugins: {
            allow: ["ambient-env-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          HOME: "/tmp/user",
          PATH: "/usr/bin",
          lowercase_token: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual([]);
  });

  it("accepts lowercase or mixed-case manifest env vars as read-only configured channel triggers", () => {
    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          plugins: {
            allow: ["external-env-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          external_env_channel_token: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
        manifestRecords: [
          {
            id: "external-env-channel-plugin",
            channels: ["external-env-channel"],
            channelEnvVars: {
              "external-env-channel": ["external_env_channel_token"],
            },
            origin: "config",
            enabledByDefault: undefined,
            providers: [],
            cliBackends: [],
          } as never,
        ],
      }),
    ).toEqual(["external-env-channel"]);
  });

  it("matches uppercase process env entries for lowercase manifest env var declarations", () => {
    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: {
          plugins: {
            allow: ["external-env-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          EXTERNAL_ENV_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
        manifestRecords: [
          {
            id: "external-env-channel-plugin",
            channels: ["external-env-channel"],
            channelEnvVars: {
              "external-env-channel": ["external_env_channel_token"],
            },
            origin: "config",
            enabledByDefault: undefined,
            providers: [],
            cliBackends: [],
          } as never,
        ],
      }),
    ).toEqual(["external-env-channel"]);
  });

  it("uses manifest env vars for read-only channel presence checks", () => {
    listPotentialConfiguredChannelIds.mockReturnValue([]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([]);
    hasPotentialConfiguredChannels.mockReturnValue(false);

    expect(
      hasConfiguredChannelsForReadOnlyScope({
        config: {
          plugins: {
            allow: ["external-env-channel-plugin"],
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {
          EXTERNAL_ENV_CHANNEL_TOKEN: "token",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toBe(true);
  });
});
