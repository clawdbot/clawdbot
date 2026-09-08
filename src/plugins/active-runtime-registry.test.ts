// Covers active runtime plugin registry state and reset behavior.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  getLoadedRuntimePluginRegistry,
  listLoadedRuntimePluginIds,
  listRuntimePluginIdsFromRegistry,
  createRuntimePluginManifestLookup,
} from "./active-runtime-registry.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  EMPTY_PLUGIN_SCHEMA,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

afterEach(() => {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
});

afterAll(cleanupPluginLoaderFixturesForTest);

function createRegistryWithPlugin(pluginId: string): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: pluginId,
    status: "loaded",
  } as never);
  return registry;
}

function createOwnedRegistryWithPlugin(pluginId: string, rootDir: string): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: pluginId,
    origin: "bundled",
    rootDir,
    source: `${rootDir}/index.js`,
    status: "loaded",
  } as never);
  return registry;
}

describe("getLoadedRuntimePluginRegistry", () => {
  it("treats an explicit empty plugin scope as empty", () => {
    setActivePluginRegistry(createRegistryWithPlugin("stale"), "stale", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBeUndefined();

    const emptyRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(emptyRegistry, "empty", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBe(emptyRegistry);
  });

  it("does not treat disabled plugin records as an empty plugin scope", () => {
    const disabledRegistry = createEmptyPluginRegistry();
    disabledRegistry.plugins.push({
      id: "disabled",
      status: "disabled",
    } as never);
    setActivePluginRegistry(disabledRegistry, "disabled", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBeUndefined();
  });

  it("does not treat diagnostics as loaded plugin records", () => {
    const failedRegistry = createEmptyPluginRegistry();
    failedRegistry.plugins.push({
      id: "failed",
      status: "error",
    } as never);
    failedRegistry.diagnostics.push({
      level: "error",
      pluginId: "failed",
      message: "failed to load",
    } as never);
    setActivePluginRegistry(failedRegistry, "failed", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["failed"],
      }),
    ).toBeUndefined();
  });

  it("does not treat setup-only registrations as loaded plugin records", () => {
    const setupRegistry = createEmptyPluginRegistry();
    setupRegistry.plugins.push({
      id: "setup-only",
      status: "disabled",
    } as never);
    setupRegistry.channelSetups.push({
      pluginId: "setup-only",
    } as never);
    setActivePluginRegistry(setupRegistry, "setup-only", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["setup-only"],
      }),
    ).toBeUndefined();
  });

  it("does not treat deferred plugin metadata as a loaded runtime", () => {
    const deferredRegistry = createEmptyPluginRegistry();
    deferredRegistry.plugins.push({
      id: "deferred",
      format: "openclaw",
      imported: false,
      status: "loaded",
    } as never);
    setActivePluginRegistry(deferredRegistry, "deferred", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["deferred"],
      }),
    ).toBeUndefined();
    expect(listLoadedRuntimePluginIds()).not.toContain("deferred");
    expect(listRuntimePluginIdsFromRegistry(deferredRegistry)).not.toContain("deferred");
  });

  it("accepts metadata-only bundle plugins as loaded runtimes", () => {
    const bundleRegistry = createEmptyPluginRegistry();
    bundleRegistry.plugins.push({
      id: "bundle",
      format: "bundle",
      imported: false,
      status: "loaded",
    } as never);
    setActivePluginRegistry(bundleRegistry, "bundle", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["bundle"],
      }),
    ).toBe(bundleRegistry);
    expect(listLoadedRuntimePluginIds()).toContain("bundle");
    expect(listRuntimePluginIdsFromRegistry(bundleRegistry)).toContain("bundle");
  });

  it("reuses scoped loaded owners when load options differ from the active registry", () => {
    const registry = createRegistryWithPlugin("demo");
    setActivePluginRegistry(registry, "gateway-root-key", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        loadOptions: { workspaceDir: "/tmp/ws", onlyPluginIds: ["demo"] },
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["demo"],
      }),
    ).toBe(registry);
  });

  it("keeps exact-key semantics for unscoped load-option requests", () => {
    setActivePluginRegistry(
      createRegistryWithPlugin("demo"),
      "gateway-root-key",
      "default",
      "/tmp/ws",
    );

    expect(
      getLoadedRuntimePluginRegistry({
        loadOptions: { workspaceDir: "/tmp/ws" },
        workspaceDir: "/tmp/ws",
      }),
    ).toBeUndefined();
  });

  it("does not reuse workspace-agnostic registries for workspace-specific requests", () => {
    setActivePluginRegistry(createRegistryWithPlugin("demo"), "demo");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["demo"],
      }),
    ).toBeUndefined();
  });

  it("honors the requested workspace when scoped load options match the active key", () => {
    const registry = createRegistryWithPlugin("demo");
    const loadOptions = {
      config: {},
      installRecords: {},
      workspaceDir: "/tmp/owner-workspace",
      onlyPluginIds: ["demo"],
    };
    setActivePluginRegistry(
      registry,
      resolvePluginLoadCacheContext(loadOptions).cacheKey,
      "default",
      loadOptions.workspaceDir,
    );

    expect(
      getLoadedRuntimePluginRegistry({ loadOptions, workspaceDir: "/tmp/request-workspace" }),
    ).toBeUndefined();
  });

  it("rejects a request registry when a workspace selects another physical owner", () => {
    const registry = createOwnedRegistryWithPlugin("demo", "/plugins/demo");

    expect(
      createRuntimePluginManifestLookup(registry, [
        {
          id: "demo",
          origin: "workspace",
          rootDir: "/tmp/session-workspace/.openclaw/extensions/demo",
          source: "/tmp/session-workspace/.openclaw/extensions/demo/index.js",
        } as never,
      ])("demo"),
    ).toBeUndefined();
  });
});

