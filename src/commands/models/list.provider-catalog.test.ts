import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadProviderCatalogModelsForList,
  resolveProviderCatalogPluginIdsForFilter,
} from "./list.provider-catalog.js";

const providerDiscoveryMocks = vi.hoisted(() => ({
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveOwningPluginIdsForProvider: vi.fn(),
  resolvePluginDiscoveryProviders: vi.fn(),
  resolveProviderContractPluginIdsForProviderAlias: vi.fn(),
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
    resolvePluginDiscoveryProviders: providerDiscoveryMocks.resolvePluginDiscoveryProviders,
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

const defaultProviders = [chutesProvider, moonshotProvider, openaiProvider];

describe("loadProviderCatalogModelsForList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerDiscoveryMocks.resolveBundledProviderCompatPluginIds.mockReturnValue([
      "chutes",
      "moonshot",
      "openai",
    ]);
    providerDiscoveryMocks.resolveOwningPluginIdsForProvider.mockImplementation(
      ({ provider }: { provider: string }) =>
        defaultProviders.some((entry) => entry.id === provider) ? [provider] : undefined,
    );
    providerDiscoveryMocks.resolveProviderContractPluginIdsForProviderAlias.mockImplementation(
      (provider: string) => (provider === "azure-openai-responses" ? ["openai"] : undefined),
    );
    providerDiscoveryMocks.resolvePluginDiscoveryProviders.mockImplementation(
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
    expect(rows.map((row) => `${row.provider}/${row.id}`)).toEqual(
      expect.arrayContaining(["moonshot/kimi-k2.6"]),
    );
  });

  it("recognizes bundled provider hook aliases before the unknown-provider short-circuit", async () => {
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
    providerDiscoveryMocks.resolvePluginDiscoveryProviders.mockResolvedValue([
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

    expect(providerDiscoveryMocks.resolvePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["bundled-demo"],
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(workspaceStaticCatalog).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("keeps unknown provider filters eligible for early empty results", async () => {
    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg: baseParams.cfg,
        env: baseParams.env,
        providerFilter: "unknown-provider-for-catalog-test",
      }),
    ).resolves.toBeUndefined();
  });
});
