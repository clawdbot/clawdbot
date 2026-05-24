import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { PluginCandidate, PluginDiscoveryResult } from "./discovery.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("./discovery.js");
  vi.doUnmock("./installed-plugin-index-record-reader.js");
});

const ENV: NodeJS.ProcessEnv = { HOME: "/tmp/openclaw-test-home" };
let loadCase = 0;

const RECORDS: Record<string, PluginInstallRecord> = {
  weixin: {
    source: "npm",
    spec: "@tencent-weixin/openclaw-weixin@2.3.7",
    installPath:
      "/tmp/openclaw-test-home/.openclaw/npm/node_modules/@tencent-weixin/openclaw-weixin",
  } as PluginInstallRecord,
};

function emptyDiscoveryResult(): PluginDiscoveryResult {
  return {
    candidates: [] as PluginCandidate[],
    diagnostics: [],
  };
}

async function loadWithMocks(params: {
  loadRecords?: (env: NodeJS.ProcessEnv | undefined) => Record<string, PluginInstallRecord>;
}): Promise<{
  module: typeof import("./channel-catalog-registry.js");
  discoverSpy: ReturnType<typeof vi.fn>;
  loadRecordsSpy: ReturnType<typeof vi.fn>;
}> {
  const discoverSpy = vi.fn(() => emptyDiscoveryResult());
  const loadRecordsSpy = vi.fn((opts: { env?: NodeJS.ProcessEnv } = {}) => {
    return params.loadRecords ? params.loadRecords(opts.env) : RECORDS;
  });

  vi.doMock("./discovery.js", () => ({ discoverOpenClawPlugins: discoverSpy }));
  vi.doMock("./installed-plugin-index-record-reader.js", () => ({
    loadInstalledPluginIndexInstallRecordsSync: loadRecordsSpy,
  }));

  const module = await importFreshModule<typeof import("./channel-catalog-registry.js")>(
    import.meta.url,
    `./channel-catalog-registry.js?case=${++loadCase}`,
  );
  return { module, discoverSpy, loadRecordsSpy };
}

function firstDiscoverOptions(discoverSpy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = discoverSpy.mock.calls[0];
  if (!call) {
    throw new Error("expected discovery call");
  }
  const [options] = call;
  if (!options || typeof options !== "object") {
    throw new Error("expected discovery options");
  }
  return options as Record<string, unknown>;
}

function createChannelCandidate(params: {
  idHint?: string;
  pluginId?: string;
  bundledPluginId?: string;
  origin?: PluginCandidate["origin"];
}): PluginCandidate {
  return {
    idHint: params.idHint ?? "hint-plugin",
    source: "/tmp/openclaw-test-plugin/index.js",
    rootDir: "/tmp/openclaw-test-plugin",
    origin: params.origin ?? "global",
    packageName: "@vendor/openclaw-test-plugin",
    packageManifest: {
      ...(params.pluginId ? { plugin: { id: params.pluginId } } : {}),
      channel: {
        id: "test-channel",
        name: "Test Channel",
        description: "Test channel",
      },
    },
    ...(params.bundledPluginId ? { bundledManifestId: params.bundledPluginId } : {}),
  } as PluginCandidate;
}

describe("listChannelCatalogEntries", () => {
  it("forwards lazily loaded install records to discovery when origin is unspecified", async () => {
    const { module, discoverSpy, loadRecordsSpy } = await loadWithMocks({});

    module.listChannelCatalogEntries({ env: ENV });

    expect(loadRecordsSpy).toHaveBeenCalledTimes(1);
    expect(loadRecordsSpy).toHaveBeenCalledWith({ env: ENV });
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(firstDiscoverOptions(discoverSpy)).toStrictEqual({
      env: ENV,
      installRecords: RECORDS,
      workspaceDir: undefined,
    });
  });

  it("skips ledger lookup when origin is 'bundled' and omits installRecords", async () => {
    const { module, discoverSpy, loadRecordsSpy } = await loadWithMocks({});

    module.listChannelCatalogEntries({ origin: "bundled", env: ENV });

    expect(loadRecordsSpy).not.toHaveBeenCalled();
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(firstDiscoverOptions(discoverSpy)).not.toHaveProperty("installRecords");
  });

  it("uses caller-supplied install records verbatim and does not load the ledger", async () => {
    const { module, discoverSpy, loadRecordsSpy } = await loadWithMocks({});
    const supplied: Record<string, PluginInstallRecord> = {
      slack: {
        source: "npm",
        spec: "@openclaw/slack@1.0.0",
      } as PluginInstallRecord,
    };

    module.listChannelCatalogEntries({ env: ENV, installRecords: supplied });

    expect(loadRecordsSpy).not.toHaveBeenCalled();
    expect(firstDiscoverOptions(discoverSpy)).toStrictEqual({
      env: ENV,
      installRecords: supplied,
      workspaceDir: undefined,
    });
  });

  it("omits installRecords from discovery when the ledger is empty", async () => {
    const { module, discoverSpy, loadRecordsSpy } = await loadWithMocks({
      loadRecords: () => ({}),
    });

    module.listChannelCatalogEntries({ env: ENV });

    expect(loadRecordsSpy).toHaveBeenCalledTimes(1);
    expect(firstDiscoverOptions(discoverSpy)).not.toHaveProperty("installRecords");
  });

  it("treats ledger read errors as a soft fallback (no installRecords propagated)", async () => {
    const { module, discoverSpy, loadRecordsSpy } = await loadWithMocks({
      loadRecords: () => {
        throw new Error("simulated reader failure");
      },
    });

    expect(module.listChannelCatalogEntries({ env: ENV })).toStrictEqual([]);

    expect(loadRecordsSpy).toHaveBeenCalledTimes(1);
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(firstDiscoverOptions(discoverSpy)).not.toHaveProperty("installRecords");
  });

  it("uses discovered package metadata for channel plugin ids", async () => {
    const { module, loadRecordsSpy } = await loadWithMocks({});

    expect(
      module.listChannelCatalogEntries({
        installRecords: {},
        discovery: {
          candidates: [createChannelCandidate({ pluginId: "package-plugin" })],
          diagnostics: [],
        },
      }),
    ).toStrictEqual([
      {
        pluginId: "package-plugin",
        origin: "global",
        packageName: "@vendor/openclaw-test-plugin",
        workspaceDir: undefined,
        rootDir: "/tmp/openclaw-test-plugin",
        channel: {
          id: "test-channel",
          name: "Test Channel",
          description: "Test channel",
        },
      },
    ]);
    expect(loadRecordsSpy).not.toHaveBeenCalled();
  });

  it("prefers bundled manifest ids over package id hints", async () => {
    const { module } = await loadWithMocks({});

    expect(
      module.listChannelCatalogEntries({
        installRecords: {},
        discovery: {
          candidates: [
            createChannelCandidate({
              idHint: "hint-plugin",
              pluginId: "package-plugin",
              bundledPluginId: "bundled-plugin",
              origin: "bundled",
            }),
          ],
          diagnostics: [],
        },
      })[0]?.pluginId,
    ).toBe("bundled-plugin");
  });
});
