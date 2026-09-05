// Verifies lifecycle snapshot loading, ownership facts, and immutable boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { buildConfiguredModelCatalog } from "../agents/model-selection-shared.js";
import {
  resolveProviderEndpoint,
  resolveProviderRequestPolicy,
} from "../agents/provider-attribution.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { removeBundledDiscoveryStateRoot } from "./bundled-discovery.test-support.js";
import {
  adoptCurrentPluginMetadataSnapshotIfAbsent,
  getCurrentPluginMetadataSnapshot,
  setGatewayPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "./current-plugin-metadata-snapshot.js";
import { getCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import {
  makePluginMetadataIndex as makeIndex,
  makePluginMetadataManifestRegistry as makeManifestRegistry,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { normalizeProviderModelIdWithManifest } from "./manifest-model-id-normalization.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginMetadataSnapshotCache,
  withPluginCache,
} from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  completePluginMetadataSnapshot,
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
  restorePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

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

function mockSchemaSnapshotSource(
  index: ReturnType<typeof makeIndex>,
  properties: Record<string, unknown>,
) {
  const registry = makeManifestRegistry();
  const plugin = registry.plugins[0];
  if (!plugin) {
    throw new Error("expected manifest plugin fixture");
  }
  plugin.configSchema = { type: "object", properties };
  loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source: "provided",
    snapshot: index,
    diagnostics: [],
  });
  loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);
  return registry;
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

  it("progressively reuses first-access metadata and scopes fresh control-plane loads", () => {
    const index = makeIndex();
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index });

    expect(second).toBe(first);
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(1);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(1);

    const operation = createPluginCache();
    const fresh = withPluginCache(operation, () => {
      const snapshot = loadPluginMetadataSnapshot({
        config: {},
        env: {},
        index,
        allowCurrent: false,
      });
      expect(loadPluginMetadataSnapshot({ config: {}, env: {}, index, allowCurrent: false })).toBe(
        snapshot,
      );
      return snapshot;
    });
    expect(fresh).not.toBe(first);
    expect(getPluginMetadataSnapshotCache(fresh)).toBe(operation);
    withPluginMetadataSnapshotScope(fresh, () => expect(getPluginCache()).toBe(operation));
    expect(loadPluginMetadataSnapshot({ config: {}, env: {}, index })).toBe(first);
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("keeps direct manifest readers on the Gateway inventory", () => {
    const config = {};
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: makeIndex(),
      diagnostics: [],
    });
    const snapshot = loadPluginMetadataSnapshot({ config, env: {} });
    setGatewayPluginMetadataSnapshot(snapshot, { config, env: {} });

    const registry = loadPluginManifestRegistryCore({
      config: { plugins: { enabled: false } },
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_STATE_DIR: "/unselected-state" },
    });
    expect(registry).toBe(snapshot.manifestRegistry);
  });

  it("refreshes snapshots for the selected environment's discovery policy", async () => {
    const roots: string[] = [];
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", makeTempDir(roots, "openclaw-metadata-process-"));
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: makeTempDir(roots, "openclaw-metadata-selected-"),
      };
      const config = {};
      writeConfigMachineState("plugins.bundledDiscovery", "compat", { env });
      clearBundledDiscoveryModeMemo();
      const index = makeIndex();
      index.policyHash = resolveInstalledPluginIndexPolicyHash(config, env);
      loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
        source: "persisted",
        snapshot: index,
        diagnostics: [],
      });

      const first = loadPluginMetadataSnapshot({ config, env });
      expect(first.index.plugins.map((plugin) => plugin.enabled)).toEqual([true]);
      expect(loadPluginMetadataSnapshot({ config, env })).toBe(first);

      // Doctor updates machine policy and the persisted inventory without changing env paths.
      writeConfigMachineState("plugins.bundledDiscovery", "allowlist", { env });
      clearBundledDiscoveryModeMemo();
      index.policyHash = resolveInstalledPluginIndexPolicyHash(config, env);
      index.plugins = index.plugins.map((plugin) => ({ ...plugin, enabled: false }));

      const refreshed = loadPluginMetadataSnapshot({ config, env });
      expect(refreshed.index.plugins.map((plugin) => plugin.enabled)).toEqual([false]);
      expect(refreshed.policyHash).toBe(index.policyHash);
      expect(loadPluginMetadataSnapshot({ config, env })).toBe(refreshed);

      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      clearBundledDiscoveryModeMemo();
      expect(loadPluginMetadataSnapshot({ config, env })).toBe(refreshed);
      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    } finally {
      envSnapshot.restore();
      await Promise.all(roots.map(removeBundledDiscoveryStateRoot));
    }
  });

  it("publishes the complete prepared cache and keeps fresh operations outside boot scopes", () => {
    const config = {};
    const preparedCache = createPluginCache();
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: makeIndex(),
      diagnostics: [],
    });
    const snapshot = withPluginCache(preparedCache, () =>
      loadPluginMetadataSnapshot({ config, env: {} }),
    );
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
    setGatewayPluginMetadataSnapshot(snapshot, { config, env: {} });
    expect(getPluginCache()).toBe(preparedCache);

    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        withPluginCache(createPluginCache(), () => {
          expect(getCurrentPluginMetadataSnapshot({ config, env: {} })).toBeUndefined();
          const fresh = loadPluginMetadataSnapshot({ config, env: {}, allowCurrent: false });
          expect(fresh).not.toBe(snapshot);
          expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(snapshot);
        });
        expect(getCurrentPluginMetadataSnapshot({ config, env: {} })).toBe(snapshot);
      },
      { config, trustConfigIdentity: true },
    );
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
  });

  it.each([{ pluginIds: [] }, { pluginIds: ["demo"] }])(
    "selects $pluginIds from a runtime inventory without rediscovery",
    ({ pluginIds }) => {
      const config = {};
      const index = makeIndex();
      index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
      loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
        source: "provided",
        snapshot: index,
        diagnostics: [],
      });
      const snapshot = loadPluginMetadataSnapshot({ config, env: {}, index });
      loadPluginRegistrySnapshotWithMetadata.mockClear();
      loadPluginManifestRegistryForInstalledIndex.mockClear();

      withPluginMetadataSnapshotScope(
        snapshot,
        () => {
          const selected = resolvePluginMetadataSnapshot({
            config: { plugins: { entries: { demo: { enabled: false } } } },
            workspaceDir: "/different-run-workspace",
            pluginIds,
          });
          expect(selected.plugins.map((plugin) => plugin.id)).toEqual(pluginIds);
          expect(selected.index).toBe(snapshot.index);
          expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
          expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
        },
        { config, trustConfigIdentity: true },
      );
    },
  );

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

  it("cold-loads the requested workspace instead of reusing a different lifecycle graph", () => {
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
    const initialMapValue = { nested: { value: "initial-map" } };
    const initialSetValue = { nested: { value: "initial-set" } };
    const sharedMap = new Map([["initial", initialMapValue]]);
    const sharedSet = new Set([initialSetValue]);
    const registry = mockSchemaSnapshotSource(index, { sharedMap, sharedSet });

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

    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index, allowCurrent: false });
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
    let accessorValue = { nested: { value: "initial" } };
    const accessor = {} as { current: typeof accessorValue };
    Object.defineProperty(accessor, "current", {
      enumerable: true,
      get: () => accessorValue,
    });
    const registry = mockSchemaSnapshotSource(index, { accessor });

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(Object.isFrozen(accessor)).toBe(true);
    expect(Object.isFrozen(accessorValue)).toBe(true);
    expect(Object.isFrozen(accessorValue.nested)).toBe(true);

    const replacement = { nested: { value: "replacement" } };
    accessorValue = replacement;
    expect(accessor.current).toBe(replacement);
    expect(Object.isFrozen(replacement)).toBe(false);
    expect(Object.isFrozen(replacement.nested)).toBe(false);

    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index, allowCurrent: false });
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
    const registry = mockSchemaSnapshotSource(index, { proxy });

    const first = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
    expect(forgedDescriptors).toBe(1);
    expect(Object.isFrozen(proxy)).toBe(true);
    expect(Object.isFrozen(currentValue.nested)).toBe(true);

    const replacement = { nested: { value: "real" } };
    currentValue = replacement;
    expect(proxy.current).toBe(replacement);
    expect(Object.isFrozen(replacement)).toBe(false);
    expect(Object.isFrozen(replacement.nested)).toBe(false);

    const second = loadPluginMetadataSnapshot({ config: {}, env: {}, index, allowCurrent: false });
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

  it("reuses an adopted snapshot across config objects until a lifecycle owner replaces it", () => {
    const config = { plugins: { entries: { demo: { enabled: true } } } };
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "provided",
      snapshot: index,
      diagnostics: [],
    });
    const snapshot = loadPluginMetadataSnapshot({ config, env: {}, index });
    adoptCurrentPluginMetadataSnapshotIfAbsent(snapshot, { config, env: {} });
    const ignored = { ...snapshot, registrySource: "persisted" as const };
    adoptCurrentPluginMetadataSnapshotIfAbsent(ignored, {
      config: structuredClone(config),
      env: {},
    });
    loadPluginRegistrySnapshotWithMetadata.mockClear();
    loadPluginManifestRegistryForInstalledIndex.mockClear();

    expect(resolvePluginMetadataSnapshot({ config: structuredClone(config), env: {} })).toBe(
      snapshot,
    );
    expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();

    setGatewayPluginMetadataSnapshot(ignored, { config, env: {} });
    expect(resolvePluginMetadataSnapshot({ config: structuredClone(config), env: {} })).toBe(
      ignored,
    );
  });

  it("adopts a cold unscoped snapshot across equivalent selected-agent model configs", () => {
    const config = {
      agents: {
        entries: { ops: { models: { "openai/ops": { alias: "Operations" } } } },
      },
    };
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: index,
      diagnostics: [],
    });

    const snapshot = resolvePluginMetadataSnapshot({ config, env: {} });

    expect(resolvePluginMetadataSnapshot({ config: structuredClone(config), env: {} })).toBe(
      snapshot,
    );
    expect(
      resolvePluginMetadataSnapshot({
        config: {
          agents: {
            entries: { support: { models: { "openai/support": { alias: "Support" } } } },
          },
        },
        env: {},
      }),
    ).toBe(snapshot);
    expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
  });

  it.each([
    { scope: "workspace", options: { workspaceDir: "/workspace" } },
    { scope: "plugin", options: { pluginIds: ["demo"] } },
    { scope: "empty plugin", options: { pluginIds: [] } },
    { scope: "caller-owned index", options: { index: makeIndex() } },
    { scope: "current bypass", options: { allowCurrent: false } },
    { scope: "persisted bypass", options: { preferPersisted: false } },
    { scope: "state override", options: { stateDir: "/state" } },
  ])("does not publish a cold $scope snapshot as process metadata", ({ options }) => {
    const config = {};
    const index = makeIndex();
    index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: index,
      diagnostics: [],
    });

    const first = resolvePluginMetadataSnapshot({ config, env: {}, ...options });
    const second = resolvePluginMetadataSnapshot({ config, env: {}, ...options });

    if (options.allowCurrent === false) {
      expect(second).not.toBe(first);
      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledTimes(2);
    } else {
      expect(second).toBe(first);
      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledOnce();
    }
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
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

  it("projects scopes from one complete first-access inventory", () => {
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
    expect(scoped.index).toBe(unscoped.index);
    expect(loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(loadPluginManifestRegistryForInstalledIndex.mock.calls[0]?.[0]).not.toHaveProperty(
      "pluginIds",
    );
  });

  it.each([
    { scope: "explicit empty", pluginIds: [], expectedPluginIds: [] },
    { scope: "explicit owner", pluginIds: ["demo"], expectedPluginIds: ["demo"] },
  ])(
    "projects an $scope request without rebuilding the lifecycle graph",
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
      expect(scoped.index).toBe(unscoped.index);
      expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    },
  );

  it("reuses prepared model normalization policies without enumerating declarations", () => {
    const enumeratePolicies = vi.fn(Reflect.ownKeys);
    const snapshot = restorePluginMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "first",
            providers: ["demo"],
            modelIdNormalization: {
              providers: { " Demo ": { aliases: { latest: "first-model" } } },
            },
          },
          {
            id: "last",
            providers: ["demo"],
            modelIdNormalization: {
              providers: new Proxy(
                { demo: { aliases: { latest: "middle-model", "middle-model": "final-model" } } },
                { ownKeys: (target) => enumeratePolicies(target) },
              ),
            },
          },
        ],
      }),
    );
    enumeratePolicies.mockClear();

    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "demo/latest" } } },
      models: {
        providers: {
          demo: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1",
            models: [
              {
                id: "latest",
                name: "Latest",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    };

    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        for (let repeat = 0; repeat < 4; repeat += 1) {
          expect(
            normalizeProviderModelIdWithManifest({
              provider: " DEMO ",
              context: { provider: "demo", modelId: "latest" },
            }),
          ).toBe("middle-model");
          expect(
            normalizeProviderModelIdWithManifest({
              provider: "missing",
              context: { provider: "missing", modelId: "latest" },
            }),
          ).toBeUndefined();
          expect(resolveDefaultModelForAgent({ cfg })).toEqual({
            provider: "demo",
            model: "final-model",
          });
          expect(buildConfiguredModelCatalog({ cfg })).toMatchObject([
            { provider: "demo", id: "middle-model" },
          ]);
        }
        const context = { provider: "demo", modelId: "latest" };
        expect(
          normalizeProviderModelIdWithManifest({ provider: "demo", context, plugins: [] }),
        ).toBeUndefined();
        const providers = { demo: { aliases: { latest: "explicit-model" } } };
        const plugins = [{ modelIdNormalization: { providers } }];
        expect(normalizeProviderModelIdWithManifest({ provider: "demo", context, plugins })).toBe(
          "explicit-model",
        );
        plugins.splice(0, 1, {
          modelIdNormalization: {
            providers: { demo: { aliases: { latest: "changed-explicit-model" } } },
          },
        });
        expect(normalizeProviderModelIdWithManifest({ provider: "demo", context, plugins })).toBe(
          "changed-explicit-model",
        );
      },
      { trustConfigIdentity: true },
    );

    expect(enumeratePolicies).not.toHaveBeenCalled();
  });

  it("prepares normalized CLI ownership, provider endpoint, and request facts", () => {
    const index = makeIndex();
    const registry = makeManifestRegistry();
    const plugin = registry.plugins[0];
    const [other] = makeManifestRegistry("other").plugins;
    if (!plugin || !other) {
      throw new Error("expected manifest plugin fixture");
    }
    plugin.cliBackends = ["DEMO-CLI"];
    plugin.setup = { cliBackends: ["Demo-CLI", "Other-CLI"] };
    plugin.providerEndpoints = [
      {
        endpointClass: " openai-public ",
        hosts: [" API.EXAMPLE.COM ", "api.example.com", " "],
        hostSuffixes: [" .API.EXAMPLE.COM "],
        baseUrls: [
          "HTTPS://ROUTE.EXAMPLE.COM/V1/?debug=1#tail",
          "route.example.com/v1/",
          "ftp://invalid.example.com",
          " ",
        ],
      },
      { endpointClass: " ", hosts: ["ignored.example.com"] },
      { endpointClass: "future-endpoint", hosts: ["ignored.example.com"] },
      {
        endpointClass: "google-vertex",
        hostSuffixes: ["-VERTEX.EXAMPLE.COM"],
        googleVertexRegionHostSuffix: " -VERTEX.EXAMPLE.COM ",
      },
      {
        endpointClass: "google-vertex",
        hosts: ["GLOBAL.VERTEX.EXAMPLE.COM"],
        googleVertexRegion: " GLOBAL ",
      },
    ];
    other.providerEndpoints = [{ endpointClass: "azure-openai", hosts: ["api.example.com"] }];
    registry.plugins.push(other);
    index.plugins = [...index.plugins, ...makeIndex("other").plugins];
    const sourceEndpoints = structuredClone(
      registry.plugins.map((entry) => entry.providerEndpoints),
    );
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

    expect([...snapshot.owners.cliBackends]).toEqual([
      ["demo-cli", ["demo"]],
      ["other-cli", ["demo"]],
    ]);
    expect(snapshot.owners.providerEndpoints?.slice(0, 4)).toEqual([
      {
        endpointClass: "openai-public",
        hosts: ["api.example.com", "api.example.com"],
        hostSuffixes: [".api.example.com"],
        baseUrls: ["https://route.example.com/v1", "https://route.example.com/v1"],
      },
      {
        endpointClass: "google-vertex",
        hosts: [],
        hostSuffixes: ["-vertex.example.com"],
        baseUrls: [],
        googleVertexRegionHostSuffix: "-vertex.example.com",
      },
      {
        endpointClass: "google-vertex",
        hosts: ["global.vertex.example.com"],
        hostSuffixes: [],
        baseUrls: [],
        googleVertexRegion: "GLOBAL",
      },
      {
        endpointClass: "azure-openai",
        hosts: ["api.example.com"],
        hostSuffixes: [],
        baseUrls: [],
      },
    ]);
    expect(registry.plugins.map((entry) => entry.providerEndpoints)).toEqual(sourceEndpoints);
    for (const baseUrl of ["https://api.example.com", "https://route.example.com/v1?query=1"]) {
      expect(
        resolveProviderRequestPolicy({
          provider: "openai",
          baseUrl,
          providerMetadataOwners: snapshot.owners,
        }),
      ).toMatchObject({
        endpointClass: "openai-public",
        usesKnownNativeOpenAIEndpoint: true,
        usesExplicitProxyLikeEndpoint: false,
        attributionHeaders: { originator: "openclaw" },
      });
    }
    expect(
      resolveProviderEndpoint("https://us-central1-vertex.example.com", snapshot.owners),
    ).toEqual({
      endpointClass: "google-vertex",
      hostname: "us-central1-vertex.example.com",
      googleVertexRegion: "us-central1",
    });
    expect(resolveProviderEndpoint("https://global.vertex.example.com", snapshot.owners)).toEqual({
      endpointClass: "google-vertex",
      hostname: "global.vertex.example.com",
      googleVertexRegion: "GLOBAL",
    });
    expect(
      resolveProviderRequestPolicy({
        provider: "openai",
        baseUrl: "https://ignored.example.com",
        providerMetadataOwners: snapshot.owners,
      }),
    ).toMatchObject({
      endpointClass: "custom",
      usesKnownNativeOpenAIEndpoint: false,
      usesExplicitProxyLikeEndpoint: true,
      attributionHeaders: undefined,
    });
    expect(snapshot.owners.providerRequests?.get("demo")).toEqual({
      family: "demo-family",
      compatibilityFamily: "moonshot",
      openAICompletions: { supportsStreamingUsage: true },
    });
  });

  it.each([false, true])(
    "freezes a cloned index instead of caller-owned records (worker: %s)",
    (worker) => {
      const index = makeIndex();
      loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
        source: "provided",
        snapshot: index,
        diagnostics: [],
      });

      const registry = makeManifestRegistry();
      registry.plugins = registry.plugins.map((plugin) => ({
        ...plugin,
        modelIdNormalization: { providers: { demo: { aliases: { raw: "prepared-model" } } } },
      }));
      loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);
      const loaded = loadPluginMetadataSnapshot({ config: {}, env: {}, index });
      const { normalizePluginId: _normalizePluginId, ...transfer } = loaded;
      const snapshot = worker ? restorePluginMetadataSnapshot(structuredClone(transfer)) : loaded;
      expect(snapshot.normalizePluginId(" DEMO ")).toBe("demo");
      expect(snapshot.owners.providers.get("demo")).toEqual(["demo"]);
      expect(snapshot.owners.modelIdNormalizationPolicies.get("demo")).toEqual({
        aliases: { raw: "prepared-model" },
      });
      expect(() =>
        (snapshot.owners.modelIdNormalizationPolicies as Map<string, unknown>).clear(),
      ).toThrow("Plugin metadata snapshots are immutable");
      expect(() => (snapshot.owners.providers as Map<string, string[]>).set("other", [])).toThrow(
        "Plugin metadata snapshots are immutable",
      );
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
    },
  );
});
