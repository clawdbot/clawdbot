// Exercises startup provider discovery scoping without loading real plugin manifests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderPlugin } from "../plugins/types.js";

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderCatalog: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));

vi.mock("../plugins/provider-discovery.js", () => ({
  resolveRuntimePluginDiscoveryProviders: mocks.resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog: mocks.runProviderCatalog,
  runProviderStaticCatalog: mocks.runProviderStaticCatalog,
  groupPluginDiscoveryProvidersByOrder: (providers: ProviderPlugin[]) => ({
    simple: providers,
    profile: [],
    paired: [],
    late: [],
  }),
  normalizePluginDiscoveryResult: ({
    provider,
    result,
  }: {
    provider: ProviderPlugin;
    result?: { provider?: unknown; providers?: Record<string, unknown> } | null;
  }) => result?.providers ?? (result?.provider ? { [provider.id]: result.provider } : {}),
}));

import { resolveImplicitProviders } from "./models-config.providers.implicit.js";

function metadataOwners(
  overrides: Partial<PluginMetadataSnapshotOwnerMaps>,
): PluginMetadataSnapshotOwnerMaps {
  // Tests only populate the owner map under inspection; keep the rest explicit.
  return {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    ...overrides,
  };
}

function createProvider(id: string): ProviderPlugin {
  // Minimal discovery plugin used to assert orchestration, not provider behavior.
  return {
    id,
    label: id,
    auth: [],
    catalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

function createProviderWithStaticCatalog(id: string): ProviderPlugin {
  return {
    ...createProvider(id),
    staticCatalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

function createStaticOnlyProvider(id: string): ProviderPlugin {
  return {
    id,
    label: id,
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

function createTextModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function firstMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  // Centralizes the mock-call assertion so failed discovery paths report intent.
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call[0];
}

describe("resolveImplicitProviders startup discovery scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("openai")]);
    mocks.runProviderCatalog.mockResolvedValue({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [],
        },
      },
    });
    mocks.runProviderStaticCatalog.mockResolvedValue({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [],
        },
      },
    });
  });

  it("passes startup provider scopes as plugin owner filters", async () => {
    await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {},
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {},
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners({
          providers: new Map([["openai", ["openai"]]]),
        }),
      },
      providerDiscoveryProviderIds: ["openai"],
      providerDiscoveryTimeoutMs: 1234,
    });

    const discoveryOptions = firstMockArg(
      mocks.resolveRuntimePluginDiscoveryProviders,
      "runtime plugin discovery",
    ) as { onlyPluginIds?: string[] };
    expect(discoveryOptions?.onlyPluginIds).toEqual(["openai"]);
    const catalogOptions = firstMockArg(mocks.runProviderCatalog, "provider catalog") as {
      timeoutMs?: number;
    };
    expect(catalogOptions?.timeoutMs).toBe(1234);
  });

  it("can keep startup discovery on provider discovery entries only", async () => {
    await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {},
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {},
      providerDiscoveryEntriesOnly: true,
    });

    const discoveryOptions = firstMockArg(
      mocks.resolveRuntimePluginDiscoveryProviders,
      "runtime plugin discovery",
    ) as { discoveryEntriesOnly?: boolean };
    expect(discoveryOptions?.discoveryEntriesOnly).toBe(true);
  });

  it("uses static provider catalogs for entries-only startup discovery", async () => {
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createProviderWithStaticCatalog("codex"),
    ]);

    await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {},
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {},
      providerDiscoveryEntriesOnly: true,
    });

    expect(mocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.runProviderCatalog).not.toHaveBeenCalled();
  });

  it("uses static-only provider catalogs for scoped startup discovery", async () => {
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createStaticOnlyProvider("openai"),
    ]);

    await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {},
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {},
      providerDiscoveryProviderIds: ["openai"],
    });

    expect(mocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.runProviderCatalog).not.toHaveBeenCalled();
  });

  it("falls back to static provider catalogs when runtime discovery has no rows", async () => {
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      createProviderWithStaticCatalog("minimax"),
    ]);
    mocks.runProviderCatalog.mockResolvedValue(null);
    mocks.runProviderStaticCatalog.mockResolvedValue({
      providers: {
        minimax: {
          baseUrl: "https://api.minimax.io/anthropic",
          api: "anthropic-messages" as const,
          models: [createTextModel("MiniMax-M2.7", "MiniMax M2.7")],
        },
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {},
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {},
      providerDiscoveryProviderIds: ["minimax"],
    });

    expect(mocks.runProviderCatalog).toHaveBeenCalledTimes(1);
    // Static catalogs are the startup fallback when scoped runtime discovery is empty.
    expect(mocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
    expect(providers?.minimax?.models.map((model) => model.id)).toEqual(["MiniMax-M2.7"]);
  });

  it("keeps explicit provider models manual without provider wildcard visibility", async () => {
    const explicitProvider = {
      baseUrl: "http://vllm.example/v1",
      api: "openai-completions" as const,
      models: [createTextModel("manual-model", "Manual Model")],
    };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("vllm")]);
    mocks.runProviderCatalog.mockResolvedValue({
      provider: {
        baseUrl: "http://vllm.example/v1",
        api: "openai-completions" as const,
        models: [createTextModel("discovered-model", "Discovered Model")],
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {
        agents: {
          defaults: {
            models: {
              "vllm/manual-model": {},
            },
          },
        },
        models: {
          providers: {
            vllm: explicitProvider,
          },
        },
      },
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {
        vllm: explicitProvider,
      },
    });

    expect(providers?.vllm?.models.map((model) => model.id)).toEqual(["manual-model"]);
  });

  it("merges discovered self-hosted models into explicit provider models for wildcard visibility", async () => {
    const explicitProvider = {
      baseUrl: "http://vllm.example/v1",
      api: "openai-completions" as const,
      models: [createTextModel("manual-model", "Manual Model")],
    };
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("vllm")]);
    mocks.runProviderCatalog.mockResolvedValue({
      provider: {
        baseUrl: "http://vllm.example/v1",
        api: "openai-completions" as const,
        models: [createTextModel("discovered-model", "Discovered Model")],
      },
    });

    const providers = await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {
        agents: {
          defaults: {
            models: {
              "vllm/*": {},
            },
          },
        },
        models: {
          providers: {
            vllm: explicitProvider,
          },
        },
      },
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {
        vllm: explicitProvider,
      },
    });

    expect(providers?.vllm?.models.map((model) => model.id)).toEqual([
      "manual-model",
      "discovered-model",
    ]);
  });
});
