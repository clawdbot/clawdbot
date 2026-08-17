// Verifies lifecycle snapshot loading, ownership facts, and immutable boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  completePluginMetadataSnapshot,
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

function makeIndex(pluginId = "demo"): InstalledPluginIndex {
  const rootDir = `/plugins/${pluginId}`;
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: {},
    diagnostics: [],
    plugins: [
      {
        pluginId,
        manifestPath: `${rootDir}/openclaw.plugin.json`,
        manifestHash: `${pluginId}-manifest`,
        rootDir,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
  };
}

function makeManifestRegistry(pluginId = "demo"): PluginManifestRegistry {
  const plugin: PluginManifestRecord = {
    id: pluginId,
    name: pluginId,
    channels: [],
    providers: [pluginId],
    cliBackends: [],
    skills: [],
    hooks: [],
    commandAliases: [{ name: `${pluginId}-command` }],
    rootDir: `/plugins/${pluginId}`,
    source: `/plugins/${pluginId}/index.js`,
    manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
    origin: "global",
  };
  return { plugins: [plugin], diagnostics: [] };
}

describe("plugin metadata snapshot", () => {
  beforeEach(() => {
    loadPluginRegistrySnapshotWithMetadata.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry());
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  it("keeps explicit control-plane loads fresh", () => {
    const index = makeIndex();
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index });

    expect(second).not.toBe(first);
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(2);
  });

  it("promotes one scoped lifecycle graph and reuses it across runtime resolutions", () => {
    const config = {};
    const workspaceDir = "/workspace";
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    const scoped = loadPluginMetadataSnapshot({
      config,
      env: {},
      index,
      pluginIds: ["demo"],
      workspaceDir,
    });

    const complete = completePluginMetadataSnapshot({
      snapshot: scoped,
      config,
      env: {},
      workspaceDir,
    });
    expect(complete?.pluginIds).toBeUndefined();
    setCurrentPluginMetadataSnapshot(complete, { config, env: {}, workspaceDir });
    loadPluginRegistrySnapshotWithMetadata.mockClear();
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    expect(
      completePluginMetadataSnapshot({ snapshot: complete, config, env: {}, workspaceDir }),
    ).toBe(complete);
    expect(resolvePluginMetadataSnapshot({ env: {}, allowWorkspaceScopedCurrent: true })).toBe(
      complete,
    );
    for (let iteration = 0; iteration < 20; iteration += 1) {
      expect(resolvePluginMetadataSnapshot({ config, env: {}, workspaceDir })).toBe(complete);
    }
    expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("reuses workspace-independent lifecycle metadata for a new workspace", () => {
    const config = {};
    const sourceWorkspace = "/workspace/source";
    const targetWorkspace = "/workspace/target";
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    index.workspaceDir = sourceWorkspace;
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    const source = loadPluginMetadataSnapshot({
      config,
      env: {},
      index,
      workspaceDir: sourceWorkspace,
    });
    setCurrentPluginMetadataSnapshot(source, {
      config,
      env: {},
      workspaceDir: sourceWorkspace,
    });
    loadPluginRegistrySnapshotWithMetadata.mockClear();
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    const resolved = resolvePluginMetadataSnapshot({
      config,
      env: {},
      workspaceDir: targetWorkspace,
      workspacePluginRootPresent: false,
    });

    expect(resolved).not.toBe(source);
    expect(resolved.workspaceDir).toBe(targetWorkspace);
    expect(resolved.index.workspaceDir).toBe(targetWorkspace);
    expect(resolved.plugins).toBe(source.plugins);
    expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();

    resolvePluginMetadataSnapshot({
      config,
      env: {},
      workspaceDir: targetWorkspace,
      workspacePluginRootPresent: true,
    });
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledOnce();
  });

  it("loads a fresh graph when no caller asserted workspace plugin-root absence", () => {
    // Startup config validation never resolves workspace plugin-root presence, so it must keep
    // loading. Projecting the published graph instead would serve whatever inventory happened to
    // be current, and startup convergence rewrites that inventory between the two reads that
    // form the migration checkpoint identity — the gateway then refuses to report ready.
    const config = {};
    const sourceWorkspace = "/workspace/source";
    const targetWorkspace = "/workspace/target";
    const staleIndex = makeIndex("stale");
    staleIndex.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    staleIndex.workspaceDir = sourceWorkspace;
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: staleIndex,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry("stale"));
    const stale = loadPluginMetadataSnapshot({
      config,
      env: {},
      index: staleIndex,
      workspaceDir: sourceWorkspace,
    });
    setCurrentPluginMetadataSnapshot(stale, { config, env: {}, workspaceDir: sourceWorkspace });

    // Convergence replaced the persisted inventory; a fresh load now sees a different graph.
    const freshIndex = makeIndex("fresh");
    freshIndex.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    freshIndex.workspaceDir = targetWorkspace;
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: freshIndex,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry("fresh"));

    const resolved = resolvePluginMetadataSnapshot({
      config,
      env: {},
      workspaceDir: targetWorkspace,
    });

    expect(resolved.index.plugins.map((plugin) => plugin.pluginId)).toEqual(["fresh"]);
    expect(resolved.configFingerprint).toBe(
      loadPluginMetadataSnapshot({ config, env: {}, workspaceDir: targetWorkspace })
        .configFingerprint,
    );
  });

  it("rewalks collection-bearing manifest graphs after prototype mutation", () => {
    const index = makeIndex();
    const registry = makeManifestRegistry();
    const plugin = registry.plugins[0];
    if (!plugin) {
      throw new Error("expected manifest plugin fixture");
    }
    const initialMapValue = { nested: { value: "initial-map" } };
    const initialSetValue = { nested: { value: "initial-set" } };
    const sharedMap = new Map([["initial", initialMapValue]]);
    const sharedSet = new Set([initialSetValue]);
    plugin.configSchema = {
      type: "object",
      properties: { sharedMap, sharedSet },
    };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(Object.isFrozen(initialMapValue.nested)).toBe(true);
    expect(Object.isFrozen(initialSetValue.nested)).toBe(true);
    expect(() => sharedMap.set("blocked", initialMapValue)).toThrow(
      "Plugin metadata snapshots are immutable",
    );
    expect(() => sharedSet.add(initialSetValue)).toThrow("Plugin metadata snapshots are immutable");

    const injectedMapValue = { nested: { value: "injected-map" } };
    const injectedSetValue = { nested: { value: "injected-set" } };
    Map.prototype.set.call(sharedMap, "injected", injectedMapValue);
    Set.prototype.add.call(sharedSet, injectedSetValue);
    expect(sharedMap.get("injected")).toBe(injectedMapValue);
    expect(sharedSet.has(injectedSetValue)).toBe(true);
    expect(Object.isFrozen(injectedMapValue.nested)).toBe(false);
    expect(Object.isFrozen(injectedSetValue.nested)).toBe(false);

    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(second).not.toBe(first);
    expect(second.index).not.toBe(first.index);
    expect(second.manifestRegistry).toBe(registry);
    expect(Object.isFrozen(injectedMapValue)).toBe(true);
    expect(Object.isFrozen(injectedMapValue.nested)).toBe(true);
    expect(Object.isFrozen(injectedSetValue)).toBe(true);
    expect(Object.isFrozen(injectedSetValue.nested)).toBe(true);
    expect(() => {
      injectedMapValue.nested.value = "mutated";
    }).toThrow();
    expect(() => {
      injectedSetValue.nested.value = "mutated";
    }).toThrow();
    expect(() => sharedMap.delete("injected")).toThrow("Plugin metadata snapshots are immutable");
    expect(() => sharedSet.delete(injectedSetValue)).toThrow(
      "Plugin metadata snapshots are immutable",
    );
  });

  it("rewalks enumerable accessor graphs when their closure-backed values change", () => {
    const index = makeIndex();
    const registry = makeManifestRegistry();
    const plugin = registry.plugins[0];
    if (!plugin) {
      throw new Error("expected manifest plugin fixture");
    }
    let accessorValue = { nested: { value: "initial" } };
    const accessor = {} as { current: typeof accessorValue };
    Object.defineProperty(accessor, "current", {
      enumerable: true,
      get: () => accessorValue,
    });
    plugin.configSchema = {
      type: "object",
      properties: { accessor },
    };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(Object.isFrozen(accessor)).toBe(true);
    expect(Object.isFrozen(accessorValue)).toBe(true);
    expect(Object.isFrozen(accessorValue.nested)).toBe(true);

    const replacement = { nested: { value: "replacement" } };
    accessorValue = replacement;
    expect(accessor.current).toBe(replacement);
    expect(Object.isFrozen(replacement)).toBe(false);
    expect(Object.isFrozen(replacement.nested)).toBe(false);

    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(second).not.toBe(first);
    expect(second.index).not.toBe(first.index);
    expect(second.manifestRegistry).toBe(registry);
    expect(Object.isFrozen(replacement)).toBe(true);
    expect(Object.isFrozen(replacement.nested)).toBe(true);
    expect(() => {
      replacement.nested.value = "mutated";
    }).toThrow();
  });

  it("rewalks proxy graphs that forge safe descriptors before their values change", () => {
    const index = makeIndex();
    const registry = makeManifestRegistry();
    const plugin = registry.plugins[0];
    if (!plugin) {
      throw new Error("expected manifest plugin fixture");
    }
    let currentValue = { nested: { value: "decoy" } };
    const target = {} as { current: typeof currentValue };
    Object.defineProperty(target, "current", {
      configurable: true,
      enumerable: true,
      get: () => currentValue,
    });
    let forgedDescriptors = 0;
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(proxyTarget, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, key);
        // Preserve the real accessor during Object.freeze so later proxy reads remain valid.
        if (key === "current" && descriptor?.configurable && forgedDescriptors < 1) {
          forgedDescriptors += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: currentValue,
          };
        }
        return descriptor;
      },
      get(proxyTarget, key, receiver) {
        if (key === "current") {
          return currentValue;
        }
        return Reflect.get(proxyTarget, key, receiver);
      },
    });
    plugin.configSchema = {
      type: "object",
      properties: { proxy },
    };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(forgedDescriptors).toBe(1);
    expect(Object.isFrozen(proxy)).toBe(true);
    expect(Object.isFrozen(currentValue.nested)).toBe(true);

    const replacement = { nested: { value: "real" } };
    currentValue = replacement;
    expect(proxy.current).toBe(replacement);
    expect(Object.isFrozen(replacement)).toBe(false);
    expect(Object.isFrozen(replacement.nested)).toBe(false);

    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(second).not.toBe(first);
    expect(second.index).not.toBe(first.index);
    expect(second.manifestRegistry).toBe(registry);
    expect(Object.isFrozen(replacement)).toBe(true);
    expect(Object.isFrozen(replacement.nested)).toBe(true);
    expect(() => {
      replacement.nested.value = "mutated";
    }).toThrow();
  });

  it("reuses discovery from a derived empty plugin index", () => {
    const index = makeIndex();
    index.plugins = [];
    const discovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: index,
      diagnostics: [],
      discovery,
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    const snapshot = loadPluginMetadataSnapshot({ config: {}, env: {} });

    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        index: expect.objectContaining({ plugins: [] }),
        includeDisabled: true,
      }),
    );
    expect(snapshot.discovery).toBe(discovery);
  });

  it("keeps an empty installed index authoritative without rediscovering plugins", () => {
    const index = makeIndex();
    index.plugins = [];
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: index,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    const snapshot = loadPluginMetadataSnapshot({ config: {}, env: {}, index });

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.index.plugins).toEqual([]);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        index: expect.objectContaining({ plugins: [] }),
        includeDisabled: true,
      }),
    );
  });

  it("carries a derived manifest graph into snapshot construction without rebuilding it", () => {
    const index = makeIndex();
    const manifestRegistry = makeManifestRegistry();
    const discovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: index,
      diagnostics: [],
      discovery,
      manifestRegistry,
    });

    const snapshot = loadPluginMetadataSnapshot({ config: {}, env: {} });

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["demo"]);
    expect(snapshot.registrySource).toBe("derived");
    expect(snapshot.discovery).toBe(discovery);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        manifestRegistry,
        includeDisabled: true,
      }),
    );
  });

  it("reuses the lifecycle-owned current snapshot", () => {
    const config = {};
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    const snapshot = loadPluginMetadataSnapshot({ config, env: {}, index });
    setCurrentPluginMetadataSnapshot(snapshot, { config, env: {} });
    loadPluginRegistrySnapshotWithMetadata.mockClear();
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    expect(resolvePluginMetadataSnapshot({ config, env: {} })).toBe(snapshot);
    expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("propagates the current-snapshot bypass to the registry reader", () => {
    const config = {};
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: index,
      diagnostics: [],
    });
    const current = loadPluginMetadataSnapshot({ config, env: {}, index });
    setCurrentPluginMetadataSnapshot(current, { config, env: {} });
    loadPluginRegistrySnapshotWithMetadata.mockClear();
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: index,
      diagnostics: [],
    });

    const resolved = resolvePluginMetadataSnapshot({
      config,
      env: {},
      allowCurrent: false,
    });

    expect(resolved).not.toBe(current);
    expect(resolved.registrySource).toBe("persisted");
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ allowCurrent: false }),
    );
  });

  it("keeps scoped loads separate without an LRU", () => {
    const index = makeIndex();
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });

    const scoped = loadPluginMetadataSnapshot({
      config: {},
      env: {},
      index,
      pluginIds: ["demo"],
    });
    const unscoped = loadPluginMetadataSnapshot({ config: {}, env: {}, index });

    expect(scoped.pluginIds).toEqual(["demo"]);
    expect(unscoped.pluginIds).toBeUndefined();
    expect(loadPluginManifestRegistryForInstalledIndex.mock.calls[0]?.[0]).toMatchObject({
      pluginIds: ["demo"],
    });
    expect(loadPluginManifestRegistryForInstalledIndex.mock.calls[1]?.[0]).not.toHaveProperty(
      "pluginIds",
    );
  });

  it.each([
    { scope: "explicit empty", pluginIds: [], expectedPluginIds: [] },
    { scope: "explicit owner", pluginIds: ["demo"], expectedPluginIds: ["demo"] },
  ])(
    "does not reuse an unscoped lifecycle graph for an $scope request",
    ({ pluginIds, expectedPluginIds }) => {
      const config = {};
      const index = makeIndex();
      index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
      loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
        source: "provided",
        snapshot: index,
        diagnostics: [],
      });
      const unscoped = loadPluginMetadataSnapshot({ config, env: {}, index });
      setCurrentPluginMetadataSnapshot(unscoped, { config, env: {} });
      loadPluginManifestRegistryForInstalledIndex.mockClear();
      loadPluginManifestRegistryForInstalledIndex.mockImplementation(
        (params: { pluginIds?: readonly string[] }) => ({
          ...makeManifestRegistry(),
          plugins: makeManifestRegistry().plugins.filter(
            (plugin) => params.pluginIds === undefined || params.pluginIds.includes(plugin.id),
          ),
        }),
      );

      const scoped = resolvePluginMetadataSnapshot({ config, env: {}, pluginIds });

      expect(scoped).not.toBe(unscoped);
      expect(scoped.pluginIds).toEqual(pluginIds);
      expect(scoped.plugins.map((plugin) => plugin.id)).toEqual(expectedPluginIds);
      expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ pluginIds }),
      );
    },
  );

  it("prepares provider endpoint and request facts", () => {
    const index = makeIndex();
    const registry = makeManifestRegistry();
    const plugin = registry.plugins[0];
    if (!plugin) {
      throw new Error("expected manifest plugin fixture");
    }
    plugin.providerEndpoints = [
      {
        endpointClass: "openai-public",
        hosts: [" API.EXAMPLE.COM "],
        baseUrls: ["https://api.example.com/v1/"],
      },
    ];
    plugin.providerRequest = {
      providers: {
        demo: {
          family: " demo-family ",
          compatibilityFamily: " moonshot " as never,
          openAICompletions: { supportsStreamingUsage: true },
        },
      },
    };
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);

    const snapshot = loadPluginMetadataSnapshot({ config: {}, env: {}, index });

    expect(snapshot.owners.providerEndpoints).toContainEqual({
      endpointClass: "openai-public",
      hosts: ["api.example.com"],
      hostSuffixes: [],
      baseUrls: ["https://api.example.com/v1"],
    });
    expect(snapshot.owners.providerRequests?.get("demo")).toEqual({
      family: "demo-family",
      compatibilityFamily: "moonshot",
      openAICompletions: { supportsStreamingUsage: true },
    });
  });

  it("freezes a cloned index instead of caller-owned records", () => {
    const index = makeIndex();
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });

    const snapshot = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    const callerRecord = index.plugins[0];
    const snapshotRecord = snapshot.index.plugins[0];
    if (!callerRecord || !snapshotRecord) {
      throw new Error("expected metadata records");
    }

    callerRecord.pluginId = "caller-mutated";
    expect(snapshotRecord.pluginId).toBe("demo");
    expect(() => {
      snapshotRecord.pluginId = "snapshot-mutated";
    }).toThrow();
  });
});
