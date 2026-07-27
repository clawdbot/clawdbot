import { describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

const { listManagedPlugins } = await import("./management-service.js");

describe("plugin management catalog lifecycle", () => {
  it("reuses the hosted official catalog until plugin metadata is invalidated", async () => {
    clearPluginMetadataLifecycleCaches();
    mocks.metadata.mockReturnValue({
      index: { plugins: [], installRecords: {} },
      byPluginId: new Map(),
      plugins: [],
      diagnostics: [],
      normalizePluginId: (pluginId: string) => pluginId,
    });
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

    const initial = await listManagedPlugins({ config: {}, env: {} });
    const cached = await listManagedPlugins({ config: {}, env: {} });

    expect(initial.plugins).toEqual([expect.objectContaining({ id: "diffs" })]);
    expect(cached.plugins).toEqual(initial.plugins);
    expect(mocks.officialCatalog).toHaveBeenCalledTimes(1);

    clearPluginMetadataLifecycleCaches();

    const refreshed = await listManagedPlugins({ config: {}, env: {} });

    expect(mocks.officialCatalog).toHaveBeenCalledTimes(2);
    expect(refreshed.plugins).toEqual([]);
  });
});
