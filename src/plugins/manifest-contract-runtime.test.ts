import { beforeEach, describe, expect, it, vi } from "vitest";

const loadPluginMetadataSnapshot = vi.hoisted(() => vi.fn());

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot,
}));

import { resolveManifestContractRuntimePluginResolution } from "./manifest-contract-runtime.js";

describe("resolveManifestContractRuntimePluginResolution", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshot.mockReset();
    loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
    });
  });

  it("resolves contract plugins from the shared metadata snapshot", () => {
    loadPluginMetadataSnapshot.mockReturnValue({
      index: {
        plugins: [
          {
            pluginId: "bundled-search",
            origin: "bundled",
            enabled: true,
            enabledByDefault: true,
          },
          {
            pluginId: "external-search",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        {
          id: "bundled-search",
          origin: "bundled",
          contracts: { webSearchProviders: ["search"] },
        },
        {
          id: "external-search",
          origin: "global",
          contracts: { webSearchProviders: ["search"] },
        },
      ],
    });

    expect(
      resolveManifestContractRuntimePluginResolution({
        cfg: {},
        contract: "webSearchProviders",
        value: "search",
      }),
    ).toEqual({
      pluginIds: ["bundled-search", "external-search"],
      bundledCompatPluginIds: ["bundled-search"],
    });
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env: process.env,
      preferPersisted: false,
    });
  });
});
