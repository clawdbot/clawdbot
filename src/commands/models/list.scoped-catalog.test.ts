import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadManifestCatalogRowsForList: vi.fn(),
  loadStaticManifestCatalogRowsForList: vi.fn(),
}));

vi.mock("./list.manifest-catalog.js", () => ({
  loadManifestCatalogRowsForList: mocks.loadManifestCatalogRowsForList,
  loadStaticManifestCatalogRowsForList: mocks.loadStaticManifestCatalogRowsForList,
}));

import { loadScopedListModelCatalogSnapshot } from "./list.scoped-catalog.js";

const runtimeRow = {
  provider: "openai",
  id: "gpt-5.6",
  ref: "openai/gpt-5.6",
  mergeKey: "openai::gpt-5.6",
  name: "GPT-5.6",
  source: "manifest" as const,
  input: ["text", "image"] as const,
  reasoning: true,
  status: "available" as const,
  api: "openai-responses" as const,
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 1_050_000,
};

const staticRow = {
  provider: "moonshot",
  id: "kimi-k2.6",
  ref: "moonshot/kimi-k2.6",
  mergeKey: "moonshot::kimi-k2.6",
  name: "Kimi K2.6",
  source: "manifest" as const,
  input: ["text"] as const,
  reasoning: false,
  status: "available" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadManifestCatalogRowsForList.mockReturnValue([runtimeRow, staticRow]);
  mocks.loadStaticManifestCatalogRowsForList.mockReturnValue([staticRow]);
});

describe("loadScopedListModelCatalogSnapshot", () => {
  it("returns an empty snapshot without loading manifest catalogs for an empty auth scope", () => {
    expect(loadScopedListModelCatalogSnapshot({ cfg: {}, providerIds: [] })).toEqual({
      entries: [],
      routeVariants: [],
      staticEntries: [],
    });
    expect(mocks.loadManifestCatalogRowsForList).not.toHaveBeenCalled();
    expect(mocks.loadStaticManifestCatalogRowsForList).not.toHaveBeenCalled();
  });

  it("admits runtime manifest rows only for authenticated providers", () => {
    const snapshot = loadScopedListModelCatalogSnapshot({
      cfg: {},
      providerIds: ["openai"],
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.6",
        api: "openai-responses",
        contextWindow: 1_050_000,
      }),
    ]);
    expect(snapshot.routeVariants).toEqual(snapshot.entries);
    expect(snapshot.staticEntries).toEqual([]);
  });

  it("keeps static rows in the scoped snapshot", () => {
    const snapshot = loadScopedListModelCatalogSnapshot({
      cfg: {},
      providerIds: ["moonshot"],
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({ provider: "moonshot", id: "kimi-k2.6" }),
    ]);
    expect(snapshot.staticEntries).toEqual(snapshot.entries);
  });
});
