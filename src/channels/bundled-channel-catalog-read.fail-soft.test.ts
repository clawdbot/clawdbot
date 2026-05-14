import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("listBundledChannelCatalogEntries discovery failures", () => {
  it("falls back when bundled package metadata is unavailable during import", async () => {
    vi.doMock("../infra/openclaw-root.js", () => ({
      resolveOpenClawPackageRootSync: () => null,
      resolveOpenClawPackageRoot: async () => null,
    }));
    vi.doMock("../plugins/bundled-dir.js", () => ({
      resolveBundledPluginsDir: () => undefined,
    }));

    const catalog = await importFreshModule<typeof import("./bundled-channel-catalog-read.js")>(
      import.meta.url,
      "./bundled-channel-catalog-read.js?scope=discovery-fail-soft",
    );

    expect(catalog.listBundledChannelCatalogEntries()).toStrictEqual([]);
  });
});
