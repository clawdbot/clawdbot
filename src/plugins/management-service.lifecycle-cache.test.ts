import { describe, expect, it, vi } from "vitest";
import {
  clearPluginMetadataLifecycleCaches,
  registerPluginMetadataProcessMemoLifecycleClear,
} from "./plugin-metadata-lifecycle.js";

const mocks = vi.hoisted(() => ({
  currentMetadata: undefined as unknown,
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => {
    if (mocks.currentMetadata !== undefined) {
      return mocks.currentMetadata;
    }
    const metadata = mocks.metadata(...args);
    mocks.currentMetadata = metadata;
    return metadata;
  },
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

const { listManagedPlugins } = await import("./management-service.js");

registerPluginMetadataProcessMemoLifecycleClear(() => {
  mocks.currentMetadata = undefined;
});

function metadataSnapshot(pluginId?: string) {
  return {
    index: {
      plugins: pluginId
        ? [{ pluginId, packageName: `community/${pluginId}`, origin: "global", enabled: true }]
        : [],
      installRecords: {},
    },
    byPluginId: new Map(),
    plugins: [],
    diagnostics: [],
    normalizePluginId: (rawPluginId: string) => rawPluginId,
  };
}

describe("plugin management catalog lifecycle", () => {
  it("serves the first plugins.list load from prewarmed metadata and official catalog caches", async () => {
    clearPluginMetadataLifecycleCaches();
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot())
      .mockReturnValueOnce(metadataSnapshot("fresh-plugin"));
    mocks.officialCatalog
      .mockResolvedValueOnce({
        source: "hosted",
        entries: [
          {
            id: "@openclaw/diffs",
            title: "Diffs",
            state: "available",
            featured: true,
            publisher: { id: "openclaw", trust: "official" },
            install: {
              candidates: [
                {
                  sourceRef: "public-clawhub",
                  package: "@openclaw/diffs",
                  version: "2026.6.11",
                  integrity: `sha256:${"a".repeat(64)}`,
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({ source: "hosted", entries: [] });

    const prewarmed = await listManagedPlugins({ config: {}, env: {} });
    const firstHandlerLoad = await listManagedPlugins({ config: {}, env: {} });

    expect(prewarmed.plugins).toEqual([expect.objectContaining({ id: "diffs" })]);
    expect(firstHandlerLoad.plugins).toEqual(prewarmed.plugins);
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
    expect(mocks.officialCatalog).toHaveBeenCalledTimes(1);

    clearPluginMetadataLifecycleCaches();

    const refreshed = await listManagedPlugins({ config: {}, env: {} });

    expect(mocks.metadata).toHaveBeenCalledTimes(2);
    expect(mocks.officialCatalog).toHaveBeenCalledTimes(2);
    expect(refreshed.plugins).toEqual([
      expect.objectContaining({ id: "fresh-plugin", installed: true, enabled: true }),
    ]);
  });
});
