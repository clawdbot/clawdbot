import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { withEnv } from "../test-utils/env.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import { createPluginCandidatesFromManifestRegistry } from "./loader-shared.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  EMPTY_PLUGIN_SCHEMA,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  writePlugin,
} from "./loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  resolveLoadedProviderPluginsForHooks,
  resolveLoadedProviderRuntimePlugin,
  resolveProviderPluginsForHooks,
  resolveProviderRuntimePlugin,
  resolveProviderRuntimePluginHandle,
} from "./provider-hook-runtime.js";
import { resolvePluginProvidersCore } from "./providers.runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "./runtime/load-context.js";

const config = { plugins: { allow: ["same-id"], entries: { "same-id": { enabled: true } } } };

function metadata(
  rootDir: string,
  source = `${rootDir}/index.cjs`,
  origin: "global" | "bundled" = "global",
) {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "same-id",
        origin,
        rootDir,
        source,
        providers: ["same-provider"],
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
    ],
  });
}

function registry(snapshot: ReturnType<typeof metadata>, workspaceDir?: string) {
  return loadOpenClawPlugins({
    config,
    env: {},
    workspaceDir,
    installRecords: {},
    onlyPluginIds: ["same-id"],
    manifestRegistry: snapshot.manifestRegistry,
    activate: false,
  });
}

function loadFixture(label: string, dir?: string, hookAliases?: readonly string[]) {
  const plugin = writePlugin({
    id: "same-id",
    dir,
    filename: `${label}.cjs`,
    body: `let registrations = 0;
    module.exports = { id: "same-id", register(api) {
      const registration = ++registrations;
      api.registerProvider({ id: "same-provider", label: ${JSON.stringify(label)}, auth: [],
        ${hookAliases ? `hookAliases: ${JSON.stringify(hookAliases)},` : ""}
        normalizeModelId: () => String(registration) });
    }};`,
  });
  writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "same-id",
      providers: ["same-provider"],
      configSchema: EMPTY_PLUGIN_SCHEMA,
    }),
  );
  return metadata(plugin.dir, plugin.file);
}

afterEach(clearPluginLoaderCache);
afterAll(cleanupPluginLoaderFixturesForTest);

