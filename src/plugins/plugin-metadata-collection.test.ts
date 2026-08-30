// Verifies collection preparation, publication, invalidation, and owner disposal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import {
  installPluginMetadataOwner,
  makePluginMetadataIndex as makeIndex,
  makePluginMetadataManifestRegistry as makeManifestRegistry,
} from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "./installed-plugin-index-record-cache.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { createPluginCache, getPluginMetadataSnapshotCache } from "./plugin-cache.js";
import {
  createPluginMetadataOwner,
  getOrCreatePluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  withPluginMetadataCollectionScope,
} from "./plugin-metadata-collection.js";
import {
  clearPluginMetadataLifecycleCaches,
  retainGatewayPluginMetadata,
} from "./plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";

const { loadPluginRegistrySnapshotWithMetadata, loadPluginManifestRegistryForInstalledIndex } =
  vi.hoisted(() => {
    // Shared plugin workers must load this graph after this file's mocks are installed.
    vi.resetModules();
    return {
      loadPluginRegistrySnapshotWithMetadata: vi.fn(),
      loadPluginManifestRegistryForInstalledIndex: vi.fn(),
    };
  });

vi.mock("./plugin-registry-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry-snapshot.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshotWithMetadata: (params: unknown) =>
      loadPluginRegistrySnapshotWithMetadata(params),
  };
});

vi.mock("./manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry-installed.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForInstalledIndex: (params: unknown) =>
      loadPluginManifestRegistryForInstalledIndex(params),
  };
});

vi.mock("./plugin-metadata-catalog.js", () => ({
  preparePluginChannelCatalogs: ({
    workspaces,
  }: {
    workspaces: ReadonlyMap<string | undefined, unknown>;
  }) => ({
    catalog: { read: () => [] },
    discoveries: new Map(
      [...workspaces.keys()].map((workspaceDir) => [
        workspaceDir,
        { candidates: [], diagnostics: [] },
      ]),
    ),
  }),
}));

