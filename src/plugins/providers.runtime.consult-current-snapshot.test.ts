import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  clearLoadPluginMetadataSnapshotMemo,
  loadPluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

// Mock the persisted-registry loaders so direct metadata loads are observable.
// Provider hot paths should reuse a compatible current snapshot and only fall
// back to the loader when no compatible lifecycle-owned snapshot exists.
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

import { resolveExternalAuthProfilesWithPlugins } from "./provider-runtime.js";
import { isPluginProvidersLoadInFlight, resolvePluginProviders } from "./providers.runtime.js";

const WORKSPACE = "/workspace/a";

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
    commandAliases: [],
    rootDir: `/plugins/${pluginId}`,
    source: `/plugins/${pluginId}/index.js`,
    manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
    origin: "global",
  };
  return { plugins: [plugin], diagnostics: [] };
}

// Build a snapshot from a provided index (no disk) and register it as the
// process-current snapshot, then clear the loader spies so later assertions only
// see calls triggered by the function under test.
function registerCurrentSnapshot(config: OpenClawConfig, workspaceDir = WORKSPACE) {
  const index = makeIndex();
  index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
  loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source: "runtime",
    snapshot: index,
    diagnostics: [],
  });
  const snapshot = loadPluginMetadataSnapshot({ config, env: {}, index, workspaceDir });
  setCurrentPluginMetadataSnapshot(snapshot, { config, env: {}, workspaceDir });
  loadPluginRegistrySnapshotWithMetadata.mockClear();
  loadPluginManifestRegistryForInstalledIndex.mockClear();
  return snapshot;
}

// Arm the loaders so a fallback disk load resolves to a usable snapshot.
function armFallbackLoad() {
  loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source: "runtime",
    snapshot: makeIndex(),
    diagnostics: [],
  });
}

describe("provider runtime consults the current plugin metadata snapshot", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    clearLoadPluginMetadataSnapshotMemo();
    clearCurrentPluginMetadataSnapshot();
    loadPluginRegistrySnapshotWithMetadata.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry());
  });

  afterEach(() => {
    clearCurrentPluginMetadataSnapshot();
    clearPluginMetadataLifecycleCaches();
    clearLoadPluginMetadataSnapshotMemo();
    resetPluginRuntimeStateForTest();
  });

  describe("isPluginProvidersLoadInFlight", () => {
    it("reuses a compatible current snapshot without a direct disk load", () => {
      const config: OpenClawConfig = {};
      registerCurrentSnapshot(config);

      isPluginProvidersLoadInFlight({ config, env: {}, workspaceDir: WORKSPACE });

      expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
      expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    });

    it("falls back to a direct disk load when no current snapshot is registered", () => {
      armFallbackLoad();

      isPluginProvidersLoadInFlight({ config: {}, env: {}, workspaceDir: WORKSPACE });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });

    it("falls back to a direct disk load when the workspace does not match", () => {
      registerCurrentSnapshot({}, WORKSPACE);
      armFallbackLoad();

      // allowWorkspaceScopedCurrent is intentionally not used, so a different
      // workspace misses the current snapshot and reloads.
      isPluginProvidersLoadInFlight({ config: {}, env: {}, workspaceDir: "/workspace/b" });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });

    it("keeps setup/doctor behavior on the direct disk load when no snapshot exists", () => {
      // Fresh setup/doctor CLI processes never register a current snapshot, so
      // consult-first resolves to the same fallback disk load as before.
      armFallbackLoad();

      isPluginProvidersLoadInFlight({
        config: {},
        env: {},
        workspaceDir: WORKSPACE,
        mode: "setup",
      });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });
  });

  describe("resolvePluginProviders", () => {
    it("reuses a compatible current snapshot without a direct disk load", () => {
      const config: OpenClawConfig = {};
      registerCurrentSnapshot(config);

      // onlyPluginIds:[] short-circuits provider materialization after the
      // snapshot is resolved, isolating the consult-first routing.
      const providers = resolvePluginProviders({
        config,
        env: {},
        workspaceDir: WORKSPACE,
        mode: "runtime",
        onlyPluginIds: [],
      });

      expect(providers).toEqual([]);
      expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
      expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    });

    it("falls back to a direct disk load when no current snapshot is registered", () => {
      armFallbackLoad();

      resolvePluginProviders({
        config: {},
        env: {},
        workspaceDir: WORKSPACE,
        mode: "runtime",
        onlyPluginIds: [],
      });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });
  });

  describe("resolveExternalAuthProfilesWithPlugins", () => {
    it("reuses a compatible current snapshot without a direct disk load", () => {
      const config: OpenClawConfig = {};
      registerCurrentSnapshot(config);

      // The demo manifest declares no external-auth contracts, so resolution
      // short-circuits to [] right after the snapshot is consulted.
      const profiles = resolveExternalAuthProfilesWithPlugins({
        config,
        env: {},
        workspaceDir: WORKSPACE,
        context: { env: {}, store: { version: 1, profiles: {} } },
      });

      expect(profiles).toEqual([]);
      expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
    });

    it("falls back to a direct disk load when no current snapshot is registered", () => {
      armFallbackLoad();

      resolveExternalAuthProfilesWithPlugins({
        config: {},
        env: {},
        workspaceDir: WORKSPACE,
        context: { env: {}, store: { version: 1, profiles: {} } },
      });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });
  });
});
