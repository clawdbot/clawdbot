import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayPlugins } from "../gateway/server-plugins.js";
import { withEnv } from "../test-utils/env.js";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "./capability-provider-runtime.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import * as discovery from "./discovery.js";
import * as installRecords from "./installed-plugin-index-record-reader.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import * as manifests from "./manifest-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import {
  buildPluginRuntimeLoadOptions,
  getPluginRuntimeLoadContext,
} from "./runtime/load-context.js";

const id = "fixture-speech";
const log = { info() {}, warn() {}, error() {}, debug() {} };

function withSpeechFixture(run: (fixture: ReturnType<typeof createSpeechFixture>) => void) {
  const fixture = createSpeechFixture();
  return withEnv(
    {
      OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixture.root, "extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
    () => run(fixture),
  );
}

function createSpeechFixture() {
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const workspaceDir = path.join(root, "workspace");
  mkdirSafe(workspaceDir);
  const body = (label: string) => `let registrations = 0;
export default { id: "${id}", register(api) {
  api.registerSpeechProvider({ id: "${id}", label: "${label}:" + ++registrations,
    isConfigured: () => false, synthesize: async () => { throw new Error("synthesis is not catalog discovery"); } });
} };`;
  const plugin = writePlugin({
    id,
    dir: path.join(root, "extensions", id),
    filename: "index.ts",
    body: body("source"),
  });
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ id, configSchema: EMPTY_PLUGIN_SCHEMA, contracts: { speechProviders: [id] } }),
  );
  fs.writeFileSync(
    path.join(plugin.dir, "package.json"),
    JSON.stringify({ openclaw: { extensions: ["./index.ts"] } }),
  );
  const builtDir = path.join(root, "dist", "extensions", id);
  mkdirSafe(builtDir);
  fs.writeFileSync(path.join(builtDir, "index.js"), body("built"));
  const seed = writePlugin({
    id: "fixture-seed",
    dir: path.join(root, "extensions", "fixture-seed"),
    filename: "index.cjs",
    body: 'module.exports = { id: "fixture-seed", register() {} };',
  });
  fs.writeFileSync(
    path.join(seed.dir, "package.json"),
    JSON.stringify({ openclaw: { extensions: ["./index.cjs"] } }),
  );
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: { enabled: false },
  };
  return { root, workspaceDir, config };
}

function publishMetadata(fixture: ReturnType<typeof createSpeechFixture>) {
  const snapshot = createPluginMetadataSnapshot({
    config: fixture.config,
    workspaceDir: fixture.workspaceDir,
    manifestRegistry: manifests.loadPluginManifestRegistryCore({ config: fixture.config }),
  });
  setCurrentPluginMetadataSnapshot(snapshot, {
    config: fixture.config,
    workspaceDir: fixture.workspaceDir,
  });
  return snapshot;
}

function loadGatewayGeneration(
  fixture: ReturnType<typeof createSpeechFixture>,
  workspaceDir = fixture.workspaceDir,
  pluginIds: string[] = [],
  pluginMetadataSnapshot?: ReturnType<typeof publishMetadata>,
) {
  return loadGatewayPlugins({
    cfg: fixture.config,
    activationSourceConfig: fixture.config,
    autoEnabledReasons: {},
    workspaceDir,
    pluginIds,
    pluginMetadataSnapshot,
    baseMethods: [],
    log,
  }).pluginRegistry;
}