describe("provider runtime physical ownership", () => {
  it.each([undefined, "exact"] as const)(
    "projects a cold explicitly scoped runtime alias with registryScope=%s",
    (registryScope) => {
      const snapshot = loadFixture("cold-alias", undefined, ["runtime-alias"]);
      setActivePluginRegistry(createEmptyPluginRegistry());
      const requested = {
        config,
        env: {},
        pluginMetadataSnapshot: snapshot,
        onlyPluginIds: ["same-id"],
        providerRefs: ["runtime-alias"],
        registryScope,
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const providers = resolvePluginProvidersCore(requested);
        expect(providers.map((provider) => provider.label)).toEqual(["cold-alias"]);
        expect(
          providers[0]?.normalizeModelId?.({ provider: "runtime-alias", modelId: "probe" }),
        ).toBe("1");
      }
    },
  );

  it.each([false, true])(
    "preserves paired source defaults during config reuse with snapshot=%s",
    (snapshotPresent) => {
      const plugin = writePlugin({
        id: "same-id",
        filename: "index.cjs",
        body: `let registrations = 0;
        module.exports = { id: "same-id", register(api) {
          if (api.pluginConfig.credential !== "resolved-fixture-key") throw new Error("unhydrated fixture");
          api.registerProvider({ id: "same-provider", label: api.pluginConfig.revision + "/" + (++registrations), auth: [] });
        }};`,
      });
      writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "same-id",
          providers: ["same-provider"],
          configContracts: {
            secretInputs: { paths: [{ path: "credential", expected: "string" }] },
          },
          configSchema: {
            type: "object",
            properties: {
              credential: {
                type: "object",
                properties: {
                  source: { const: "store" },
                  provider: { type: "string" },
                  id: { type: "string" },
                },
                required: ["source", "provider", "id"],
              },
              revision: { type: "string" },
            },
            required: ["credential"],
            if: { properties: { credential: { properties: { id: { const: "KEY" } } } } },
            // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data.
            then: { properties: { revision: { default: "A" } } },
            else: { properties: { revision: { default: "B" } } },
            additionalProperties: false,
          },
        }),
      );
      const runtimeConfig = {
        plugins: {
          allow: ["same-id"],
          load: { paths: [plugin.file] },
          entries: { "same-id": { enabled: true, config: { credential: "resolved-fixture-key" } } },
        },
      };
      const sourceFor = (id: string) => ({
        ...runtimeConfig,
        plugins: {
          ...runtimeConfig.plugins,
          entries: {
            "same-id": {
              enabled: true,
              config: { credential: { source: "store", provider: "default", id } },
            },
          },
        },
      });
      const sourceConfig = sourceFor("KEY");
      const env = { OPENCLAW_STATE_DIR: makePluginLoaderTempDir() };
      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        const firstSnapshot = loadPluginMetadataSnapshot({ config: runtimeConfig, env });
        const loadOptions = {
          config: runtimeConfig,
          activationSourceConfig: sourceConfig,
          env,
          installRecords: {},
          manifestRegistry: firstSnapshot.manifestRegistry,
          onlyPluginIds: ["same-id"],
          activate: false,
        };
        const loadedRegistry = loadOpenClawPlugins(loadOptions);
        setActivePluginRegistry(
          loadedRegistry,
          resolvePluginLoadCacheContext(loadOptions).cacheKey,
        );
        const lookup = {
          provider: "same-provider",
          config: runtimeConfig,
          env,
          ...(snapshotPresent ? { pluginMetadataSnapshot: firstSnapshot } : {}),
        };
        expect(resolveLoadedProviderRuntimePlugin(lookup)?.label).toBe("A/1");
        expect(resolveProviderRuntimePlugin(lookup)?.label).toBe("A/1");
        setRuntimeConfigSnapshot(runtimeConfig, sourceFor("OTHER"));
        expect(resolveLoadedProviderRuntimePlugin(lookup)).toBeUndefined();
        expect(resolveProviderRuntimePlugin(lookup)?.label).toBe("B/2");
        expect(
          withPluginRuntimeGenerationScope(
            { pluginRegistry: loadedRegistry, metadataSnapshot: firstSnapshot },
            () => resolveProviderRuntimePlugin(lookup)?.label,
          ),
        ).toBe("A/1");
        const setupProviders = resolvePluginProvidersCore({
          ...lookup,
          providerRefs: ["same-provider"],
          mode: "setup",
        });
        expect(setupProviders).toHaveLength(1);
        expect(setupProviders[0]?.label).toMatch(/^B\//);
        expect(resolveProviderRuntimePlugin(lookup)?.label).toBe("B/2");
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );

  it.each(
    (
      [
        { change: "replace", receiver: "declared" },
        { change: "mutate", receiver: "declared" },
        { change: "rebind", receiver: "declared" },
        { change: "replace", receiver: "alias" },
        { change: "replace", receiver: "removed-alias" },
      ] as const
    ).flatMap((variant) =>
      [false, true].map((snapshotPresent) => ({
        change: variant.change,
        receiver: variant.receiver,
        snapshotPresent,
      })),
    ),
  )(
    "keeps registration config current with snapshot=$snapshotPresent, change=$change, receiver=$receiver",
    ({ snapshotPresent, change, receiver }) => {
      const registrationMarker = path.join(makePluginLoaderTempDir(), "registered");
      const plugin = writePlugin({
        id: "same-id",
        filename: "index.cjs",
        body: `let registrations = 0;
        module.exports = { id: "same-id", register(api) {
          const captured = api.pluginConfig.revision + "/" + (++registrations);
          require("node:fs").writeFileSync(${JSON.stringify(registrationMarker)}, captured);
          api.registerProvider({ id: "same-provider", label: captured, auth: [],
            hookAliases: ${receiver === "removed-alias" ? 'api.pluginConfig.revision === "A" ? ["runtime-alias"] : ["new-alias"]' : '["runtime-alias"]'},
            normalizeModelId: () => captured });
        }};`,
      });
      writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "same-id",
          providers: ["same-provider"],
          configSchema: {
            type: "object",
            properties: { revision: { type: "string" } },
            additionalProperties: false,
          },
        }),
      );
      const configFor = (revision: string) => ({
        plugins: {
          allow: ["same-id"],
          load: { paths: [plugin.file] },
          entries: { "same-id": { enabled: true, config: { revision } } },
        },
      });
      const firstConfig = configFor("A");
      const env = { OPENCLAW_STATE_DIR: makePluginLoaderTempDir() };
      const firstSnapshot = loadPluginMetadataSnapshot({ config: firstConfig, env });
      const loadOptions = {
        config: firstConfig,
        env,
        installRecords: {},
        onlyPluginIds: ["same-id"],
        manifestRegistry: firstSnapshot.manifestRegistry,
        activate: false,
      };
      const loadedRegistry = loadOpenClawPlugins(loadOptions);
      setActivePluginRegistry(loadedRegistry, resolvePluginLoadCacheContext(loadOptions).cacheKey);
      const lookup = { provider: receiver === "declared" ? "same-provider" : "runtime-alias", env };
      const modelOnlyConfig = { ...firstConfig, agents: { defaults: { model: "other/model" } } };
      expect(
        resolveLoadedProviderRuntimePlugin({ ...lookup, config: modelOnlyConfig })?.label,
      ).toBe("A/1");
      const nextConfig = change === "mutate" ? firstConfig : configFor("B");
      nextConfig.plugins.entries["same-id"].config.revision = "B";
      const nextSnapshot = loadPluginMetadataSnapshot({ config: nextConfig, env });
      if (change === "rebind") {
        const capturedContext = getPluginRuntimeLoadContext(loadedRegistry);
        assert.ok(capturedContext);
        setPluginRuntimeLoadContext(loadedRegistry, {
          ...capturedContext,
          rawConfig: nextConfig,
          config: nextConfig,
          activationSourceConfig: nextConfig,
          metadataSnapshot: nextSnapshot,
        });
      }
      const requested = {
        ...lookup,
        config: nextConfig,
        ...(snapshotPresent ? { pluginMetadataSnapshot: nextSnapshot } : {}),
      };
      expect(
        withPluginRuntimeGenerationScope(
          { pluginRegistry: loadedRegistry, metadataSnapshot: firstSnapshot },
          () => resolveProviderRuntimePlugin(requested)?.label,
        ),
      ).toBe("A/1");
      expect(resolveLoadedProviderRuntimePlugin(requested)).toBeUndefined();
      expect(readFileSync(registrationMarker, "utf8")).toBe("A/1");
      expect(
        resolvePluginProvidersCore({ ...requested, providerRefs: [requested.provider] }).map(
          (provider) => provider.label,
        ),
      ).toEqual(receiver === "removed-alias" ? [] : ["B/2"]);
      expect(readFileSync(registrationMarker, "utf8")).toBe("B/2");
      expect(resolveProviderRuntimePlugin(requested)?.label).toBe(
        receiver === "removed-alias" ? undefined : "B/2",
      );
    },
  );

  it("checks changed discovery selectors before borrowing registry-owned manifests", () => {
    const old = loadFixture("old");
    const next = loadFixture("next");
    const stateDir = makePluginLoaderTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const configFor = (snapshot: typeof old) => ({
      ...config,
      plugins: {
        ...config.plugins,
        load: { paths: snapshot.plugins.map((plugin) => plugin.source) },
      },
    });
    const originalConfig = configFor(old);
    const originalSnapshot = loadPluginMetadataSnapshot({ config: originalConfig, env });
    const loaded = loadOpenClawPlugins({
      config: originalConfig,
      env,
      installRecords: {},
      onlyPluginIds: ["same-id"],
      manifestRegistry: originalSnapshot.manifestRegistry,
      activate: false,
    });
    setActivePluginRegistry(loaded, "original-selectors");
    const lookup = { provider: "same-provider", env };
    const derivedConfig = {
      ...originalConfig,
      agents: { defaults: { workspace: "/synthetic/derived" } },
    };
    expect(resolveLoadedProviderRuntimePlugin({ ...lookup, config: derivedConfig })?.label).toBe(
      "old",
    );
    const changed = { ...lookup, config: configFor(next) };
    expect(resolveLoadedProviderRuntimePlugin(changed) === undefined).toBe(true);
    originalConfig.plugins.load.paths = changed.config.plugins.load.paths;
    expect(
      resolveLoadedProviderRuntimePlugin({ ...lookup, config: originalConfig }) === undefined,
    ).toBe(true);
    expect(resolveProviderRuntimePlugin(changed)?.label).toBe("next");
  });

  it.each(["replaced", "absent", "setup-only"] as const)(
    "reserves a %s literal owner before considering another loaded hook alias",
    (state) => {
      const old = loadFixture("old");
      let selected = loadFixture("selected");
      if (state === "setup-only") {
        selected = createPluginMetadataSnapshotFixture({
          plugins: selected.plugins.map((plugin) => ({
            ...plugin,
            channels: ["setup-channel"],
            setupSource: path.join(plugin.rootDir, "setup.cjs"),
          })),
        });
        const plugin = selected.plugins[0];
        assert.ok(plugin?.setupSource);
        writeFileSync(
          plugin.setupSource,
          `module.exports={plugin:{id:"setup-channel",meta:{id:"setup-channel",label:"Setup",selectionLabel:"Setup",docsPath:"/synthetic",blurb:"Synthetic"},capabilities:{chatTypes:["direct"]},config:{listAccountIds:()=>[],resolveAccount:()=>({})}}};`,
        );
      }
      const alias = writePlugin({
        id: "alias-owner",
        filename: "index.cjs",
        body: `module.exports = { id: "alias-owner", register(api) {
          api.registerProvider({ id: "other-provider", label: "alias", auth: [],
            hookAliases: ["same-provider", "runtime-only"] });
        }};`,
      });
      writeFileSync(
        path.join(alias.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "alias-owner",
          providers: ["other-provider"],
          configSchema: EMPTY_PLUGIN_SCHEMA,
        }),
      );
      const aliasMetadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "alias-owner",
            origin: "global",
            rootDir: alias.dir,
            source: alias.file,
            providers: ["other-provider"],
            providerAuthAliases: { "same-provider": "other-provider" },
            activation: { onProviders: ["same-provider"] },
            configSchema: EMPTY_PLUGIN_SCHEMA,
          },
        ],
      });
      const pluginConfig = {
        plugins: {
          allow: ["same-id", "alias-owner"],
          entries: {
            "same-id": { enabled: true },
            "alias-owner": { enabled: true },
          },
        },
      };
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [...selected.plugins, ...aliasMetadata.plugins],
      });
      const loaded = loadOpenClawPlugins({
        config: pluginConfig,
        env: {},
        installRecords: {},
        activate: false,
        channelPluginLoadIntent: state === "setup-only" ? "setup" : undefined,
        manifestRegistry: {
          plugins: [
            ...(state === "absent" ? [] : state === "replaced" ? old.plugins : selected.plugins),
            ...aliasMetadata.plugins,
          ],
          diagnostics: [],
        },
      });
      setActivePluginRegistry(loaded, state);
      const lookup = { config: pluginConfig, env: {}, pluginMetadataSnapshot: snapshot };
      expect(
        resolveLoadedProviderRuntimePlugin({ ...lookup, provider: "same-provider" }) === undefined,
      ).toBe(true);
      expect(
        resolveLoadedProviderPluginsForHooks({
          ...lookup,
          providerRefs: ["same-provider", "other-provider"],
          onlyPluginIds: ["same-id", "alias-owner"],
        }) === undefined,
      ).toBe(true);
      expect(resolveProviderRuntimePlugin({ ...lookup, provider: "same-provider" })?.label).toBe(
        "selected",
      );
      expect(
        resolvePluginProvidersCore({ ...lookup, providerRefs: ["same-provider"] }).map(
          (provider) => provider.label,
        ),
      ).toEqual(["selected"]);
      expect(
        resolveProviderPluginsForHooks({
          ...lookup,
          providerRefs: ["same-provider", "other-provider"],
          onlyPluginIds: ["same-id", "alias-owner"],
        })
          .map((provider) => provider.label)
          .toSorted(),
      ).toEqual(["alias", "selected"]);
      expect(
        resolveLoadedProviderRuntimePlugin({
          ...lookup,
          pluginMetadataSnapshot: aliasMetadata,
          provider: "same-provider",
        })?.label,
      ).toBe("alias");
      const complete = loadOpenClawPlugins({
        config: pluginConfig,
        env: {},
        installRecords: {},
        manifestRegistry: snapshot.manifestRegistry,
        activate: false,
      });
      if (state === "setup-only") {
        expect(complete.providers.map((entry) => entry.provider.label).toSorted()).toEqual([
          "alias",
          "selected",
        ]);
        withPluginRuntimeGenerationScope(
          { metadataSnapshot: snapshot, pluginRegistry: loaded },
          () => {
            expect(
              resolveProviderPluginsForHooks({
                ...lookup,
                providerRefs: ["same-provider", "other-provider"],
              }).map((provider) => provider.label),
            ).toEqual(["alias"]);
            expect(
              resolveProviderRuntimePlugin({ ...lookup, provider: "same-provider" }) === undefined,
            ).toBe(true);
          },
        );
      }
      const verifyAliasProjection = () => {
        const aliases = { ...lookup, providerRefs: ["runtime-only"] };
        expect(
          resolveLoadedProviderPluginsForHooks(aliases)?.map((provider) => provider.label),
        ).toEqual(["alias"]);
        expect(resolveProviderPluginsForHooks(aliases).map((provider) => provider.label)).toEqual([
          "alias",
        ]);
        expect(
          resolveProviderPluginsForHooks({
            ...lookup,
            providerRefs: ["same-provider", "runtime-only"],
          })
            .map((provider) => provider.label)
            .toSorted(),
        ).toEqual(["alias", "selected"]);
      };
      withPluginRuntimeRegistryScope(complete, verifyAliasProjection);
      withPluginRuntimeGenerationScope(
        { metadataSnapshot: snapshot, pluginRegistry: complete },
        () => {
          verifyAliasProjection();
          expect(resolveProviderPluginsForHooks({ ...lookup, providerRefs: ["unknown"] })).toEqual(
            [],
          );
        },
      );
    },
  );

  // Compare opaque handles as scalars: failure formatting must not inspect lazy runtime proxies.
  it.each(
    (["request", "active"] as const).flatMap((scope) =>
      (["global", "bundled"] as const).flatMap((origin) =>
        ["unrelated", "nested-layout"].map((layout) => ({ scope, origin, layout })),
      ),
    ),
  )("rejects another $origin $layout source in a $scope registry", ({ scope, origin, layout }) => {
    const packageRoot = makePluginLoaderTempDir();
    const oldRoot = path.join(
      packageRoot,
      "extensions",
      layout === "nested-layout" ? "task/dist/extensions" : "old",
      "same-id",
    );
    const oldPlugin = loadFixture("old", oldRoot).plugins[0];
    assert.ok(oldPlugin);
    const old = registry(metadata(oldPlugin.rootDir, oldPlugin.source, origin));
    const newRoot = path.join(
      packageRoot,
      "extensions",
      layout === "nested-layout" ? "task/extensions" : "new",
      "same-id",
    );
    const lookup = {
      provider: "same-provider",
      pluginMetadataSnapshot: metadata(
        newRoot,
        path.join(newRoot, path.basename(oldPlugin.source)),
        origin,
      ),
    };
    const check = () => {
      expect(resolveLoadedProviderRuntimePlugin(lookup) === undefined).toBe(true);
      expect(
        resolveLoadedProviderPluginsForHooks({
          providerRefs: [lookup.provider],
          pluginMetadataSnapshot: lookup.pluginMetadataSnapshot,
        }) === undefined,
      ).toBe(true);
    };
    if (scope === "request") {
      withPluginRuntimeRegistryScope(old, check);
    } else {
      setActivePluginRegistry(old, "old");
      check();
    }
  });

  it("matches physical manifests before reusing a bounded active registry", () => {
    const snapshot = loadFixture("old");
    const old = registry(snapshot);
    setActivePluginRegistry(old, "old");
    const resolve = (selected: typeof snapshot) =>
      getLoadedRuntimePluginRegistry({
        requiredPluginIds: ["same-id"],
        loadOptions: {
          onlyPluginIds: ["same-id"],
          manifestRegistry: selected.manifestRegistry,
        },
      });
    expect(resolve(snapshot) === old).toBe(true);
    expect(resolve(metadata("/synthetic/new")) === undefined).toBe(true);
  });

  it("does not reuse an active registry for another raw discovery selection", () => {
    const snapshot = loadFixture("old");
    const old = registry(snapshot);
    const options = (selected: typeof snapshot) => ({
      config,
      env: {},
      installRecords: {},
      onlyPluginIds: ["same-id"],
      discovery: {
        candidates: createPluginCandidatesFromManifestRegistry(selected.manifestRegistry),
        diagnostics: [],
      },
    });
    const oldOptions = options(snapshot);
    setActivePluginRegistry(old, resolvePluginLoadCacheContext(oldOptions).cacheKey);
    expect(
      getLoadedRuntimePluginRegistry({
        loadOptions: oldOptions,
        requiredPluginIds: ["same-id"],
      }) === old,
    ).toBe(true);
    expect(
      getLoadedRuntimePluginRegistry({
        loadOptions: options(metadata("/synthetic/new")),
        requiredPluginIds: ["same-id"],
      }) === undefined,
    ).toBe(true);
  });

  it("uses the loaded owner rather than a later disabled duplicate record", () => {
    const old = loadFixture("old");
    const next = loadFixture("new");
    const loaded = loadOpenClawPlugins({
      config,
      env: {},
      installRecords: {},
      onlyPluginIds: ["same-id"],
      activate: false,
      manifestRegistry: { plugins: [...old.plugins, ...next.plugins], diagnostics: [] },
    });
    expect(loaded.plugins.map((plugin) => plugin.status)).toEqual(["loaded", "disabled"]);
    withPluginRuntimeRegistryScope(loaded, () => {
      const combined = createPluginMetadataSnapshotFixture({
        plugins: [...old.plugins, ...next.plugins],
      });
      expect(
        resolveLoadedProviderRuntimePlugin({
          provider: "same-provider",
          pluginMetadataSnapshot: combined,
        })?.label,
      ).toBe("old");
      expect(
        resolveLoadedProviderRuntimePlugin({
          provider: "same-provider",
          pluginMetadataSnapshot: old,
        })?.label,
      ).toBe("old");
      expect(
        resolveLoadedProviderRuntimePlugin({
          provider: "same-provider",
          pluginMetadataSnapshot: next,
        }) === undefined,
      ).toBe(true);
    });
  });

  it.each(["source preference", "explicit load preference", "omitted load preference"] as const)(
    "honors %s when matching a loaded artifact",
    (selection) => {
      const source = loadFixture("source");
      const sourcePlugin = source.plugins[0];
      assert.ok(sourcePlugin);
      const built = loadFixture("built", sourcePlugin.rootDir);
      const builtPlugin = built.plugins[0];
      assert.ok(builtPlugin);
      const rootDir = sourcePlugin.rootDir;
      mkdirSync(path.join(rootDir, "dist"));
      const sourcePath = path.join(rootDir, "index.cts");
      writeFileSync(
        sourcePath,
        `module.exports = require(${JSON.stringify(sourcePlugin.source)});`,
      );
      writeFileSync(
        path.join(rootDir, "dist/index.cjs"),
        `module.exports = require(${JSON.stringify(builtPlugin.source)});`,
      );
      const original = metadata(rootDir, sourcePath);
      const selected = createPluginMetadataSnapshotFixture({
        plugins: original.plugins.map((plugin) => ({
          ...plugin,
          ...(selection === "source preference" ? { sourcePreferred: true as const } : {}),
        })),
      });
      const options = {
        config,
        env: {},
        installRecords: {},
        onlyPluginIds: ["same-id"],
        activate: false,
        preferBuiltPluginArtifacts: true,
      };
      const loaded = loadOpenClawPlugins({
        ...options,
        manifestRegistry: original.manifestRegistry,
      });
      const selectedOptions = {
        ...options,
        preferBuiltPluginArtifacts:
          selection === "omitted load preference" ? undefined : selection === "source preference",
        manifestRegistry: selected.manifestRegistry,
      };
      expect(loaded.providers[0]?.provider.label).toBe("built");
      setActivePluginRegistry(loaded, "built");
      expect(
        getLoadedRuntimePluginRegistry({ loadOptions: selectedOptions }) ===
          (selection === "omitted load preference" ? loaded : undefined),
      ).toBe(true);
      expect(loadOpenClawPlugins(selectedOptions).providers[0]?.provider.label).toBe("source");
      if (selection === "source preference") {
        withPluginRuntimeRegistryScope(loaded, () => {
          expect(
            resolveLoadedProviderRuntimePlugin({
              provider: "same-provider",
              pluginMetadataSnapshot: selected,
            }) === undefined,
          ).toBe(true);
        });
      }
    },
  );

  it("keeps an admitted dreaming sidecar in the scoped loader source identity", () => {
    const memoryPlugin = (id: string, label: string) => {
      const plugin = writePlugin({
        id,
        filename: "index.cjs",
        body: `module.exports = { id: ${JSON.stringify(id)}, kind: "memory", register(api) {
          api.registerProvider({ id: ${JSON.stringify(id)}, label: ${JSON.stringify(label)}, auth: [] });
        }};`,
      });
      return {
        id,
        kind: "memory" as const,
        origin: "global" as const,
        rootDir: plugin.dir,
        source: plugin.file,
        configSchema: { type: "object", additionalProperties: true },
      };
    };
    const selected = memoryPlugin("selected-memory", "selected");
    const old = memoryPlugin("memory-core", "old");
    const next = memoryPlugin("memory-core", "new");
    const load = (sidecar: ReturnType<typeof memoryPlugin>) =>
      loadOpenClawPlugins({
        config: {
          plugins: {
            allow: ["selected-memory", "memory-core"],
            slots: { memory: "selected-memory" },
            entries: {
              "selected-memory": { enabled: true, config: { dreaming: { enabled: true } } },
              "memory-core": { enabled: true },
            },
          },
        },
        env: {},
        installRecords: {},
        onlyPluginIds: ["selected-memory"],
        activate: false,
        manifestRegistry: createPluginMetadataSnapshotFixture({ plugins: [selected, sidecar] })
          .manifestRegistry,
      }).providers.find((entry) => entry.pluginId === "memory-core")?.provider.label;
    expect([load(old), load(next), load(old)]).toEqual(["old", "new", "old"]);
  });

  it("retains an exact runtime generation despite newer supplied metadata", () => {
    const selected = loadFixture("old");
    const old = registry(selected);
    const newer = createPluginMetadataSnapshotFixture();
    const lookup = { provider: "same-provider", config, pluginMetadataSnapshot: newer };
    withPluginRuntimeGenerationScope({ metadataSnapshot: selected, pluginRegistry: old }, () => {
      expect(resolveLoadedProviderRuntimePlugin(lookup)?.label).toBe("old");
      expect(
        resolvePluginProvidersCore({
          config,
          providerRefs: [lookup.provider],
          pluginMetadataSnapshot: newer,
        }).map((provider) => provider.label),
      ).toEqual(["old"]);
      withPluginRuntimeGenerationScope({ metadataSnapshot: selected }, () => {
        expect(resolveLoadedProviderRuntimePlugin(lookup) === undefined).toBe(true);
        expect(resolveLoadedProviderPluginsForHooks({ providerRefs: [lookup.provider] })).toEqual(
          [],
        );
      });
    });
  });

  it.each([undefined, "/synthetic/retained"])(
    "carries retained workspace %s into handles without explicit metadata",
    (workspaceDir) => {
      const selected = { ...loadFixture("retained"), workspaceDir };
      const retained = registry(selected, workspaceDir);
      const ambient = registry(loadFixture("ambient"), "/synthetic/ambient");
      setActivePluginRegistry(ambient, "ambient", "default", "/synthetic/ambient");
      const lookup = { provider: "same-provider", config };
      withPluginRuntimeGenerationScope(
        { metadataSnapshot: selected, pluginRegistry: retained },
        () => {
          const handle = resolveProviderRuntimePluginHandle(lookup);
          expect(handle.plugin?.label).toBe("retained");
          expect(handle.workspaceDir).toBe(workspaceDir);
          const explicit = resolveProviderRuntimePluginHandle({
            ...lookup,
            workspaceDir: "/synthetic/explicit",
          });
          expect(explicit.plugin?.label).toBe("retained");
          expect(explicit.workspaceDir).toBe("/synthetic/explicit");
        },
      );
      withPluginRuntimeGenerationScope({ metadataSnapshot: selected }, () => {
        const empty = resolveProviderRuntimePluginHandle(lookup);
        expect(empty.plugin).toBeUndefined();
        expect(empty.workspaceDir).toBe(workspaceDir);
      });
    },
  );

  it.each(["empty active", "loaded active", "request"] as const)(
    "retains a full shared-root snapshot across another %s workspace",
    (scope) => {
      const fixture = loadFixture("shared");
      const stateDir = makePluginLoaderTempDir();
      withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
        const snapshot = loadPluginMetadataSnapshot({
          config,
          env: process.env,
          index: fixture.index,
        });
        const lookup = {
          provider: "same-provider",
          config,
          env: process.env,
          pluginMetadataSnapshot: snapshot,
        };
        const registration = (handle: ReturnType<typeof resolveProviderRuntimePluginHandle>) =>
          handle.plugin?.normalizeModelId?.({ provider: lookup.provider, modelId: "probe" });
        expect(registration(resolveProviderRuntimePluginHandle(lookup))).toBe("1");
        const otherWorkspace = path.join(stateDir, "other-workspace");
        const other =
          scope === "empty active"
            ? createEmptyPluginRegistry()
            : loadOpenClawPlugins({
                config,
                env: process.env,
                installRecords: {},
                workspaceDir: otherWorkspace,
                onlyPluginIds: ["same-id"],
                manifestRegistry: snapshot.manifestRegistry,
                activate: false,
              });
        setActivePluginRegistry(other, "other-workspace", "default", otherWorkspace);
        const verify = () => {
          const retained = resolveProviderRuntimePluginHandle(lookup);
          expect(retained.workspaceDir).toBeUndefined();
          expect(registration(retained)).toBe("1");
          if (scope !== "empty active") {
            expect(
              registration(
                resolveProviderRuntimePluginHandle({ ...lookup, workspaceDir: otherWorkspace }),
              ),
            ).toBe("2");
            const narrowed = { index: snapshot.index, manifestRegistry: snapshot.manifestRegistry };
            expect(
              registration(
                resolveProviderRuntimePluginHandle({ ...lookup, pluginMetadataSnapshot: narrowed }),
              ),
            ).toBe("2");
          }
        };
        if (scope === "request") {
          withPluginRuntimeRegistryScope(other, verify);
        } else {
          verify();
        }
      });
    },
  );

  it.each(["explicit", "narrowed"] as const)(
    "uses the resolved %s workspace instead of another request registry",
    (selection) => {
      const snapshot = loadFixture("shared");
      const load = (workspaceDir: string) =>
        loadOpenClawPlugins({
          config,
          env: {},
          installRecords: {},
          workspaceDir,
          onlyPluginIds: ["same-id"],
          manifestRegistry: snapshot.manifestRegistry,
          activate: false,
        });
      const request = load("/synthetic/request");
      const active = load("/synthetic/active");
      setActivePluginRegistry(active, "active", "default", "/synthetic/active");
      withPluginRuntimeRegistryScope(request, () => {
        const params =
          selection === "explicit"
            ? { workspaceDir: "/synthetic/active" }
            : {
                pluginMetadataSnapshot: {
                  index: snapshot.index,
                  manifestRegistry: snapshot.manifestRegistry,
                },
              };
        const context = { provider: "same-provider", modelId: "probe" };
        expect(
          resolveLoadedProviderRuntimePlugin({
            provider: context.provider,
            ...params,
          })?.normalizeModelId?.(context),
        ).toBe("2");
        expect(
          resolveLoadedProviderPluginsForHooks({
            providerRefs: [context.provider],
            ...params,
          })?.[0]?.normalizeModelId?.(context),
        ).toBe("2");
      });
    },
  );

  it.each(
    ["loader", "provider", "discovery"].flatMap((surface) =>
      ["root", "entry"].map((changed) => ({ surface, changed })),
    ),
  )("keeps warm $surface entries bound to a changed $changed", ({ surface, changed }) => {
    const sharedRoot = changed === "entry" ? makePluginLoaderTempDir() : undefined;
    const old = loadFixture("old", sharedRoot);
    const next = loadFixture("new", sharedRoot);
    const stateDir = makePluginLoaderTempDir();
    const load = (snapshot: typeof old) =>
      surface !== "provider"
        ? loadOpenClawPlugins({
            config,
            env: process.env,
            installRecords: {},
            onlyPluginIds: ["same-id"],
            ...(surface === "discovery"
              ? {
                  discovery: {
                    candidates: createPluginCandidatesFromManifestRegistry(
                      snapshot.manifestRegistry,
                    ),
                    diagnostics: [],
                  },
                }
              : { manifestRegistry: snapshot.manifestRegistry }),
            activate: false,
          }).providers[0]?.provider
        : resolveProviderRuntimePlugin({
            provider: "same-provider",
            config,
            env: process.env,
            pluginMetadataSnapshot: snapshot,
          });
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      expect(load(old)?.label).toBe("old");
      expect(load(next)?.label).toBe("new");
      const reused = load(old);
      expect(reused?.label).toBe("old");
      expect(reused?.normalizeModelId?.({ provider: "same-provider", modelId: "probe" })).toBe("1");
    });
  });
});