it.each(["setup", "full"] as const)(
  "matches the executable setup source selected by a %s load",
  (channelPluginLoadIntent) => {
    const runtime = writePlugin({
      id: "setup-fixture",
      filename: "index.cjs",
      body: 'module.exports = { id: "setup-fixture", register() {} };',
    });
    for (const label of ["old", "new"]) {
      writeFileSync(
        path.join(runtime.dir, `${label}.cjs`),
        `module.exports = { plugin: {
        id: "setup-channel", meta: { id: "setup-channel", label: ${JSON.stringify(label)},
          selectionLabel: "Fixture", docsPath: "/synthetic", blurb: "Synthetic fixture" },
        capabilities: { chatTypes: ["direct"] },
        config: { listAccountIds: () => [], resolveAccount: () => ({}) },
      }};`,
      );
    }
    const options = (label: string) => ({
      config: { plugins: { allow: [runtime.id], entries: { [runtime.id]: { enabled: true } } } },
      env: {},
      installRecords: {},
      onlyPluginIds: [runtime.id],
      activate: false,
      channelPluginLoadIntent,
      manifestRegistry: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: runtime.id,
            origin: "global",
            rootDir: runtime.dir,
            source: runtime.file,
            channels: ["setup-channel"],
            configSchema: EMPTY_PLUGIN_SCHEMA,
            setupSource: path.join(runtime.dir, `${label}.cjs`),
            providerDiscoverySource: path.join(runtime.dir, `${label}.cjs`),
            capabilityCatalogSource: path.join(runtime.dir, `${label}.cjs`),
          },
        ],
      }).manifestRegistry,
    });
    const old = loadOpenClawPlugins(options("old"));
    const next = loadOpenClawPlugins(options("new"));
    expect(old.plugins[0]?.status).toBe("loaded");
    setActivePluginRegistry(old, "old");
    const reused = getLoadedRuntimePluginRegistry({ loadOptions: options("new") });
    if (channelPluginLoadIntent === "setup") {
      expect([old.channels[0]?.plugin.meta.label, next.channels[0]?.plugin.meta.label]).toEqual([
        "old",
        "new",
      ]);
      expect(reused === undefined).toBe(true);
    } else {
      expect(old.channels).toEqual([]);
      expect(reused === old).toBe(true);
    }
  },
);

it.each([
  { sourceFormat: "cts", builtFormat: "cjs", preferBuiltPluginArtifacts: false },
  { sourceFormat: "cts", builtFormat: "cjs", preferBuiltPluginArtifacts: true },
  { sourceFormat: "mts", builtFormat: "mjs", preferBuiltPluginArtifacts: false },
  { sourceFormat: "mts", builtFormat: "mjs", preferBuiltPluginArtifacts: true },
])(
  "reuses selected bundled setup $sourceFormat/$builtFormat artifacts with built=$preferBuiltPluginArtifacts",
  ({ sourceFormat, builtFormat, preferBuiltPluginArtifacts }) => {
    const schema = EMPTY_PLUGIN_SCHEMA;
    const packageRoot = makePluginLoaderTempDir();
    const options = [
      { format: sourceFormat, tree: "extensions" },
      { format: builtFormat, tree: "dist/extensions" },
      { format: builtFormat, tree: "dist-runtime/extensions" },
    ].map(({ format, tree }) => {
      const rootDir = path.join(packageRoot, tree, "bundled-setup");
      mkdirSync(rootDir, { recursive: true });
      const source = path.join(rootDir, `index.${format}`);
      const setupSource = path.join(rootDir, `setup.${format}`);
      const label = tree === "extensions" ? "source" : "built";
      const exported = ["mts", "mjs"].includes(format) ? "export default" : "module.exports =";
      writeFileSync(source, `${exported} { id: "bundled-setup", register() {} };`);
      writeFileSync(
        setupSource,
        `${exported} { plugin: {
      id: "bundled-setup", meta: { id: "bundled-setup", label: ${JSON.stringify(label)}, selectionLabel: "Fixture", docsPath: "/synthetic", blurb: "Synthetic fixture" },
      capabilities: { chatTypes: ["direct"] }, config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    }};`,
      );
      writeFileSync(
        path.join(rootDir, "package.json"),
        JSON.stringify({
          openclaw: { extensions: [`./index.${format}`], setupEntry: `./setup.${format}` },
        }),
      );
      writeFileSync(
        path.join(rootDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "bundled-setup", channels: ["bundled-setup"], configSchema: schema }),
      );
      return {
        config: {
          plugins: { allow: ["bundled-setup"], entries: { "bundled-setup": { enabled: true } } },
        },
        env: {},
        installRecords: {},
        onlyPluginIds: ["bundled-setup"],
        activate: false,
        preferBuiltPluginArtifacts,
        channelPluginLoadIntent: "setup" as const,
        manifestRegistry: createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "bundled-setup",
              origin: "bundled",
              rootDir,
              source,
              setupSource,
              channels: ["bundled-setup"],
              configSchema: schema,
            },
          ],
        }).manifestRegistry,
      };
    });
    const expectedLabel = (index: number) =>
      preferBuiltPluginArtifacts || index !== 0 ? "built" : "source";
    for (const [loadedIndex, loadedOptions] of options.entries()) {
      const loaded = loadOpenClawPlugins(loadedOptions);
      expect(loaded.channels[0]?.plugin.meta.label).toBe(expectedLabel(loadedIndex));
      setActivePluginRegistry(loaded, "canonical-view");
      for (const [requestedIndex, requestedOptions] of options.entries()) {
        expect(getLoadedRuntimePluginRegistry({ loadOptions: requestedOptions }) === loaded).toBe(
          expectedLabel(loadedIndex) === expectedLabel(requestedIndex),
        );
      }
    }
  },
);