const speechProviders = (cfg: OpenClawConfig) =>
  resolvePluginCapabilityProviders({ key: "speechProviders", cfg });

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("capability loading from a Gateway generation", () => {
  it("uses built speech on the first disabled-plugin catalog read without rediscovery or re-registration", () => {
    withSpeechFixture((fixture) => {
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture);
      const discover = vi.spyOn(discovery, "discoverOpenClawPlugins");
      const readManifests = vi.spyOn(manifests, "loadPluginManifestRegistryCore");
      const readInstalls = vi.spyOn(installRecords, "loadInstalledPluginIndexInstallRecordsSync");
      withPluginRuntimeRegistryScope(registry, () => {
        const first = speechProviders(fixture.config);
        expect(first.map((provider) => provider.label)).toEqual(["built:1"]);
        expect(speechProviders(fixture.config)).toEqual(first);
        expect(
          resolvePluginCapabilityProvider({
            key: "speechProviders",
            providerId: id,
            cfg: fixture.config,
          }),
        ).toBe(first[0]);
      });
      expect(discover).not.toHaveBeenCalled();
      expect(readManifests).not.toHaveBeenCalled();
      expect(readInstalls).not.toHaveBeenCalled();
      expect(getActivePluginRegistry()).toBe(registry);
      expect(registry.speechProviders).toEqual([]);
    });
  });

  it("extends a populated Gateway registry without loading missing speech from source", () => {
    withSpeechFixture((fixture) => {
      fixture.config.plugins = { enabled: true, entries: { "fixture-seed": { enabled: true } } };
      const snapshot = publishMetadata(fixture);
      const startupSnapshot = createPluginMetadataSnapshot({
        config: fixture.config,
        workspaceDir: fixture.workspaceDir,
        manifestRegistry: {
          plugins: snapshot.plugins.filter((plugin) => plugin.id === "fixture-seed"),
          diagnostics: [],
        },
      });
      const registry = loadGatewayPlugins({
        cfg: fixture.config,
        activationSourceConfig: fixture.config,
        autoEnabledReasons: {},
        workspaceDir: fixture.workspaceDir,
        baseMethods: [],
        log,
        pluginLookUpTable: {
          ...startupSnapshot,
          pluginIds: ["fixture-seed"],
          startup: { pluginIds: ["fixture-seed"], channelPluginIds: [] },
          workerProviderIds: [],
          metrics: { ...startupSnapshot.metrics, startupPlanMs: 0, startupPluginCount: 1 },
        },
      }).pluginRegistry;
      expect(getPluginRuntimeLoadContext(registry)?.metadataSnapshot).toBe(snapshot);
      expect(registry.plugins).toContainEqual(
        expect.objectContaining({ id: "fixture-seed", status: "loaded" }),
      );
      withPluginRuntimeRegistryScope(registry, () => {
        expect(speechProviders(fixture.config).map((provider) => provider.label)).toEqual([
          "built:1",
        ]);
      });
    });
  });

  it("keeps the request's load context when an unrelated active registry already contains speech", () => {
    withSpeechFixture((fixture) => {
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture);
      const other = loadOpenClawPlugins({
        config: { ...fixture.config, plugins: { entries: { [id]: { enabled: true } } } },
        onlyPluginIds: [id],
      });
      expect(other.speechProviders[0]?.provider.label).toBe("source:1");
      withPluginRuntimeRegistryScope(registry, () => {
        expect(speechProviders(fixture.config).map((provider) => provider.label)).toEqual([
          "built:1",
        ]);
      });
      expect(getActivePluginRegistry()).toBe(other);
    });
  });

  it("carries the same metadata and artifact facts through bundled capability capture", () => {
    withSpeechFixture((fixture) => {
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture);
      const context = getPluginRuntimeLoadContext(registry);
      expect(context).toBeDefined();
      const discover = vi.spyOn(discovery, "discoverOpenClawPlugins");
      const readManifests = vi.spyOn(manifests, "loadPluginManifestRegistryCore");
      const readInstalls = vi.spyOn(installRecords, "loadInstalledPluginIndexInstallRecordsSync");
      const captured = loadBundledCapabilityRuntimeRegistry({
        ...buildPluginRuntimeLoadOptions(context!, {
          config: withBundledPluginEnablementCompat({ config: fixture.config, pluginIds: [id] }),
        }),
        pluginIds: [id],
      });
      expect(captured.speechProviders.map((entry) => entry.provider.label)).toEqual(["built:1"]);
      expect(discover).not.toHaveBeenCalled();
      expect(readManifests).not.toHaveBeenCalled();
      expect(readInstalls).not.toHaveBeenCalled();
      expect(getActivePluginRegistry()).toBe(registry);
    });
  });

  it("keeps standalone source loading even when a complete metadata snapshot exists", () => {
    withSpeechFixture((fixture) => {
      publishMetadata(fixture);
      setActivePluginRegistry(createEmptyPluginRegistry());
      expect(speechProviders(fixture.config).map((provider) => provider.label)).toEqual([
        "source:1",
      ]);
    });
  });

  it("does not borrow artifact preference from a Gateway with a different workspace", () => {
    withSpeechFixture((fixture) => {
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture, path.join(fixture.root, "other-workspace"));
      withPluginRuntimeRegistryScope(registry, () => {
        expect(speechProviders(fixture.config).map((provider) => provider.label)).toEqual([
          "source:1",
        ]);
      });
    });
  });

  it("does not borrow a replaced generation through a retained request registry", () => {
    withSpeechFixture((fixture) => {
      publishMetadata(fixture);
      const previous = loadGatewayGeneration(fixture);
      const nextSnapshot = createPluginMetadataSnapshot({
        config: fixture.config,
        workspaceDir: fixture.workspaceDir,
        manifestRegistry: manifests.loadPluginManifestRegistryCore({ config: fixture.config }),
      });
      // Reload prepares the replacement before publishing its metadata generation.
      const current = loadGatewayGeneration(fixture, fixture.workspaceDir, [], nextSnapshot);
      setCurrentPluginMetadataSnapshot(nextSnapshot, {
        config: fixture.config,
        workspaceDir: fixture.workspaceDir,
      });
      withPluginRuntimeRegistryScope(previous, () => {
        expect(speechProviders(fixture.config).map((provider) => provider.label)).toEqual([
          "source:1",
        ]);
      });
      withPluginRuntimeRegistryScope(current, () => {
        expect(speechProviders(fixture.config).map((provider) => provider.label)).toEqual([
          "built:1",
        ]);
      });
    });
  });

  it.each([{ deny: [id] }, { entries: { [id]: { enabled: false } } }])(
    "preserves explicit speech owner denial: %j",
    (policy) => {
      withSpeechFixture((fixture) => {
        fixture.config.plugins = { enabled: false, ...policy };
        publishMetadata(fixture);
        const registry = loadGatewayGeneration(fixture);
        withPluginRuntimeRegistryScope(registry, () => {
          expect(speechProviders(fixture.config)).toEqual([]);
        });
      });
    },
  );
});
