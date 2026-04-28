import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshot: vi.fn(),
  resolvePluginContributionOwners: vi.fn(),
  getPluginRecord: vi.fn(),
  isPluginEnabled: vi.fn(),
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
}));

vi.mock("../../plugins/plugin-registry.js", () => ({
  loadPluginRegistrySnapshot: mocks.loadPluginRegistrySnapshot,
  resolvePluginContributionOwners: mocks.resolvePluginContributionOwners,
  getPluginRecord: mocks.getPluginRecord,
  isPluginEnabled: mocks.isPluginEnabled,
}));

vi.mock("../../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: mocks.loadPluginManifestRegistryForInstalledIndex,
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
    mocks.loadPluginRegistrySnapshot.mockReturnValueOnce(index);
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValueOnce({
      plugins: [openrouterPlugin, moonshotPlugin],
      diagnostics: [],
    });

    expect(
      loadStaticManifestCatalogRowsForList({
        cfg: {},
      }).map((row) => row.ref),
    ).toEqual(["moonshot/kimi-k2.6"]);
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith({
      index,
      config: {},
      env: undefined,
    });
  });

  it("loads refreshable manifest rows as registry-backed supplements", async () => {
    const { loadSupplementalManifestCatalogRowsForList } =
      await import("./list.manifest-catalog.js");
    mocks.loadPluginRegistrySnapshot.mockReturnValueOnce({ plugins: [], diagnostics: [] });
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValueOnce({
      plugins: [openrouterPlugin, moonshotPlugin],
      diagnostics: [],
    });

    expect(
      loadSupplementalManifestCatalogRowsForList({
        cfg: {},
      }).map((row) => row.ref),
    ).toEqual(["moonshot/kimi-k2.6", "openrouter/auto"]);
  });
});
