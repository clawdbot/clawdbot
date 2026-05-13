import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasProviderStaticCatalogForFilter,
  loadProviderCatalogModelsForList,
  resolveProviderCatalogPluginIdsForFilter,
} from "./list.provider-catalog.js";

const providerDiscoveryMocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshotWithMetadata: vi.fn(),
  resolvePluginContributionOwners: vi.fn(),
  resolveProviderOwners: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveOwningPluginIdsForProvider: vi.fn(),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  resolveProviderContractPluginIdsForProviderAlias: vi.fn(),
}));

vi.mock("../../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: [] }),
  loadPluginRegistrySnapshotWithMetadata:
    providerDiscoveryMocks.loadPluginRegistrySnapshotWithMetadata,
  resolvePluginContributionOwners: providerDiscoveryMocks.resolvePluginContributionOwners,
  resolveProviderOwners: providerDiscoveryMocks.resolveProviderOwners,
}));

vi.mock("../../plugins/providers.js", () => ({
  resolveBundledProviderCompatPluginIds:
    providerDiscoveryMocks.resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProvider: providerDiscoveryMocks.resolveOwningPluginIdsForProvider,
}));

vi.mock("../../plugins/contracts/registry.js", () => ({
  resolveProviderContractPluginIdsForProviderAlias:
    providerDiscoveryMocks.resolveProviderContractPluginIdsForProviderAlias,
}));

vi.mock("../../plugins/provider-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/provider-discovery.js")>();
  return {
    ...actual,
    resolveRuntimePluginDiscoveryProviders:
      providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders,
  };
});

const baseParams = {
  cfg: {
    plugins: {
      entries: {
        chutes: { enabled: true },
        moonshot: { enabled: true },
      },
    },
  },
  agentDir: "/tmp/openclaw-provider-catalog-test",
  env: {
    ...process.env,
    CHUTES_API_KEY: "",
    MOONSHOT_API_KEY: "",
  },
};

const chutesProvider = {
  id: "chutes",
  pluginId: "chutes",
  label: "Chutes",
  auth: [],
  staticCatalog: {
    run: async () => ({
      provider: { baseUrl: "https://chutes.example/v1", models: [] },
    }),
  },
};

const moonshotProvider = {
  id: "moonshot",
  pluginId: "moonshot",
  label: "Moonshot",
  auth: [],
  staticCatalog: {
    run: async () => ({
      provider: {
        baseUrl: "https://api.moonshot.ai/v1",
        models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
      },
    }),
  },
};

const openaiProvider = {
  id: "openai",
  pluginId: "openai",
  label: "OpenAI",
  aliases: ["azure-openai-responses"],
  auth: [],
  staticCatalog: {
    run: async () => ({
      provider: { baseUrl: "https://api.openai.com/v1", models: [] },
    }),
  },
};

const catalogOnlyProvider = {
  id: "ollama",
  pluginId: "ollama",
  label: "Ollama",
  auth: [],
  catalog: {
    run: async () => ({
      provider: { baseUrl: "http://127.0.0.1:11434", models: [] },
    }),
  },
};

const vllmProvider = {
  id: "vllm",
  pluginId: "vllm",
  label: "vLLM",
  auth: [],
  catalog: {
    run: async (ctx: {
      config: {
        models?: {
          providers?: Record<
            string,
            {
              baseUrl?: string;
            }
          >;
        };
      };
      resolveProviderApiKey: (providerId?: string) => {
        apiKey: string | undefined;
        discoveryApiKey?: string;
      };
    }) => ({
      provider: {
        baseUrl: ctx.config.models?.providers?.vllm?.baseUrl,
        api: "openai-completions",
        models: [
          {
            id: "runtime-vllm-model",
            name: "Runtime vLLM Model",
          },
        ],
        apiKey: "proof-key",
      },
    }),
  },
};

const defaultProviders = [chutesProvider, moonshotProvider, openaiProvider];

function firstDiscoveryRequest(): {
  onlyPluginIds?: string[];
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  includeUntrustedWorkspacePlugins?: boolean;
} {
  const call = providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders.mock.calls[0];
  if (!call) {
    throw new Error("expected runtime plugin discovery call");
  }
  return call[0] as {
    onlyPluginIds?: string[];
    requireCompleteDiscoveryEntryCoverage?: boolean;
    discoveryEntriesOnly?: boolean;
    includeUntrustedWorkspacePlugins?: boolean;
  };
}

