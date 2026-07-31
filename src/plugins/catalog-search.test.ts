// Plugin catalog search tests cover family queries, score merging, and bounded results.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchClawHubPackages: vi.fn(),
}));

vi.mock("../infra/clawhub.js", () => ({
  searchClawHubPackages: mocks.searchClawHubPackages,
}));

const { searchInstallablePluginPackages } = await import("./catalog-search.js");

function searchResult(name: string, family: "code-plugin" | "bundle-plugin", score: number) {
  return {
    score,
    package: {
      name,
      displayName: name,
      family,
      channel: "community" as const,
      isOfficial: false,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

describe("plugin catalog search", () => {
  beforeEach(() => {
    mocks.searchClawHubPackages.mockReset();
  });

  it("queries both installable families and merges duplicate packages by best score", async () => {
    mocks.searchClawHubPackages
      .mockResolvedValueOnce([
        searchResult("shared", "code-plugin", 4),
        searchResult("code-only", "code-plugin", 8),
      ])
      .mockResolvedValueOnce([
        searchResult("shared", "bundle-plugin", 9),
        searchResult("bundle-only", "bundle-plugin", 6),
      ]);

    const results = await searchInstallablePluginPackages({ query: "calendar", limit: 2 });

    expect(mocks.searchClawHubPackages).toHaveBeenNthCalledWith(1, {
      query: "calendar",
      family: "code-plugin",
      limit: 2,
    });
    expect(mocks.searchClawHubPackages).toHaveBeenNthCalledWith(2, {
      query: "calendar",
      family: "bundle-plugin",
      limit: 2,
    });
    expect(results.map((entry) => [entry.package.name, entry.score])).toEqual([
      ["shared", 9],
      ["code-only", 8],
    ]);
    expect(results[0]?.package.family).toBe("bundle-plugin");
  });

  it("uses the default limit for invalid programmatic values", async () => {
    mocks.searchClawHubPackages.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await searchInstallablePluginPackages({ query: "calendar", limit: Number.NaN });

    expect(mocks.searchClawHubPackages).toHaveBeenCalledWith({
      query: "calendar",
      family: "code-plugin",
      limit: 20,
    });
    expect(mocks.searchClawHubPackages).toHaveBeenCalledWith({
      query: "calendar",
      family: "bundle-plugin",
      limit: 20,
    });
  });
});
