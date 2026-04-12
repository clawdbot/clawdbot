import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off the explicit bundled fast path");
  }),
}));

vi.mock("./manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry: loadPluginManifestRegistryMock,
  };
});

import {
  resolveBundledWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";

describe("web provider public artifacts explicit fast path", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockClear();
  });

  it("resolves bundled web search providers by explicit plugin id without manifest scans", () => {
    const provider = resolveBundledWebSearchProvidersFromPublicArtifacts({
      bundledAllowlistCompat: true,
      onlyPluginIds: ["brave"],
    })?.[0];

    expect(provider?.pluginId).toBe("brave");
    expect(provider?.createTool({ config: {} as never })).toBeNull();
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves bundled web fetch providers by explicit plugin id without manifest scans", () => {
    const provider = resolveBundledWebFetchProvidersFromPublicArtifacts({
      bundledAllowlistCompat: true,
      onlyPluginIds: ["firecrawl"],
    })?.[0];

    expect(provider?.pluginId).toBe("firecrawl");
    expect(provider?.createTool({ config: {} as never })).toBeNull();
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });
});
