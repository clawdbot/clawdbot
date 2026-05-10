import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadStaticManifestCatalogRowsForList: vi.fn(),
  loadSupplementalManifestCatalogRowsForList: vi.fn(),
  loadProviderIndexCatalogRowsForList: vi.fn(),
  hasProviderStaticCatalogForFilter: vi.fn(),
}));

vi.mock("./list.manifest-catalog.js", () => ({
  loadStaticManifestCatalogRowsForList: mocks.loadStaticManifestCatalogRowsForList,
  loadSupplementalManifestCatalogRowsForList: mocks.loadSupplementalManifestCatalogRowsForList,
}));

vi.mock("./list.provider-index-catalog.js", () => ({
  loadProviderIndexCatalogRowsForList: mocks.loadProviderIndexCatalogRowsForList,
}));

vi.mock("./list.provider-catalog.js", () => ({
  hasProviderStaticCatalogForFilter: mocks.hasProviderStaticCatalogForFilter,
}));

const catalogRow = {
  provider: "moonshot",
  id: "kimi-k2.6",
  ref: "moonshot/kimi-k2.6",
  mergeKey: "moonshot::kimi-k2.6",
  name: "Kimi K2.6",
  source: "manifest",
  input: ["text"],
  reasoning: false,
  status: "available",
} as const;

describe("planAllModelListSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValue([]);
    mocks.loadSupplementalManifestCatalogRowsForList.mockReturnValue([]);
    mocks.loadProviderIndexCatalogRowsForList.mockReturnValue([]);
    mocks.hasProviderStaticCatalogForFilter.mockResolvedValue(false);
  });

  it("uses installed manifest rows before provider index or runtime catalog sources", async () => {
    const { planAllModelListSources } = await import("./list.source-plan.js");
    mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([catalogRow]);

    const plan = await planAllModelListSources({
      all: true,
      providerFilter: "moonshot",
      cfg: {},
    });

    expect(plan.kind).toBe("manifest");
    expect(plan.requiresInitialRegistry).toBe(false);
    expect(plan.skipRuntimeModelSuppression).toBe(true);
    expect(plan.manifestCatalogRows).toEqual([catalogRow]);
    expect(mocks.loadStaticManifestCatalogRowsForList).toHaveBeenCalledWith({
      cfg: {},
      providerFilter: "moonshot",
    });
    expect(mocks.loadSupplementalManifestCatalogRowsForList).not.toHaveBeenCalled();
    expect(mocks.loadProviderIndexCatalogRowsForList).not.toHaveBeenCalled();
    expect(mocks.hasProviderStaticCatalogForFilter).not.toHaveBeenCalled();
  });

  it("uses provider index rows only when installed manifest rows are unavailable", async () => {
    const { planAllModelListSources } = await import("./list.source-plan.js");
    const providerIndexRow = { ...catalogRow, source: "provider-index" };
    mocks.loadProviderIndexCatalogRowsForList.mockReturnValueOnce([providerIndexRow]);

    const plan = await planAllModelListSources({
      all: true,
      providerFilter: "moonshot",
      cfg: {},
    });

    expect(plan.kind).toBe("provider-index");
    expect(plan.requiresInitialRegistry).toBe(false);
    expect(plan.skipRuntimeModelSuppression).toBe(true);
    expect(plan.providerIndexCatalogRows).toEqual([providerIndexRow]);
    expect(mocks.hasProviderStaticCatalogForFilter).not.toHaveBeenCalled();
  });

  it("keeps provider-filtered refreshable manifest rows registry-backed", async () => {
    const { planAllModelListSources } = await import("./list.source-plan.js");
    mocks.loadSupplementalManifestCatalogRowsForList.mockReturnValueOnce([catalogRow]);

    const plan = await planAllModelListSources({
      all: true,
      providerFilter: "openai",
      cfg: {},
    });

    expect(plan.kind).toBe("registry");
    expect(plan.requiresInitialRegistry).toBe(true);
    expect(plan.skipRuntimeModelSuppression).toBe(false);
    expect(plan.manifestCatalogRows).toEqual([catalogRow]);
    expect(mocks.loadStaticManifestCatalogRowsForList).toHaveBeenCalledWith({
      cfg: {},
      providerFilter: "openai",
    });
    expect(mocks.loadSupplementalManifestCatalogRowsForList).toHaveBeenCalledWith({
      cfg: {},
      providerFilter: "openai",
    });
    expect(mocks.loadProviderIndexCatalogRowsForList).not.toHaveBeenCalled();
  });

  it("allows scoped runtime catalog plans to fall back to registry rows", async () => {
    const { planAllModelListSources } = await import("./list.source-plan.js");

    const plan = await planAllModelListSources({
      all: true,
      providerFilter: "openrouter",
      cfg: {},
    });
    expect(plan.kind).toBe("provider-runtime-scoped");
    expect(plan.requiresInitialRegistry).toBe(false);
    expect(plan.skipRuntimeModelSuppression).toBe(false);
    expect(plan.fallbackToRegistryWhenEmpty).toBe(true);
  });

  it("keeps broad all-model lists on the registry path with cheap catalog supplements", async () => {
    const { planAllModelListSources } = await import("./list.source-plan.js");
    const providerIndexRow = { ...catalogRow, source: "provider-index" };
    mocks.loadSupplementalManifestCatalogRowsForList.mockReturnValueOnce([catalogRow]);
    mocks.loadProviderIndexCatalogRowsForList.mockReturnValueOnce([providerIndexRow]);

    const plan = await planAllModelListSources({
      all: true,
      cfg: {},
    });

    expect(plan.kind).toBe("registry");
    expect(plan.requiresInitialRegistry).toBe(true);
    expect(plan.skipRuntimeModelSuppression).toBe(false);
    expect(plan.manifestCatalogRows).toEqual([catalogRow]);
    expect(plan.providerIndexCatalogRows).toEqual([providerIndexRow]);
    expect(mocks.loadSupplementalManifestCatalogRowsForList).toHaveBeenCalledWith({
      cfg: {},
    });
    expect(mocks.loadStaticManifestCatalogRowsForList).not.toHaveBeenCalled();
    expect(mocks.hasProviderStaticCatalogForFilter).not.toHaveBeenCalled();
  });

  it("falls back to registry only for provider static fast paths that return no rows", async () => {
    const { planAllModelListSources } = await import("./list.source-plan.js");
    mocks.hasProviderStaticCatalogForFilter.mockResolvedValueOnce(true);

    const plan = await planAllModelListSources({
      all: true,
      providerFilter: "codex",
      cfg: {},
    });
    expect(plan.kind).toBe("provider-runtime-static");
    expect(plan.requiresInitialRegistry).toBe(false);
    expect(plan.skipRuntimeModelSuppression).toBe(true);
    expect(plan.fallbackToRegistryWhenEmpty).toBe(true);
  });
});
