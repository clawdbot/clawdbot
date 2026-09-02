// Verifies provider runtime uses current plugin metadata snapshots.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  makePluginMetadataIndex as makeIndex,
  makePluginMetadataManifestRegistry,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

// Mock the persisted-registry loaders so direct metadata loads are observable.
// Provider hot paths should reuse a compatible current snapshot and only fall
// back to the loader when no compatible lifecycle-owned snapshot exists.
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

import { resolveExternalAuthProfilesWithPlugins } from "./provider-runtime.js";
import { isPluginProvidersLoadInFlight, resolvePluginProvidersCore } from "./providers.runtime.js";

const WORKSPACE = "/workspace/a";

function makeManifestRegistry(pluginId = "demo"): PluginManifestRegistry {
  const registry = makePluginMetadataManifestRegistry(pluginId);
  // Provider fixtures intentionally declare no command aliases.
  for (const plugin of registry.plugins) {
    plugin.commandAliases = [];
  }
  return registry;
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
    loadPluginRegistrySnapshotWithMetadata.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry());
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
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

  describe("resolvePluginProvidersCore", () => {
    it("keeps prepared provider discovery scoped to its exact generation and requested owners", () => {
      const config: OpenClawConfig = { plugins: { entries: { demo: { enabled: true } } } };
      const metadataSnapshot = registerCurrentSnapshot(config);
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.providers = ["demo", "unrelated"].map((pluginId) => ({
        pluginId,
        provider: { id: pluginId, label: "prepared", auth: [] },
        source: `/plugins/${pluginId}/index.js`,
      }));
      const activeRegistry = createEmptyPluginRegistry();
      activeRegistry.providers = [
        { ...pluginRegistry.providers[0]!, provider: { id: "demo", label: "active", auth: [] } },
      ];
      setActivePluginRegistry(activeRegistry, undefined, "default", WORKSPACE);
      const resolve = (onlyPluginIds = ["demo"]) =>
        resolvePluginProvidersCore({ config, env: {}, workspaceDir: WORKSPACE, onlyPluginIds });

      withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () => {
        expect(resolve()).toEqual([{ id: "demo", label: "prepared", auth: [], pluginId: "demo" }]);
        expect(resolve([])).toEqual([]);
        expect(withPluginRuntimeGenerationScope({ metadataSnapshot }, resolve)).toEqual([]);
      });
      expect(resolve()).toEqual([{ id: "demo", label: "active", auth: [], pluginId: "demo" }]);
    });

    it("reuses a compatible current snapshot without a direct disk load", () => {
      const config: OpenClawConfig = {};
      registerCurrentSnapshot(config);

      // onlyPluginIds:[] short-circuits provider materialization after the
      // snapshot is resolved, isolating the consult-first routing.
      const providers = resolvePluginProvidersCore({
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

      resolvePluginProvidersCore({
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
