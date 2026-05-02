import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginContributionOwners: vi.fn(),
  getPluginRecord: vi.fn(),
  isPluginEnabled: vi.fn(),
}));

vi.mock("../../plugins/plugin-registry.js", () => ({
  resolvePluginContributionOwners: mocks.resolvePluginContributionOwners,
  getPluginRecord: mocks.getPluginRecord,
  isPluginEnabled: mocks.isPluginEnabled,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
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

describe("loadStaticManifestCatalogRowsForList", () => {
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
});
