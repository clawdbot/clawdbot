import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayPlugins } from "../gateway/server-plugins.js";
import { prepareGatewayPluginBootstrap } from "../gateway/server-startup-plugins.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "./capability-provider-runtime.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import * as discovery from "./discovery.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
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
import { resetPluginCache } from "./plugin-cache.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import {
  buildPluginRuntimeLoadOptions,
  getPluginRuntimeLoadContext,
} from "./runtime/load-context.js";

const id = "fixture-speech";
const log = { info() {}, warn() {}, error() {}, debug() {} };

vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({
  initSubagentRegistry() {},
}));

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
  const label = "${label}:" + ++registrations;
  api.registerSpeechProvider({ id: "${id}", label,
    isConfigured: () => false, synthesize: async () => { throw new Error("synthesis is not catalog discovery"); } });
  api.registerRealtimeTranscriptionProvider({ id: "${id}", label,
    isConfigured: () => false, createSession: () => { throw new Error("session creation is not catalog discovery"); } });
  api.registerRealtimeVoiceProvider({ id: "${id}", label,
    isConfigured: () => false, createBridge: () => { throw new Error("bridge creation is not catalog discovery"); } });
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
    JSON.stringify({
      id,
      configSchema: EMPTY_PLUGIN_SCHEMA,
      contracts: {
        speechProviders: [id],
        realtimeTranscriptionProviders: [id],
        realtimeVoiceProviders: [id],
      },
    }),
  );
  fs.writeFileSync(
    path.join(plugin.dir, "package.json"),
    JSON.stringify({ openclaw: { extensions: ["./index.ts"] } }),
  );
  const builtDir = path.join(root, "dist", "extensions", id);
  mkdirSafe(builtDir);
  fs.writeFileSync(path.join(builtDir, "index.js"), body("built"));
  // Artifact selection follows the entry format declared by emitted package metadata.
  fs.writeFileSync(
    path.join(builtDir, "package.json"),
    JSON.stringify({ openclaw: { extensions: ["./index.js"] } }),
  );
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

const voiceKeys = [
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
] as const;

function declareCapabilityCatalog(
  fixture: ReturnType<typeof createSpeechFixture>,
  keys: readonly (typeof voiceKeys)[number][] = voiceKeys,
) {
  const pluginDir = path.join(fixture.root, "extensions", id);
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.capabilityCatalogEntry = "./capability-catalog.ts";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const runtimeImported = path.join(fixture.root, "runtime-imported");
  for (const [dir, extension, label] of [
    [pluginDir, "ts", "source"],
    [path.join(fixture.root, "dist", "extensions", id), "js", "built"],
  ] as const) {
    const entry = path.join(dir, `index.${extension}`);
    fs.writeFileSync(entry, `import "./runtime-only.cjs";\n${fs.readFileSync(entry, "utf8")}`);
    fs.writeFileSync(
      path.join(dir, "runtime-only.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(runtimeImported)}, "loaded");`,
    );
    fs.writeFileSync(
      path.join(dir, `capability-catalog.${extension}`),
      `const provider = {
  id: "${id}", label: "${label}:catalog", aliases: ["fixture-alias"],
  resolveConfig: ({ rawConfig }) => rawConfig,
  isConfigured: ({ providerConfig }) => providerConfig.ready === true,
  synthesize: async () => { throw new Error("not synthesis"); },
  createSession: () => { throw new Error("not a session"); },
  createBridge: () => { throw new Error("not a bridge"); }
};
Object.defineProperty(provider, Symbol.for("fixture.internal"), { value: { ready: () => true } });
export default Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, [provider, { ...provider, id: "fixture-secondary", aliases: [] }]]));`,
    );
  }
  return { pluginDir, runtimeImported };
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
afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
  vi.doUnmock("../agents/subagents/registry/subagent-registry.js");
  vi.resetModules();
});