it("does not reuse a different explicitly selected bundled entry", () => {
  const runtime = writePlugin({
    id: "entry-fixture",
    filename: "index.cjs",
    body: `module.exports = { id: "entry-fixture", register(api) {
      api.registerProvider({ id: "entry-provider", label: "Old", auth: [] });
    }};`,
  });
  const selectedSource = path.join(runtime.dir, "selected.cjs");
  writeFileSync(
    selectedSource,
    `module.exports = { id: "entry-fixture", register(api) {
    api.registerProvider({ id: "entry-provider", label: "Selected", auth: [] });
  }};`,
  );
  const options = (source: string) => ({
    config: { plugins: { allow: [runtime.id], entries: { [runtime.id]: { enabled: true } } } },
    env: {},
    installRecords: {},
    onlyPluginIds: [runtime.id],
    activate: false,
    manifestRegistry: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: runtime.id,
          origin: "bundled",
          rootDir: runtime.dir,
          source,
          sourcePreferred: true,
          providers: ["entry-provider"],
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
      ],
    }).manifestRegistry,
  });
  const old = loadOpenClawPlugins(options(runtime.file));
  expect(old.providers[0]?.provider.label).toBe("Old");
  setActivePluginRegistry(old, "old-entry");
  expect(
    getLoadedRuntimePluginRegistry({ loadOptions: options(selectedSource) }) === undefined,
  ).toBe(true);
  expect(loadOpenClawPlugins(options(selectedSource)).providers[0]?.provider.label).toBe(
    "Selected",
  );
});

it("compares the executed artifact after the loader's final staging pass", () => {
  const packageRoot = makePluginLoaderTempDir();
  let source = path.join(
    packageRoot,
    "dist-runtime/extensions/a/dist-runtime/extensions/b/dist-runtime/extensions/c/index.cjs",
  );
  const selectedSource = source;
  for (let stage = 0; stage <= 3; stage += 1) {
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(
      source,
      `module.exports = { id: "staged-fixture", register(api) {
        api.registerProvider({ id: "staged-provider", label: "stage-${stage}", auth: [] });
      }};`,
    );
    source = source.replace(
      `${path.sep}dist-runtime${path.sep}extensions${path.sep}`,
      `${path.sep}dist${path.sep}extensions${path.sep}`,
    );
  }
  const options = {
    config: {
      plugins: { allow: ["staged-fixture"], entries: { "staged-fixture": { enabled: true } } },
    },
    env: {},
    installRecords: {},
    onlyPluginIds: ["staged-fixture"],
    activate: false,
    preferBuiltPluginArtifacts: false,
    manifestRegistry: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "staged-fixture",
          origin: "bundled",
          rootDir: path.dirname(selectedSource),
          source: selectedSource,
          providers: ["staged-provider"],
          configSchema: EMPTY_PLUGIN_SCHEMA,
        },
      ],
    }).manifestRegistry,
  };
  const loaded = loadOpenClawPlugins(options);
  expect(loaded.providers[0]?.provider.label).toBe("stage-3");
  setActivePluginRegistry(loaded, "executed-stage");
  expect(getLoadedRuntimePluginRegistry({ loadOptions: options }) === loaded).toBe(true);
});
