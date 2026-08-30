// Covers raw channel catalog preparation, lookup, and cold inspection.
import fs from "node:fs";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { PreparedPluginChannelCatalog } from "./channel-catalog-registry.js";
import type { PluginCandidate, PluginDiscoveryResult } from "./discovery.js";
import { withPluginInstallRoots } from "./install-root-context.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("./discovery.js");
  vi.doUnmock("./installed-plugin-index-record-reader.js");
  vi.doUnmock("./current-plugin-metadata-state.js");
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
  loadRecords?: (
    env: NodeJS.ProcessEnv | undefined,
    stateDir?: string,
  ) => Record<string, PluginInstallRecord>;
  discover?: (
    options: Parameters<typeof import("./discovery.js").discoverOpenClawPlugins>[0],
  ) => PluginDiscoveryResult;
}): Promise<{
  module: typeof import("./channel-catalog-registry.js");
  setCatalog: (catalog: PreparedPluginChannelCatalog | undefined) => void;
  discoverSpy: ReturnType<typeof vi.fn>;
  loadRecordsSpy: ReturnType<typeof vi.fn>;
}> {
  let currentCatalog: PreparedPluginChannelCatalog | undefined;
  const discoverSpy = vi.fn(
    (options: Parameters<NonNullable<typeof params.discover>>[0]) =>
      params.discover?.(options) ?? emptyDiscoveryResult(),
  );
  const loadRecordsSpy = vi.fn((opts: { env?: NodeJS.ProcessEnv; stateDir?: string } = {}) => {
    return params.loadRecords ? params.loadRecords(opts.env, opts.stateDir) : RECORDS;
  });

  vi.doMock("./discovery.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./discovery.js")>()),
    discoverOpenClawPlugins: discoverSpy,
  }));
  vi.doMock("./installed-plugin-index-record-reader.js", () => ({
    loadInstalledPluginIndexInstallRecordsSync: loadRecordsSpy,
  }));
  vi.doMock("./current-plugin-metadata-state.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./current-plugin-metadata-state.js")>()),
    getCurrentPluginChannelCatalog: () => currentCatalog,
  }));

  const module = await importFreshModule<typeof import("./channel-catalog-registry.js")>(
    import.meta.url,
    `./channel-catalog-registry.js?case=${++loadCase}`,
  );
  return {
    module,
    setCatalog: (catalog) => {
      currentCatalog = catalog;
    },
    discoverSpy,
    loadRecordsSpy,
  };
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

function catalogSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  installRecords?: Record<string, PluginInstallRecord>;
  candidates?: PluginCandidate[];
}) {
  const snapshot = createPluginMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    manifestRegistry: makeRegistry([]),
  });
  return {
    ...snapshot,
    index: { ...snapshot.index, installRecords: params.installRecords ?? RECORDS },
    ...(params.candidates ? { discovery: { candidates: params.candidates, diagnostics: [] } } : {}),
  };
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
      extraPaths: undefined,
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

  it("uses live caller-supplied install records without loading the ledger", async () => {
    const { module, discoverSpy, loadRecordsSpy } = await loadWithMocks({
      discover: ({ installRecords }) => ({
        candidates: Object.keys(installRecords ?? {}).map((pluginId) =>
          createChannelCandidate({ pluginId }),
        ),
        diagnostics: [],
      }),
    });
    const supplied: Record<string, PluginInstallRecord> = {
      slack: {
        source: "npm",
        spec: "@openclaw/slack@1.0.0",
      } as PluginInstallRecord,
    };

    expect(
      module
        .listChannelCatalogEntries({ env: ENV, installRecords: supplied })
        .map((entry) => entry.pluginId),
    ).toEqual(["slack"]);

    expect(loadRecordsSpy).not.toHaveBeenCalled();
    expect(firstDiscoverOptions(discoverSpy)).toStrictEqual({
      env: ENV,
      extraPaths: undefined,
      installRecords: supplied,
      workspaceDir: undefined,
    });
    supplied.telegram = { source: "npm", spec: "@openclaw/telegram@1.0.0" };
    expect(
      module
        .listChannelCatalogEntries({ env: ENV, installRecords: supplied })
        .map((entry) => entry.pluginId),
    ).toEqual(["slack", "telegram"]);
    expect(loadRecordsSpy).not.toHaveBeenCalled();
  });

  it("omits installRecords from discovery when the ledger is empty", async () => {
    const { module, discoverSpy, loadRecordsSpy } = await loadWithMocks({
      loadRecords: () => ({}),
    });

    module.listChannelCatalogEntries({ env: ENV });

    expect(loadRecordsSpy).toHaveBeenCalledTimes(1);
    expect(firstDiscoverOptions(discoverSpy)).not.toHaveProperty("installRecords");
  });

  it("forwards caller-supplied extraPaths to discovery", async () => {
    const { module, discoverSpy } = await loadWithMocks({});

    module.listChannelCatalogEntries({
      env: ENV,
      extraPaths: ["/tmp/plugins/a", "/tmp/plugins/b"],
    });

    expect(firstDiscoverOptions(discoverSpy)).toStrictEqual({
      env: ENV,
      extraPaths: ["/tmp/plugins/a", "/tmp/plugins/b"],
      installRecords: RECORDS,
      workspaceDir: undefined,
    });
  });

  it("retries the ledger after a cold inspection falls back from a read error", async () => {
    const { module, discoverSpy, loadRecordsSpy } = await loadWithMocks({});
    loadRecordsSpy.mockImplementationOnce(() => {
      throw new Error("simulated reader failure");
    });

    expect(module.listChannelCatalogEntries({ env: ENV })).toStrictEqual([]);

    expect(loadRecordsSpy).toHaveBeenCalledTimes(1);
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(firstDiscoverOptions(discoverSpy)).not.toHaveProperty("installRecords");

    module.listChannelCatalogEntries({ env: ENV });
    expect(discoverSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ installRecords: RECORDS }),
    );
    expect(loadRecordsSpy).toHaveBeenCalledTimes(2);
  });

  it("uses discovered package metadata for channel plugin ids", async () => {
    const { module, loadRecordsSpy } = await loadWithMocks({});

    expect(
      module.listChannelCatalogEntries({
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

describe("prepared channel catalogs", () => {
  it("retains raw workspace shadows and serves alternating scopes without filesystem or hash work", async () => {
    const { module, setCatalog, discoverSpy, loadRecordsSpy } = await loadWithMocks({});
    const { preparePluginChannelCatalogs } = await import("./plugin-metadata-catalog.js");
    const bundled = createChannelCandidate({ pluginId: "bundled", origin: "bundled" });
    const workspaces = new Map(
      [undefined, "/tmp/workspace-a", "/tmp/workspace-b"].map((workspaceDir) => [
        workspaceDir,
        catalogSnapshot({
          workspaceDir,
          candidates: [
            createChannelCandidate({
              pluginId: workspaceDir ?? "shared",
              origin: workspaceDir ? "workspace" : "global",
            }),
            bundled,
          ],
        }),
      ]),
    );
    setCatalog(preparePluginChannelCatalogs({ config: {}, env: ENV, workspaces }).catalog);
    expect(discoverSpy).not.toHaveBeenCalled();
    loadRecordsSpy.mockClear();
    const fileReads = [
      "existsSync",
      "statSync",
      "lstatSync",
      "realpathSync",
      "readFileSync",
    ] as const;
    for (const method of fileReads) {
      vi.spyOn(fs, method).mockImplementation(() => {
        throw new Error(`unexpected ${method}`);
      });
    }
    const stringify = vi.spyOn(JSON, "stringify");
    const ids = [undefined, "/tmp/workspace-a", "/tmp/workspace-b", "/tmp/workspace-a"].map(
      (workspaceDir) =>
        module.listChannelCatalogEntries({ env: ENV, workspaceDir }).map((entry) => entry.pluginId),
    );
    const bundledIds = module
      .listChannelCatalogEntries({ origin: "bundled", env: ENV })
      .map((entry) => entry.pluginId);
    const serializations = stringify.mock.calls.length;
    stringify.mockRestore();
    expect(ids).toEqual([
      ["shared", "bundled"],
      ["/tmp/workspace-a", "bundled"],
      ["/tmp/workspace-b", "bundled"],
      ["/tmp/workspace-a", "bundled"],
    ]);
    expect(bundledIds).toEqual(["bundled"]);
    expect(serializations).toBe(0);
    expect(discoverSpy).not.toHaveBeenCalled();
    expect(loadRecordsSpy).not.toHaveBeenCalled();
  });

  it("prepares missing raw discovery and default paths without losing configured shadows", async () => {
    const { module, setCatalog, discoverSpy } = await loadWithMocks({
      discover: (options) => ({
        candidates: [
          createChannelCandidate({
            pluginId: `${options.workspaceDir ?? "shared"}:${options.extraPaths?.length ? "configured" : "default"}`,
          }),
        ],
        diagnostics: [],
      }),
    });
    const { preparePluginChannelCatalogs } = await import("./plugin-metadata-catalog.js");
    const config = { plugins: { load: { paths: ["/tmp/configured-plugin"] } } };
    const workspaceDir = "/tmp/workspace-a";
    setCatalog(
      preparePluginChannelCatalogs({
        config,
        env: ENV,
        workspaces: new Map([
          [
            workspaceDir,
            catalogSnapshot({
              config,
              workspaceDir,
              candidates: [
                createChannelCandidate({ pluginId: "unvalidated-configured", origin: "config" }),
              ],
            }),
          ],
        ]),
      }).catalog,
    );
    expect(
      module.listChannelCatalogEntries({ workspaceDir, extraPaths: config.plugins.load.paths })[0]
        ?.pluginId,
    ).toBe("unvalidated-configured");
    expect(module.listChannelCatalogEntries({ workspaceDir })[0]?.pluginId).toBe(
      `${workspaceDir}:default`,
    );
    expect(module.listChannelCatalogEntries()[0]?.pluginId).toBe("shared:default");
    expect(
      module.listChannelCatalogEntries({ extraPaths: config.plugins.load.paths })[0]?.pluginId,
    ).toBe("shared:configured");
    expect(discoverSpy).toHaveBeenCalledTimes(3);
  });

  it("replaces published catalogs and requires preparation for changed inputs", async () => {
    const { module, setCatalog, discoverSpy, loadRecordsSpy } = await loadWithMocks({});
    const { preparePluginChannelCatalogs } = await import("./plugin-metadata-catalog.js");
    const env = { ...ENV };
    for (const pluginId of ["first", "replacement"]) {
      setCatalog(
        preparePluginChannelCatalogs({
          config: {},
          env,
          workspaces: new Map([
            [undefined, catalogSnapshot({ candidates: [createChannelCandidate({ pluginId })] })],
          ]),
        }).catalog,
      );
      expect(module.listChannelCatalogEntries({ env })[0]?.pluginId).toBe(pluginId);
    }
    discoverSpy.mockClear();
    loadRecordsSpy.mockClear();
    const installRecords = structuredClone(RECORDS);
    expect(module.listChannelCatalogEntries({ env, installRecords })[0]?.pluginId).toBe(
      "replacement",
    );
    installRecords.weixin!.installPath = "/tmp/replaced-install";
    for (const options of [
      { workspaceDir: "/tmp/unprepared" },
      { extraPaths: ["/tmp/other-plugin"] },
      { installRecords },
      { installRecords: {} },
    ]) {
      expect(() => module.listChannelCatalogEntries(options)).toThrow("were not prepared");
    }
    expect(
      module.listChannelCatalogEntries({ env: { ...env, CHANNEL_TOKEN: "new-live-token" } })[0]
        ?.pluginId,
    ).toBe("replacement");
    env.HOME = "/tmp/another-home";
    expect(() => module.listChannelCatalogEntries({ env })).toThrow("were not prepared");
    env.HOME = ENV.HOME;
    expect(() =>
      withPluginInstallRoots(
        {
          extensionsDir: "/tmp/pinned/extensions",
          gitDir: "/tmp/pinned/git",
          npmDir: "/tmp/pinned/npm",
          stateDir: "/tmp/pinned",
        },
        () => module.listChannelCatalogEntries(),
      ),
    ).toThrow("were not prepared");
    expect(discoverSpy).not.toHaveBeenCalled();
    expect(loadRecordsSpy).not.toHaveBeenCalled();
  });

  it.each(["missing discovery", "different install ledger", "explicit state directory"])(
    "prepares raw candidates for a snapshot with %s",
    async (reason) => {
      const stateDir = reason === "explicit state directory" ? "/tmp/other-state" : undefined;
      const { discoverSpy } = await loadWithMocks({
        loadRecords: (_env, directory) =>
          directory === "/tmp/other-state"
            ? { other: { source: "path", sourcePath: "/tmp/other-plugin" } }
            : RECORDS,
        discover: ({ installRecords }) => ({
          candidates: [
            createChannelCandidate({
              pluginId: installRecords?.other ? "other-ledger-channel" : "ledger-channel",
            }),
          ],
          diagnostics: [],
        }),
      });
      const { preparePluginChannelCatalogs } = await import("./plugin-metadata-catalog.js");
      const snapshot = catalogSnapshot(
        reason === "missing discovery"
          ? {}
          : {
              installRecords: {},
              candidates: [createChannelCandidate({ pluginId: "old-channel" })],
            },
      );
      const prepared = preparePluginChannelCatalogs({
        config: {},
        env: ENV,
        stateDir,
        workspaces: new Map([[undefined, snapshot]]),
      });
      const expectedPluginId = stateDir ? "other-ledger-channel" : "ledger-channel";
      expect(prepared.catalog.read({})[0]?.pluginId).toBe(expectedPluginId);
      expect(prepared.catalog.read({})[0]?.pluginId).toBe(expectedPluginId);
      expect(prepared.discoveries.get(undefined)?.candidates[0]?.packageManifest?.plugin?.id).toBe(
        expectedPluginId,
      );
      expect(discoverSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects incomplete preparation when the install ledger cannot be read", async () => {
    await loadWithMocks({
      loadRecords: () => {
        throw new Error("unreadable ledger");
      },
    });
    const { preparePluginChannelCatalogs } = await import("./plugin-metadata-catalog.js");
    expect(() =>
      preparePluginChannelCatalogs({ config: {}, env: ENV, workspaces: new Map() }),
    ).toThrow("unreadable ledger");
  });
});