describe("loadProviderCatalogModelsForList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerDiscoveryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: {
        plugins: [],
      },
      diagnostics: [],
    });
    providerDiscoveryMocks.resolveProviderOwners.mockImplementation(
      ({ providerId }: { providerId: string }) =>
        defaultProviders
          .filter((provider) => provider.id === providerId)
          .map((provider) => provider.pluginId),
    );
    providerDiscoveryMocks.resolvePluginContributionOwners.mockReturnValue([]);
    providerDiscoveryMocks.resolveBundledProviderCompatPluginIds.mockReturnValue([
      "chutes",
      "moonshot",
      "openai",
      "ollama",
    ]);
    providerDiscoveryMocks.resolveOwningPluginIdsForProvider.mockImplementation(
      ({ provider }: { provider: string }) =>
        [...defaultProviders, catalogOnlyProvider].some((entry) => entry.id === provider)
          ? [provider]
          : undefined,
    );
    providerDiscoveryMocks.resolveProviderContractPluginIdsForProviderAlias.mockImplementation(
      (provider: string) => (provider === "azure-openai-responses" ? ["openai"] : undefined),
    );
    providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders.mockImplementation(
      async ({ onlyPluginIds }: { onlyPluginIds?: string[] }) =>
        defaultProviders.filter((provider) => onlyPluginIds?.includes(provider.pluginId)),
    );
  });

  it("does not use live provider discovery for display-only rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("blocked fetch"));

    await loadProviderCatalogModelsForList({
      ...baseParams,
      providerFilter: "chutes",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes unauthenticated Moonshot static catalog rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("blocked fetch"));

    const rows = await loadProviderCatalogModelsForList({
      ...baseParams,
      providerFilter: "moonshot",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows.map((row) => `${row.provider}/${row.id}`)).toContain("moonshot/kimi-k2.6");
  });

  it("requires complete discovery-entry coverage for static-only loads", async () => {
    await loadProviderCatalogModelsForList({
      ...baseParams,
      providerFilter: "moonshot",
      staticOnly: true,
    });

    const discoveryRequest = firstDiscoveryRequest();
    expect(discoveryRequest?.onlyPluginIds).toStrictEqual(["moonshot"]);
    expect(discoveryRequest?.requireCompleteDiscoveryEntryCoverage).toBe(true);
    expect(discoveryRequest?.discoveryEntriesOnly).toBe(true);
  });

  it("uses bundled runtime provider catalogs for provider-filtered self-hosted rows", async () => {
    providerDiscoveryMocks.resolveProviderOwners.mockImplementation(
      ({ providerId }: { providerId: string }) => (providerId === "vllm" ? ["vllm"] : []),
    );
    providerDiscoveryMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["vllm"]);
    providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([vllmProvider]);

    const rows = await loadProviderCatalogModelsForList({
      ...baseParams,
      cfg: {
        agents: {
          defaults: {
            models: {
              "vllm/*": {},
            },
          },
        },
        models: {
          providers: {
            vllm: {
              baseUrl: "http://vllm-router.example/v1",
              apiKey: "proof-key",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
      providerFilter: "vllm",
    });

    expect(rows.map((row) => `${row.provider}/${row.id}`)).toStrictEqual([
      "vllm/runtime-vllm-model",
    ]);
    expect(rows[0]?.baseUrl).toBe("http://vllm-router.example/v1");
    const discoveryRequest = firstDiscoveryRequest();
    expect(discoveryRequest?.onlyPluginIds).toStrictEqual(["vllm"]);
    expect(discoveryRequest?.discoveryEntriesOnly).toBe(false);
  });

  it("resolves provider owners from the installed plugin index before manifest fallback", async () => {
    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "moonshot",
      }),
    ).resolves.toEqual(["moonshot"]);

    expect(providerDiscoveryMocks.loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledWith({
      config: baseParams.cfg,
      env: baseParams.env,
    });
    expect(providerDiscoveryMocks.resolveOwningPluginIdsForProvider).not.toHaveBeenCalled();
  });

  it("falls back to manifest ownership when the plugin index is derived", async () => {
    providerDiscoveryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValueOnce({
      source: "derived",
      snapshot: {
        plugins: [],
      },
      diagnostics: [],
    });

    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "moonshot",
      }),
    ).resolves.toEqual(["moonshot"]);

    expect(providerDiscoveryMocks.resolveOwningPluginIdsForProvider).toHaveBeenCalledWith({
      provider: "moonshot",
      config: baseParams.cfg,
      env: baseParams.env,
    });
  });

  it("does not fall back to legacy manifest ownership for disabled persisted plugin owners", async () => {
    providerDiscoveryMocks.resolveProviderOwners
      .mockReturnValueOnce([])
      .mockReturnValueOnce(["moonshot"]);
    providerDiscoveryMocks.resolvePluginContributionOwners.mockReturnValue([]);

    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "moonshot",
      }),
    ).resolves.toStrictEqual([]);

    expect(providerDiscoveryMocks.resolveOwningPluginIdsForProvider).not.toHaveBeenCalled();
  });

  it("returns an empty catalog when a static provider catalog throws", async () => {
    providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValueOnce([
      {
        id: "moonshot",
        pluginId: "moonshot",
        label: "Moonshot",
        auth: [],
        staticCatalog: {
          run: async () => {
            throw new Error("catalog offline");
          },
        },
      },
    ]);

    await expect(
      loadProviderCatalogModelsForList({
        ...baseParams,
        providerFilter: "moonshot",
        staticOnly: true,
      }),
    ).resolves.toStrictEqual([]);
  });

  it("only skips registry for providers with actual static catalogs", async () => {
    providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      catalogOnlyProvider,
    ]);

    await expect(
      hasProviderStaticCatalogForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "ollama",
      }),
    ).resolves.toBe(false);

    const discoveryRequest = firstDiscoveryRequest();
    expect(discoveryRequest?.onlyPluginIds).toStrictEqual(["ollama"]);
    expect(discoveryRequest?.requireCompleteDiscoveryEntryCoverage).toBe(true);
    expect(discoveryRequest?.discoveryEntriesOnly).toBe(true);
  });

  it("does not skip registry when a bundled provider has no lightweight static entry", async () => {
    providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValueOnce([]);

    await expect(
      hasProviderStaticCatalogForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "chutes",
      }),
    ).resolves.toBe(false);
  });

  it("does not skip registry for non-bundled static catalog owners", async () => {
    providerDiscoveryMocks.resolveProviderOwners.mockReturnValueOnce([]);
    providerDiscoveryMocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce([
      "workspace-static-provider",
    ]);
    providerDiscoveryMocks.resolveBundledProviderCompatPluginIds.mockReturnValueOnce(["moonshot"]);

    await expect(
      hasProviderStaticCatalogForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "workspace-static-provider",
      }),
    ).resolves.toBe(false);

    expect(providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders).not.toHaveBeenCalled();
  });

  it("recognizes bundled provider hook aliases before the unknown-provider short-circuit", async () => {
    providerDiscoveryMocks.resolveProviderOwners.mockReturnValueOnce([]);

    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "azure-openai-responses",
      }),
    ).resolves.toEqual(["openai"]);
  });

  it("does not execute workspace provider static catalogs", async () => {
    const workspaceStaticCatalog = vi.fn(async () => ({
      provider: { baseUrl: "https://workspace.example/v1", models: [] },
    }));
    providerDiscoveryMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["bundled-demo"]);
    providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      {
        id: "bundled-demo",
        pluginId: "bundled-demo",
        label: "Bundled Demo",
        auth: [],
        staticCatalog: {
          run: async () => null,
        },
      },
      {
        id: "workspace-demo",
        pluginId: "workspace-demo",
        label: "Workspace Demo",
        auth: [],
        staticCatalog: {
          run: workspaceStaticCatalog,
        },
      },
    ]);

    const rows = await loadProviderCatalogModelsForList({
      ...baseParams,
    });

    const discoveryRequest = firstDiscoveryRequest();
    expect(discoveryRequest?.onlyPluginIds).toStrictEqual(["bundled-demo"]);
    expect(discoveryRequest?.includeUntrustedWorkspacePlugins).toBe(false);
    expect(workspaceStaticCatalog).not.toHaveBeenCalled();
    expect(rows).toStrictEqual([]);
  });

  it("keeps unknown provider filters eligible for early empty results", async () => {
    providerDiscoveryMocks.resolveProviderOwners.mockReturnValueOnce([]);

    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "unknown-provider-for-catalog-test",
      }),
    ).resolves.toBeUndefined();
  });
});
