// Model manifest catalog tests cover loading model catalog entries from plugin manifests.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginContributionOwners: vi.fn(),
  getPluginRecord: vi.fn(),
  isPluginEnabled: vi.fn(),
  getRemoteModelCatalogProviderOverlay: vi.fn(),
}));

vi.mock("../../plugins/plugin-registry-contributions.js", () => ({
  resolvePluginContributionOwners: mocks.resolvePluginContributionOwners,
}));

vi.mock("../../plugins/plugin-registry-snapshot.js", () => ({
  getPluginRecord: mocks.getPluginRecord,
  isPluginEnabled: mocks.isPluginEnabled,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));

vi.mock("../../model-catalog/remote-overlay.js", () => ({
  getRemoteModelCatalogProviderOverlay: mocks.getRemoteModelCatalogProviderOverlay,
}));

const moonshotPlugin = {
  id: "moonshot",
  origin: "bundled",
  providers: ["moonshot"],
  modelCatalog: {
    providers: {
      moonshot: {
        models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
      },
    },
    discovery: {
      moonshot: "static",
    },
  },
};

const openrouterPlugin = {
  id: "openrouter",
  origin: "bundled",
  providers: ["openrouter"],
  modelCatalog: {
    providers: {
      openrouter: {
        models: [{ id: "auto", name: "Auto" }],
      },
    },
    discovery: {
      openrouter: "refreshable",
    },
  },
};

const openaiRuntimePlugin = {
  id: "openai",
  origin: "bundled",
  providers: ["openai"],
  modelCatalog: {
    providers: {
      openai: {
        models: [{ id: "gpt-known", name: "Known GPT" }],
      },
    },
    discovery: {
      openai: "runtime",
    },
  },
};

const anthropicRuntimeAugmentPlugin = {
  id: "anthropic",
  origin: "bundled",
  providers: ["anthropic"],
  modelCatalog: {
    runtimeAugment: true,
    providers: {
      anthropic: {
        models: [{ id: "claude-known", name: "Known Claude" }],
      },
    },
    discovery: {
      anthropic: "refreshable",
    },
  },
};

describe("loadStaticManifestCatalogRowsForList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRemoteModelCatalogProviderOverlay.mockReturnValue(undefined);
  });

  it("loads only static manifest catalog rows without a provider filter", async () => {
    const { loadStaticManifestCatalogRowsForList } = await import("./list.manifest-catalog.js");
    const index = { plugins: [], diagnostics: [] };
    const manifestRegistry = {
      plugins: [openrouterPlugin, moonshotPlugin],
      diagnostics: [],
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValueOnce({
      index,
      manifestRegistry,
      plugins: manifestRegistry.plugins,
      byPluginId: new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
    });

    expect(
      loadStaticManifestCatalogRowsForList({
        cfg: {},
      }).map((row) => row.ref),
    ).toEqual(["moonshot/kimi-k2.6"]);
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      allowWorkspaceScopedCurrent: true,
      config: {},
      env: process.env,
    });
  });

  it("does not expose refreshable provider previews as prepared models", async () => {
    const { loadStaticManifestCatalogRowsForList } = await import("./list.manifest-catalog.js");
    const manifestRegistry = {
      plugins: [openrouterPlugin, moonshotPlugin],
      diagnostics: [],
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValueOnce({
      index: { plugins: [], diagnostics: [] },
      manifestRegistry,
      plugins: manifestRegistry.plugins,
      byPluginId: new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
    });

    expect(
      loadStaticManifestCatalogRowsForList({
        cfg: {},
      }).map((row) => row.ref),
    ).toEqual(["moonshot/kimi-k2.6"]);
  });

  it("does not expose runtime overlay rows as static manifest models", async () => {
    const { loadStaticManifestCatalogRowsForList } = await import("./list.manifest-catalog.js");
    const manifestRegistry = {
      plugins: [openaiRuntimePlugin],
      diagnostics: [],
    };
    const metadataSnapshot = {
      index: { plugins: [], diagnostics: [] },
      manifestRegistry,
      plugins: manifestRegistry.plugins,
      byPluginId: new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
    };
    mocks.getRemoteModelCatalogProviderOverlay.mockReturnValue({
      models: [{ id: "gpt-refreshed", name: "Refreshed GPT" }],
    });
    mocks.getPluginRecord.mockReturnValue({ pluginId: "openai" });
    mocks.isPluginEnabled.mockReturnValue(true);

    const params = {
      cfg: {},
      providerFilter: "openai",
      metadataSnapshot: metadataSnapshot as unknown as Parameters<
        typeof loadStaticManifestCatalogRowsForList
      >[0]["metadataSnapshot"],
    };

    expect(loadStaticManifestCatalogRowsForList(params)).toEqual([]);
  });

  it("uses an injected metadata snapshot instead of loading metadata again", async () => {
    const { loadStaticManifestCatalogRowsForList } = await import("./list.manifest-catalog.js");
    const metadataSnapshot = {
      index: { plugins: [], diagnostics: [] },
      manifestRegistry: {
        plugins: [moonshotPlugin],
        diagnostics: [],
      },
      plugins: [moonshotPlugin],
      byPluginId: new Map([[moonshotPlugin.id, moonshotPlugin]]),
    };

    expect(
      loadStaticManifestCatalogRowsForList({
        cfg: {},
        metadataSnapshot: metadataSnapshot as unknown as Parameters<
          typeof loadStaticManifestCatalogRowsForList
        >[0]["metadataSnapshot"],
      }).map((row) => row.ref),
    ).toEqual(["moonshot/kimi-k2.6"]);
    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });
});
