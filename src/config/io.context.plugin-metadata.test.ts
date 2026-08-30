import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordPluginCandidateInstallOwner,
  resolvePluginCandidateInstallOwner,
} from "../plugins/candidate-install-owner.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index-types.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { restorePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";

const mocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

const { resolveReadOnlyChannelPluginsForConfig } = await import("../channels/plugins/read-only.js");
const { createConfigIoContext } = await import("./io.context.js");
const { resolveConfigWidePluginMetadataSnapshot, resolveConfigWidePluginManifestRegistry } =
  await import("./io.plugin-metadata.js");

const agents = {
  ownership: "explicit" as const,
  entries: {
    ops: { workspace: "/srv/ops" },
    research: { workspace: "/srv/research" },
  },
};

function manifestRecord(params: {
  id: string;
  source: string;
  channels?: string[];
}): PluginManifestRecord {
  return {
    id: params.id,
    name: params.id,
    description: "test plugin",
    version: "1.0.0",
    source: params.source,
    rootDir: params.source,
    manifestPath: `${params.source}/openclaw.plugin.json`,
    origin: "workspace",
    channels: params.channels ?? [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
  };
}

function workspaceSnapshot(
  workspaceDir: string,
  plugins: PluginManifestRecord[],
  disabledIds: readonly string[] = [],
) {
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    workspaceDir,
    installRecords: {},
    diagnostics: [],
    plugins: plugins.map((plugin) => ({
      pluginId: plugin.id,
      source: plugin.source,
      manifestPath: plugin.manifestPath,
      manifestHash: "test",
      rootDir: plugin.rootDir,
      origin: plugin.origin,
      enabled: !disabledIds.includes(plugin.id),
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      compat: [],
    })),
  };
  return restorePluginMetadataSnapshot({
    workspaceDir,
    policyHash: "test",
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: plugins.length,
      manifestPluginCount: plugins.length,
    },
    discovery: {
      candidates: plugins.map((plugin) =>
        recordPluginCandidateInstallOwner(
          {
            idHint: plugin.id,
            source: plugin.source,
            rootDir: plugin.rootDir,
            origin: plugin.origin,
            workspaceDir,
          },
          plugin.id,
        ),
      ),
      diagnostics: [],
    },
  });
}