describe("plugin metadata collection", () => {
  const ownerDisposers: Array<() => void> = [];
  const tempDirs = createTempDirTracker();
  const databasePaths = new Set<string>();
  const openTestStateDatabase = (env: NodeJS.ProcessEnv) => {
    databasePaths.add(openOpenClawStateDatabase({ env }).path);
  };
  beforeEach(() => {
    loadPluginRegistrySnapshotWithMetadata.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockImplementation(
      ({ index }: { index: InstalledPluginIndex }) => ({
        plugins: index.plugins.flatMap((record) => makeManifestRegistry(record.pluginId).plugins),
        diagnostics: [],
      }),
    );
  });

  afterEach(() => {
    for (const dispose of ownerDisposers.splice(0)) {
      dispose();
    }
    for (const databasePath of databasePaths) {
      closeOpenClawStateDatabaseByPath(databasePath);
    }
    databasePaths.clear();
    clearPluginMetadataLifecycleCaches();
    clearLoadInstalledPluginIndexInstallRecordsCache();
    tempDirs.cleanup();
  });

  it.each([
    { scope: "current bypass", options: { allowCurrent: false }, preparation: "successful" },
    { scope: "persisted bypass", options: { preferPersisted: false }, preparation: "successful" },
    {
      scope: "state override",
      options: { stateDir: "/alternate-state" },
      preparation: "successful",
    },
    { scope: "current bypass", options: { allowCurrent: false }, preparation: "failed" },
  ])(
    "keeps $scope fresh after $preparation process metadata preparation",
    ({ options, preparation }) => {
      const config = {};
      const env = {};
      let packageGeneration = "initial";
      loadPluginRegistrySnapshotWithMetadata.mockImplementation(() => {
        const index = makeIndex(packageGeneration);
        index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
        return { source: "provided", snapshot: index, diagnostics: [] };
      });
      const owner = getOrCreatePluginMetadataOwner();
      ownerDisposers.push(() => owner.dispose());
      let prepared: ReturnType<typeof owner.prepare> | undefined;
      if (preparation === "failed") {
        loadPluginRegistrySnapshotWithMetadata.mockImplementationOnce(() => {
          throw new Error("preparation fixture failure");
        });
        expect(() => owner.prepare({ config, env })).toThrow("preparation fixture failure");
      } else {
        prepared = owner.prepare({ config, env });
      }

      const first = loadPluginMetadataSnapshot({ config, env, ...options });
      expect(first.plugins.map((plugin) => plugin.id)).toEqual(["initial"]);
      packageGeneration = "replacement";
      const fresh = loadPluginMetadataSnapshot({ config, env, ...options });

      expect(fresh.plugins.map((plugin) => plugin.id)).toEqual(["replacement"]);
      expect(first.plugins.map((plugin) => plugin.id)).toEqual(["initial"]);
      if (prepared) {
        expect(owner.prepare({ config, env })).toBe(prepared);
        expect(prepared.plugins.map((plugin) => plugin.id)).toEqual(["initial"]);
      }
      expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
    },
  );

  it.each(["process", "operation"] as const)(
    "fences publication after ledger invalidation while retaining only %s reads",
    (scope) => {
      const config = {};
      const env = {};
      let packageGeneration = "initial";
      loadPluginRegistrySnapshotWithMetadata.mockImplementation(() => {
        const index = makeIndex(packageGeneration);
        index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
        return { source: "provided", snapshot: index, diagnostics: [] };
      });
      const owner =
        scope === "process" ? getOrCreatePluginMetadataOwner() : createPluginMetadataOwner();
      ownerDisposers.push(() => owner.dispose());
      const initial = owner.prepare({ config, env });
      packageGeneration = "replacement";

      clearLoadInstalledPluginIndexInstallRecordsCache();

      expect(owner.isPreparedCurrent(initial)).toBe(false);
      expect(() => owner.publish(initial, { config, env })).toThrow(
        "superseded before publication",
      );
      expect(owner.readSnapshot({ config, env, allowWorkspaceScopedCurrent: true })).toBe(
        scope === "operation" ? initial.selectedSnapshot : undefined,
      );
      const read = owner.prepare({ config, env });
      expect(read.plugins.map((plugin) => plugin.id)).toEqual([
        scope === "operation" ? "initial" : "replacement",
      ]);

      owner.invalidatePreparation();
      const refreshed = owner.prepare({ config, env });
      expect(refreshed.plugins.map((plugin) => plugin.id)).toEqual(["replacement"]);
      expect(owner.isPreparedCurrent(refreshed)).toBe(true);
    },
  );

  it.each(["plugin lifecycle invalidation", "database initialization"] as const)(
    "keeps startup facts across %s while publishing a prepared config view",
    async (invalidation) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-plugin-metadata-") };
      const firstWorkspace = `${env.OPENCLAW_STATE_DIR}/first`;
      const secondWorkspace = `${env.OPENCLAW_STATE_DIR}/second`;
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "first" } },
          entries: {
            first: { workspace: firstWorkspace },
            second: { workspace: secondWorkspace },
          },
        },
      };
      let packageVersion = "startup";
      loadPluginRegistrySnapshotWithMetadata.mockImplementation(
        (params: { config?: OpenClawConfig; workspaceDir?: string }) => {
          const workspacePlugin =
            params.workspaceDir === firstWorkspace
              ? "first"
              : params.workspaceDir === secondWorkspace
                ? "second"
                : undefined;
          const pluginIds = [
            `shared-${packageVersion}`,
            ...(workspacePlugin ? [`${workspacePlugin}-${packageVersion}`] : []),
          ];
          const index = makeIndex();
          index.policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
          index.plugins = pluginIds.flatMap((id) => makeIndex(id).plugins);
          return { source: "provided", snapshot: index, diagnostics: [] };
        },
      );
      const releaseGateway = retainGatewayPluginMetadata();
      ownerDisposers.push(releaseGateway);
      const pluginCache = createPluginCache();
      const owner = createPluginMetadataOwner(pluginCache);
      ownerDisposers.push(installPluginMetadataOwner(owner, pluginCache));
      const active = owner.prepare({ config, env });
      owner.publish(active, { config, env });
      const startupInventory = active.unionSnapshot;
      expect(getPluginMetadataSnapshotCache(startupInventory)).toBe(pluginCache);
      for (const snapshot of active.workspaces.values()) {
        expect(getPluginMetadataSnapshotCache(snapshot)).toBe(pluginCache);
      }
      expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(startupInventory);
      packageVersion = "replacement";
      loadPluginRegistrySnapshotWithMetadata.mockClear();
      loadPluginManifestRegistryForInstalledIndex.mockClear();

      const candidateConfig: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          defaults: { systemAgent: { agentId: "second" } },
        },
      };
      const candidate = owner.prepare({ config: candidateConfig, env });
      expect(candidate.selectedSnapshot.workspaceDir).toBe(secondWorkspace);
      expect(owner.getActive()).toBe(active);
      const readyToPublish = createDeferred();
      const publication = readyToPublish.promise.then(() =>
        owner.publish(candidate, { config: candidateConfig, env }),
      );
      if (invalidation === "database initialization") {
        openTestStateDatabase(env);
      } else {
        clearPluginMetadataLifecycleCaches();
      }
      readyToPublish.resolve();
      await expect(publication).resolves.toBeUndefined();
      expect(owner.isPreparedCurrent(candidate)).toBe(true);
      expect(owner.getActive()).toBe(candidate);
      expect(candidate.unionSnapshot).toBe(startupInventory);
      expect(candidate.plugins.map((plugin) => plugin.id)).toEqual([
        "shared-startup",
        "first-startup",
        "second-startup",
      ]);
      expect(
        resolvePluginMetadataSnapshot({
          config: candidateConfig,
          env,
          allowWorkspaceScopedCurrent: true,
        }),
      ).toBe(candidate.selectedSnapshot);
      expect(candidate.selectedSnapshot.plugins.map((plugin) => plugin.id)).toEqual([
        "shared-startup",
        "second-startup",
      ]);
      expect(
        getPluginMetadataWorkspaceSnapshot(candidate, { workspaceDir: undefined }).plugins.map(
          (plugin) => plugin.id,
        ),
      ).toEqual(["shared-startup"]);
      expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(startupInventory);
      expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
      expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();

      releaseGateway();
      expect(owner.isPreparedCurrent(candidate)).toBe(false);
      const restartedCache = createPluginCache();
      const restartedOwner = createPluginMetadataOwner(restartedCache);
      ownerDisposers.push(installPluginMetadataOwner(restartedOwner, restartedCache));
      const restarted = restartedOwner.prepare({ config: candidateConfig, env });
      restartedOwner.publish(restarted, { config: candidateConfig, env });
      expect(restarted.plugins.map((plugin) => plugin.id)).toEqual([
        "shared-replacement",
        "first-replacement",
        "second-replacement",
      ]);
    },
  );

  it.each(["same owner", "foreign seed", "workspace reuse"] as const)(
    "rebuilds %s metadata prepared before database initialization",
    (reuse) => {
      const config = {};
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-plugin-metadata-") };
      const initialIndex = makeIndex();
      initialIndex.policyHash = resolveInstalledPluginIndexPolicyHash(config);
      loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
        source: "provided",
        snapshot: initialIndex,
        diagnostics: [],
      });
      const owner = createPluginMetadataOwner();
      ownerDisposers.push(() => owner.dispose());
      const initial = owner.prepare({ config, env });
      const lookup = { config, env, allowWorkspaceScopedCurrent: true };
      expect(owner.readSnapshot(lookup)).toBe(initial.selectedSnapshot);
      openTestStateDatabase(env);
      const replacementIndex = makeIndex("replacement");
      replacementIndex.policyHash = resolveInstalledPluginIndexPolicyHash(config);
      loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
        source: "provided",
        snapshot: replacementIndex,
        diagnostics: [],
      });
      const nextOwner = reuse === "foreign seed" ? createPluginMetadataOwner() : owner;
      if (nextOwner !== owner) {
        ownerDisposers.push(() => nextOwner.dispose());
      }

      const replacement = nextOwner.prepare({
        config,
        env,
        ...(reuse === "foreign seed" ? { seed: initial } : {}),
        ...(reuse === "workspace reuse"
          ? { additionalWorkspaceDirs: [`${env.OPENCLAW_STATE_DIR}/workspace`] }
          : {}),
      });

      expect(replacement.plugins.map((plugin) => plugin.id)).toEqual(["replacement"]);
      expect(owner.readSnapshot(lookup)).toBe(
        reuse === "foreign seed" ? undefined : replacement.selectedSnapshot,
      );
    },
  );

  it("rejects metadata assembled across database initialization", () => {
    const config = {};
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-plugin-metadata-") };
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockImplementation(() => {
      openTestStateDatabase(env);
      return { source: "provided", snapshot: index, diagnostics: [] };
    });
    const owner = createPluginMetadataOwner();
    ownerDisposers.push(() => owner.dispose());

    expect(() => owner.prepare({ config, env })).toThrow("superseded");
    expect(owner.readSnapshot({ config, env, allowWorkspaceScopedCurrent: true })).toBeUndefined();
  });

  it.each(["process owner", "scoped collection", "owner reuse"] as const)(
    "reads an explicit state directory without inheriting the %s inventory",
    (mode) => {
      const config = {};
      const env = {};
      const stateDir = "/alternate-state";
      const activeIndex = makeIndex("active-store");
      const alternateIndex = makeIndex("alternate-store");
      for (const index of [activeIndex, alternateIndex]) {
        index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
      }
      loadPluginRegistrySnapshotWithMetadata.mockImplementation(
        (params: { stateDir?: string }) => ({
          source: "persisted",
          snapshot: params.stateDir === stateDir ? alternateIndex : activeIndex,
          diagnostics: [],
        }),
      );
      const pluginCache = createPluginCache();
      const owner = createPluginMetadataOwner(pluginCache);
      ownerDisposers.push(installPluginMetadataOwner(owner, pluginCache));
      const active = owner.prepare({ config, env });
      owner.publish(active, { config, env });
      const readAlternate = () =>
        mode === "owner reuse"
          ? owner.prepare({ config, env, stateDir }).manifestRegistry
          : resolveConfigWidePluginManifestRegistry({ config, env, stateDir });

      const alternate =
        mode === "scoped collection"
          ? withPluginMetadataCollectionScope(active, readAlternate, { config, env })
          : readAlternate();

      expect(alternate.plugins.map((plugin) => plugin.id)).toEqual(["alternate-store"]);
      expect(owner.getActive()).toBe(active);
      expect(active.plugins.map((plugin) => plugin.id)).toEqual(["active-store"]);
    },
  );

  it("does not let a retired owner clear a successor using the same prepared graph", () => {
    const config = {};
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    const firstCache = createPluginCache();
    const firstOwner = createPluginMetadataOwner(firstCache);
    const disposeFirst = installPluginMetadataOwner(firstOwner, firstCache);
    ownerDisposers.push(disposeFirst);
    const first = firstOwner.prepare({ config, env: {} });
    firstOwner.publish(first, { config, env: {} });
    disposeFirst();
    const secondCache = createPluginCache();
    const secondOwner = createPluginMetadataOwner(secondCache);
    const disposeSecond = installPluginMetadataOwner(secondOwner, secondCache);
    ownerDisposers.push(disposeSecond);
    const second = secondOwner.prepare({ config, env: {}, seed: first });
    secondOwner.publish(second, { config, env: {} });
    expect(second.selectedSnapshot).toBe(first.selectedSnapshot);

    disposeFirst();
    expect(
      getCurrentPluginMetadataSnapshot({ config, env: {}, allowWorkspaceScopedSnapshot: true }),
    ).toBe(second.selectedSnapshot);
    disposeSecond();
    expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
  });
});
