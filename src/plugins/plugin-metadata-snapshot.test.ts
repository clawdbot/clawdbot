// Verifies lifecycle snapshot loading, ownership facts, and immutable boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import {
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";

const loadPluginRegistrySnapshotWithMetadata = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForInstalledIndex = vi.hoisted(() => vi.fn());

vi.mock("./plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry.js")>();
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
          deferConfiguredChannelFullLoadUntilAfterListen: false,
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
    clearCurrentPluginMetadataSnapshot();
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