describe("config IO plugin metadata snapshots", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    mocks.resolvePluginMetadataSnapshot.mockReset();
  });

  it("shares first-access inventory across config reads and alternating plugin selections", () => {
    const primary = manifestRecord({ id: "primary", source: "/srv/ops/primary" });
    const secondary = manifestRecord({ id: "secondary", source: "/srv/research/secondary" });
    const snapshots = new Map([
      ["/srv/ops", workspaceSnapshot("/srv/ops", [primary])],
      ["/srv/research", workspaceSnapshot("/srv/research", [secondary])],
    ]);
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );
    const config = { agents };
    for (let read = 0; read < 2; read++) {
      const context = createConfigIoContext({ env: {}, observe: false });
      const loader = context.createValidationPluginMetadataSnapshotLoader({
        effectiveConfigRaw: config,
        env: {},
      });
      loader.load(config);
      expect(loader.getSnapshot()?.plugins.map((plugin) => plugin.id)).toEqual([
        "primary",
        "secondary",
      ]);
    }
    for (const pluginId of ["primary", "secondary", "primary"]) {
      expect(
        resolveConfigWidePluginManifestRegistry({
          config,
          env: {},
          pluginIds: [pluginId],
        }).plugins.map((plugin) => plugin.id),
      ).toEqual([pluginId]);
    }
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledTimes(2);
  });

  it("feeds merged workspace plugins to snapshot-backed read-only discovery", () => {
    const primary = manifestRecord({ id: "primary", source: "/srv/ops/primary" });
    const secondary = manifestRecord({
      id: "research-chat-plugin",
      source: "/srv/research/research-chat-plugin",
      channels: ["research-chat"],
    });
    const mergedRegistry = { plugins: [primary, secondary], diagnostics: [] };
    const snapshots = new Map([
      ["/srv/ops", workspaceSnapshot("/srv/ops", [primary], ["primary"])],
      ["/srv/research", workspaceSnapshot("/srv/research", [secondary])],
    ]);
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );
    const cfg = {
      agents,
      channels: { "research-chat": { enabled: true } },
      plugins: {
        allow: ["research-chat-plugin"],
        entries: { "research-chat-plugin": { enabled: true } },
      },
    };
    const context = createConfigIoContext({ env: {}, observe: false });
    const loader = context.createValidationPluginMetadataSnapshotLoader({
      effectiveConfigRaw: cfg,
      env: {},
    });
    loader.load(cfg);
    const snapshot = loader.getSnapshot();

    expect(snapshot?.index.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "primary",
      "research-chat-plugin",
    ]);
    expect(snapshot?.registryIndex).toEqual(snapshots.get("/srv/ops")?.registryIndex);
    expect(snapshot?.registryIndex.plugins.map((plugin) => plugin.pluginId)).toEqual(["primary"]);
    expect(snapshot?.plugins).toEqual(mergedRegistry.plugins);
    expect(structuredClone(snapshot?.manifestRegistry)).toEqual(mergedRegistry);
    expect(snapshot?.index.plugins.find((plugin) => plugin.pluginId === "primary")?.enabled).toBe(
      false,
    );
    expect(snapshot?.byPluginId.get("research-chat-plugin")).toBe(secondary);
    expect(snapshot?.owners.channels.get("research-chat")).toEqual(["research-chat-plugin"]);
    expect(snapshot?.discovery?.candidates.map((candidate) => candidate.workspaceDir)).toEqual([
      "/srv/ops",
      "/srv/research",
    ]);
    expect(snapshot?.discovery?.candidates.map(resolvePluginCandidateInstallOwner)).toEqual([
      "primary",
      "research-chat-plugin",
    ]);
    expect(Object.isFrozen(snapshot?.index.plugins)).toBe(true);
    expect(loader.getSnapshot()).toBe(snapshot);
    expect(
      resolveReadOnlyChannelPluginsForConfig(cfg, {
        env: {},
        metadataSnapshot: snapshot,
      }).plugins.map((plugin) => plugin.id),
    ).toContain("research-chat");
  });

  it("preserves shared source order and rejects conflicting IDs throughout the inventory", () => {
    const primary = manifestRecord({ id: "primary", source: "/srv/ops/primary" });
    const shared = manifestRecord({ id: "shared", source: "/plugins/shared" });
    const secondary = manifestRecord({ id: "secondary", source: "/srv/research/secondary" });
    const snapshots = new Map([
      [
        "/srv/ops",
        workspaceSnapshot("/srv/ops", [
          primary,
          shared,
          manifestRecord({ id: "conflict", source: "/srv/ops/conflict" }),
        ]),
      ],
      [
        "/srv/research",
        workspaceSnapshot("/srv/research", [
          secondary,
          shared,
          manifestRecord({ id: "conflict", source: "/srv/research/conflict" }),
        ]),
      ],
    ]);
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
    );

    const snapshot = resolveConfigWidePluginMetadataSnapshot({ config: { agents }, env: {} });

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["primary", "shared", "secondary"]);
    expect(snapshot.index.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "primary",
      "shared",
      "secondary",
    ]);
    expect(snapshot.discovery?.candidates.map((candidate) => candidate.idHint)).toEqual([
      "primary",
      "shared",
      "secondary",
    ]);
    expect(structuredClone(snapshot.manifestRegistry)).toEqual(snapshot.manifestRegistry);
    expect(
      structuredClone(
        resolveConfigWidePluginManifestRegistry({ config: { agents }, env: {}, pluginIds: [] }),
      ).plugins,
    ).toEqual([]);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "conflict",
        message: expect.stringContaining("present in multiple agent workspaces"),
      }),
    );
  });
});
