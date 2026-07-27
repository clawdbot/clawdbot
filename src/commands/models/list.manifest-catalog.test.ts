// Model manifest catalog tests cover loading model catalog entries from plugin manifests.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginContributionOwners: vi.fn(),
  getPluginRecord: vi.fn(),
  isPluginEnabled: vi.fn(),
  getRemoteModelCatalogOverlay: vi.fn(),
}));

vi.mock("../../plugins/plugin-registry.js", () => ({
  resolvePluginContributionOwners: mocks.resolvePluginContributionOwners,
  getPluginRecord: mocks.getPluginRecord,
  isPluginEnabled: mocks.isPluginEnabled,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));

vi.mock("../../model-catalog/remote-overlay.js", () => ({
  getRemoteModelCatalogOverlay: mocks.getRemoteModelCatalogOverlay,
}));

const moonshotPlugin = {
  id: "moonshot",
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

describe("loadStaticManifestCatalogRowsForList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRemoteModelCatalogOverlay.mockReturnValue(undefined);
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

  it("loads refreshable manifest rows as registry-backed supplements", async () => {
    const { loadSupplementalManifestCatalogRowsForList } =
      await import("./list.manifest-catalog.js");
    const manifestRegistry = {
      plugins: [openrouterPlugin, moonshotPlugin],
      diagnostics: [],
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValueOnce({
      index: { plugins: [], diagnostics: [] },
      manifestRegistry,
      plugins: manifestRegistry.plugins,
    });

    expect(
      loadSupplementalManifestCatalogRowsForList({
        cfg: {},
      }).map((row) => row.ref),
    ).toEqual(["moonshot/kimi-k2.6", "openrouter/auto"]);
  });

  it("supplements runtime-owned providers with refreshed rows only", async () => {
    const { loadStaticManifestCatalogRowsForList, loadSupplementalManifestCatalogRowsForList } =
      await import("./list.manifest-catalog.js");
    const manifestRegistry = {
      plugins: [openaiRuntimePlugin],
      diagnostics: [],
    };
    const metadataSnapshot = {
      index: { plugins: [], diagnostics: [] },
      manifestRegistry,
      plugins: manifestRegistry.plugins,
    };
    mocks.getRemoteModelCatalogOverlay.mockReturnValue({
      openai: {
        models: [{ id: "gpt-refreshed", name: "Refreshed GPT" }],
      },
    });
    mocks.getPluginRecord.mockReturnValue({ pluginId: "openai" });
    mocks.isPluginEnabled.mockReturnValue(true);

    const params = {
      cfg: {},
      providerFilter: "openai",
      metadataSnapshot: metadataSnapshot as unknown as Parameters<
        typeof loadSupplementalManifestCatalogRowsForList
      >[0]["metadataSnapshot"],
    };

    expect(loadStaticManifestCatalogRowsForList(params)).toEqual([]);
    expect(loadSupplementalManifestCatalogRowsForList(params)).toMatchObject([
      {
        provider: "openai",
        id: "gpt-refreshed",
        ref: "openai/gpt-refreshed",
        source: "runtime-refresh",
      },
    ]);
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