describe("capability loading from a Gateway generation", () => {
  it.each(voiceKeys)(
    "loads a declared cold %s catalog without evaluating the full entry",
    (key) => {
      withSpeechFixture((fixture) => {
        fixture.config.plugins = { enabled: true };
        const { pluginDir, runtimeImported } = declareCapabilityCatalog(fixture);
        fs.rmSync(path.join(fixture.root, "dist"), { recursive: true, force: true });
        fs.appendFileSync(
          path.join(pluginDir, "runtime-only.cjs"),
          '\nthrow new Error("catalog imported forbidden full runtime");',
        );
        publishMetadata(fixture);
        const registry = loadGatewayGeneration(fixture);
        withPluginRuntimeRegistryScope(registry, () => {
          const providers = resolvePluginCapabilityProviders({ key, cfg: fixture.config });
          expect(fs.existsSync(runtimeImported)).toBe(false);
          expect(providers.map((provider) => provider.id)).toEqual([id, "fixture-secondary"]);
          const provider = resolvePluginCapabilityProvider({
            key,
            cfg: fixture.config,
            providerId: "fixture-alias",
          });
          expect(provider).toBe(providers[0]);
          expect(resolvePluginCapabilityProviders({ key, cfg: fixture.config })[0]).toBe(provider);
          expect(provider?.label).toBe("source:catalog");
          const providerContext = { cfg: fixture.config, timeoutMs: 1000 };
          expect(
            provider?.resolveConfig?.({ ...providerContext, rawConfig: { ready: true } }),
          ).toEqual({
            ready: true,
          });
          expect(
            provider?.isConfigured({ ...providerContext, providerConfig: { ready: true } }),
          ).toBe(true);
          expect(Reflect.get(provider!, Symbol.for("fixture.internal")).ready()).toBe(true);
        });
      });
    },
  );

  it.each(voiceKeys)("uses register() for an uncovered %s family", (key) => {
    withSpeechFixture((fixture) => {
      fixture.config.plugins = { enabled: true };
      const { runtimeImported } = declareCapabilityCatalog(
        fixture,
        voiceKeys.filter((family) => family !== key),
      );
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture);
      withPluginRuntimeRegistryScope(registry, () => {
        expect(
          resolvePluginCapabilityProviders({ key, cfg: fixture.config }).map(
            (provider) => provider.label,
          ),
        ).toEqual(["built:1"]);
        expect(fs.readFileSync(runtimeImported, "utf8")).toBe("loaded");
      });
    });
  });

  it("uses the declared built catalog with global-disabled speech compatibility", () => {
    withSpeechFixture((fixture) => {
      const { runtimeImported } = declareCapabilityCatalog(fixture);
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture);
      withPluginRuntimeRegistryScope(registry, () => {
        expect(speechProviders(fixture.config).map((provider) => provider.label)).toEqual([
          "built:catalog",
          "built:catalog",
        ]);
        expect(
          resolvePluginCapabilityProviders({ key: "realtimeVoiceProviders", cfg: fixture.config }),
        ).toEqual([]);
        expect(fs.existsSync(runtimeImported)).toBe(false);
      });
    });
  });

  it("keeps active runtime descriptors authoritative over a declared catalog", () => {
    withSpeechFixture((fixture) => {
      fixture.config.plugins = { enabled: true, entries: { [id]: { enabled: true } } };
      declareCapabilityCatalog(fixture);
      fs.writeFileSync(
        path.join(fixture.root, "dist", "extensions", id, "capability-catalog.js"),
        'throw new Error("active runtime must retain its bound descriptors");',
      );
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture, fixture.workspaceDir, [id]);
      withPluginRuntimeRegistryScope(registry, () => {
        for (const key of voiceKeys) {
          const provider = registry[key][0]!.provider;
          expect(resolvePluginCapabilityProviders({ key, cfg: fixture.config })).toEqual([
            provider,
          ]);
          expect(
            resolvePluginCapabilityProvider({ key, cfg: fixture.config, providerId: id }),
          ).toBe(provider);
        }
      });
    });
  });

  it("selects an installed override's catalog inside its own physical root", () => {
    withSpeechFixture((fixture) => {
      fixture.config.plugins = { enabled: true, allow: [id] };
      const { pluginDir, runtimeImported } = declareCapabilityCatalog(fixture);
      const installedDir = path.join(fixture.root, "installed", id);
      fs.cpSync(pluginDir, installedDir, { recursive: true });
      const catalogPath = path.join(installedDir, "capability-catalog.ts");
      fs.writeFileSync(
        catalogPath,
        fs.readFileSync(catalogPath, "utf8").replace("source:catalog", "installed:catalog"),
      );
      const installed = {
        [id]: { source: "path" as const, installPath: installedDir, sourcePath: installedDir },
      };
      const discovered = discovery.discoverOpenClawPlugins({ installRecords: installed });
      const snapshot = createPluginMetadataSnapshot({
        config: fixture.config,
        workspaceDir: fixture.workspaceDir,
        manifestRegistry: manifests.loadPluginManifestRegistryCore({
          config: fixture.config,
          installRecords: installed,
          discovery: discovered,
        }),
      });
      snapshot.index.installRecords = installed;
      snapshot.index.plugins = buildInstalledPluginIndexRecords({
        config: fixture.config,
        registry: snapshot.manifestRegistry,
        candidates: discovered.candidates,
        installRecords: installed,
        diagnostics: [],
      });
      expect(snapshot.byPluginId.get(id)?.rootDir).toBe(installedDir);
      setCurrentPluginMetadataSnapshot(snapshot, {
        config: fixture.config,
        workspaceDir: fixture.workspaceDir,
      });
      const registry = loadGatewayGeneration(fixture);
      withPluginRuntimeRegistryScope(registry, () => {
        for (const key of voiceKeys) {
          expect(
            resolvePluginCapabilityProvider({
              key,
              cfg: fixture.config,
              providerId: "fixture-alias",
            })?.label,
          ).toBe("installed:catalog");
        }
      });
      expect(fs.existsSync(runtimeImported)).toBe(false);
    });
  });

  it("retains catalog factories within a cache generation and replaces them on source reload", () => {
    withSpeechFixture((fixture) => {
      fixture.config.plugins = { enabled: true };
      const { pluginDir, runtimeImported } = declareCapabilityCatalog(fixture);
      fs.rmSync(path.join(fixture.root, "dist"), { recursive: true, force: true });
      const catalogPath = path.join(pluginDir, "capability-catalog.ts");
      const body = `export default () => {\n${fs
        .readFileSync(catalogPath, "utf8")
        .replace("export default Object.fromEntries", "return Object.fromEntries")}\n};`;
      fs.writeFileSync(catalogPath, body);
      publishMetadata(fixture);
      const previous = loadGatewayGeneration(fixture);
      const first = withPluginRuntimeRegistryScope(
        previous,
        () => speechProviders(fixture.config)[0],
      );
      fs.writeFileSync(catalogPath, body.replace("source:catalog", "replacement:catalog"));
      withPluginRuntimeRegistryScope(previous, () => {
        expect(speechProviders(fixture.config)[0]).toBe(first);
        expect(
          resolvePluginCapabilityProviders({
            key: "realtimeVoiceProviders",
            cfg: fixture.config,
          })[0],
        ).toBe(first);
      });
      resetPluginCache();
      publishMetadata(fixture);
      const current = loadGatewayGeneration(fixture);
      withPluginRuntimeRegistryScope(current, () => {
        const replacement = speechProviders(fixture.config)[0];
        expect(replacement).not.toBe(first);
        expect(replacement?.label).toBe("replacement:catalog");
      });
      expect(fs.existsSync(runtimeImported)).toBe(false);
    });
  });

  it.each(["export default", "module.exports ="])(
    "treats an explicitly empty family as authoritative (%s)",
    (declaration) => {
      withSpeechFixture((fixture) => {
        const { runtimeImported } = declareCapabilityCatalog(fixture);
        fs.writeFileSync(
          path.join(fixture.root, "dist", "extensions", id, "capability-catalog.js"),
          `${declaration} { speechProviders: [] };`,
        );
        publishMetadata(fixture);
        const registry = loadGatewayGeneration(fixture);
        withPluginRuntimeRegistryScope(registry, () => {
          expect(speechProviders(fixture.config)).toEqual([]);
          expect(
            resolvePluginCapabilityProvider({
              key: "speechProviders",
              providerId: "fixture-alias",
              cfg: fixture.config,
            }),
          ).toBeUndefined();
          expect(fs.existsSync(runtimeImported)).toBe(false);
        });
      });
    },
  );

  it.each([
    'throw new Error("broken catalog");',
    "export default { speechProviders: [{}] };",
    "export default { speechProvider: [] };",
    "export default async () => ({ speechProviders: [] });",
  ])("reports a broken declaration without importing the full entry: %s", (body) => {
    withSpeechFixture((fixture) => {
      const { runtimeImported } = declareCapabilityCatalog(fixture);
      fs.writeFileSync(
        path.join(fixture.root, "dist", "extensions", id, "capability-catalog.js"),
        body,
      );
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture);
      withPluginRuntimeRegistryScope(registry, () => {
        expect(() => speechProviders(fixture.config)).toThrow(
          /capabilityCatalogEntry failed.*Repair the declared entry/,
        );
        expect(fs.existsSync(runtimeImported)).toBe(false);
      });
    });
  });

  it.each(["../outside.ts", "", 7])("rejects an invalid catalog entry declaration: %j", (entry) => {
    withSpeechFixture((fixture) => {
      const { pluginDir, runtimeImported } = declareCapabilityCatalog(fixture);
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.capabilityCatalogEntry = entry;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture);
      withPluginRuntimeRegistryScope(registry, () => {
        expect(() => speechProviders(fixture.config)).toThrow(/capabilityCatalogEntry failed/);
        expect(fs.existsSync(runtimeImported)).toBe(false);
      });
    });
  });

  it.each(["speechProviders", "realtimeTranscriptionProviders", "realtimeVoiceProviders"] as const)(
    "keeps cold catalog discovery on prepared artifacts for %s",
    async (key) => {
      const fixture = createSpeechFixture();
      fixture.config.plugins = { enabled: key !== "speechProviders" };
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixture.root, "extensions"),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        },
        async () => {
          const snapshot = publishMetadata(fixture);
          const bootstrap = await prepareGatewayPluginBootstrap({
            cfgAtStart: fixture.config,
            pluginMetadataSnapshot: snapshot,
            minimalTestGateway: true,
            log,
          });
          setCurrentPluginMetadataSnapshot(bootstrap.pluginMetadataSnapshot, {
            config: fixture.config,
            workspaceDir: fixture.workspaceDir,
          });
          const discover = vi.spyOn(discovery, "discoverOpenClawPlugins");
          const readManifests = vi.spyOn(manifests, "loadPluginManifestRegistryCore");
          withPluginRuntimeRegistryScope(bootstrap.pluginRegistry, () => {
            const providers = resolvePluginCapabilityProviders({ key, cfg: fixture.config });
            expect(providers.map((provider) => provider.label)).toEqual(["built:1"]);
            expect(
              resolvePluginCapabilityProvider({ key, providerId: id, cfg: fixture.config }),
            ).toBe(providers[0]);
          });
          expect(discover).not.toHaveBeenCalled();
          expect(readManifests).not.toHaveBeenCalled();
          expect(bootstrap.pluginRegistry.plugins).toEqual([]);
        },
      );
    },
  );

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
      declareCapabilityCatalog(fixture);
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture);
      const other = loadOpenClawPlugins({
        config: { ...fixture.config, plugins: { entries: { [id]: { enabled: true } } } },
        onlyPluginIds: [id],
      });
      expect(other.speechProviders[0]?.provider.label).toBe("source:1");
      withPluginRuntimeRegistryScope(registry, () => {
        expect(speechProviders(fixture.config).map((provider) => provider.label)).toEqual([
          "built:catalog",
          "built:catalog",
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
      declareCapabilityCatalog(fixture);
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture, path.join(fixture.root, "other-workspace"));
      withPluginRuntimeRegistryScope(registry, () => {
        expect(speechProviders(fixture.config).map((provider) => provider.label)).toEqual([
          "source:catalog",
          "source:catalog",
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

  it.each(
    voiceKeys.flatMap((key) =>
      [{ deny: [id] }, { entries: { [id]: { enabled: false } } }].map((policy) => ({
        key,
        policy,
      })),
    ),
  )("preserves explicit $key owner denial: $policy", ({ key, policy }) => {
    withSpeechFixture((fixture) => {
      fixture.config.plugins = { enabled: key !== "speechProviders", ...policy };
      const { runtimeImported } = declareCapabilityCatalog(fixture);
      publishMetadata(fixture);
      const registry = loadGatewayGeneration(fixture);
      withPluginRuntimeRegistryScope(registry, () => {
        expect(resolvePluginCapabilityProviders({ key, cfg: fixture.config })).toEqual([]);
        expect(fs.existsSync(runtimeImported)).toBe(false);
      });
    });
  });
});
