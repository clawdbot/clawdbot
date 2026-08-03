import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  type TempPlugin,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  getPluginRegistrationContext,
  listImportedRuntimePluginIds,
  setActivePluginRegistry,
} from "./runtime.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

function discoveryFor(...plugins: TempPlugin[]): PluginDiscoveryResult {
  return {
    candidates: plugins.map((plugin) => ({
      idHint: plugin.id,
      rootDir: plugin.dir,
      source: plugin.file,
      origin: "bundled",
    })),
    diagnostics: [],
  };
}

function writeArtifactPreferencePlugin(id: string): TempPlugin {
  const plugin = writePlugin({
    id,
    filename: "index.ts",
    body: `export default {
      id: ${JSON.stringify(id)},
      register(api) {
        api.registerProvider({ id: ${JSON.stringify(`${id}-source`)}, label: "Source", auth: [] });
      },
    };`,
  });
  const distDir = path.join(plugin.dir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, "index.js"),
    `module.exports = {
      id: ${JSON.stringify(id)},
      register(api) {
        api.registerProvider({ id: ${JSON.stringify(`${id}-built`)}, label: "Built", auth: [] });
      },
    };`,
  );
  return plugin;
}

function writeDistShimCapabilityPlugin(id: string): TempPlugin {
  return writePlugin({
    id,
    filename: "index.ts",
    body: `import { isVoiceCompatibleAudio } from "openclaw/plugin-sdk/media-runtime";

void isVoiceCompatibleAudio;

export default {
  id: ${JSON.stringify(id)},
  register(api) {
    api.registerMediaUnderstandingProvider({ id: ${JSON.stringify(id)} });
    api.registerWebSearchProvider({ id: ${JSON.stringify(id)} });
    api.registerMigrationProvider({ id: ${JSON.stringify(id)} });
  },
};`,
  });
}

function writeChannelCapabilityPlugin(id: string): TempPlugin {
  const plugin = writePlugin({
    id,
    body: `module.exports = {
      id: ${JSON.stringify(id)},
      register(api) {
        if (api.registrationMode === "discovery") {
          api.registerTranscriptSourceProvider({
            id: ${JSON.stringify(`${id}-voice`)},
            name: "Voice transcripts",
            sourceKinds: ["meeting"],
          });
        }
      },
    };`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id,
        channels: [id],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    ),
  );
  return plugin;
}

function loadCanonicalFixture(plugin: TempPlugin, discovery: PluginDiscoveryResult) {
  return loadOpenClawPlugins({
    config: {
      plugins: {
        allow: [plugin.id],
        entries: { [plugin.id]: { enabled: true } },
      },
    },
    discovery,
    onlyPluginIds: [plugin.id],
    preferBuiltPluginArtifacts: false,
    cache: false,
    activate: false,
  });
}

describe("loadBundledCapabilityRuntimeRegistry", () => {
  it("loads only the requested bundled plugin without replacing the active registry", () => {
    const target = writePlugin({
      id: "capability-target",
      body: `module.exports = {
        id: "capability-target",
        register(api) {
          if (api.registrationMode === "discovery") {
            api.registerProvider({ id: "capability-target", label: "Target", auth: [] });
          }
          if (api.registrationMode === "full") {
            api.registerProvider({ id: "full-only", label: "Full only", auth: [] });
          }
        },
      };`,
    });
    const unscoped = writePlugin({
      id: "capability-unscoped",
      body: `module.exports = {
        id: "capability-unscoped",
        register() { throw new Error("unscoped plugin loaded"); },
      };`,
    });
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active, "existing-registry");
    const activeSnapshotBefore = captureActivePluginRegistrySnapshot();
    const registrationContextBefore = getPluginRegistrationContext();

    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [target.id],
      discovery: discoveryFor(target, unscoped),
    });

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual([target.id]);
    expect(registry.plugins[0]?.status).toBe("loaded");
    expect(registry.providers.map((entry) => entry.provider.id)).toEqual([target.id]);
    expect(getActivePluginRegistry()).toBe(active);
    expect(captureActivePluginRegistrySnapshot()).toEqual(activeSnapshotBefore);
    expect(getPluginRegistrationContext()).toBe(registrationContextBefore);
    expect(listImportedRuntimePluginIds()).toContain(target.id);
  });

  it.each([
    {
      name: "explicitly disabled",
      plugins: { entries: { "blocked-capability": { enabled: false } } },
    },
    { name: "denylisted", plugins: { deny: ["blocked-capability"] } },
    { name: "outside the restrictive allowlist", plugins: { allow: ["allowed-capability"] } },
    { name: "blocked by global plugin disablement", plugins: { enabled: false } },
  ])("never imports a $name plugin through bundled capability capture", ({ plugins }) => {
    const blocked = writePlugin({
      id: "blocked-capability",
      body: `module.exports = {
        id: "blocked-capability",
        register(api) {
          api.registerProvider({ id: "blocked-capability", label: "Blocked", auth: [] });
        },
      };`,
    });

    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [blocked.id],
      config: { plugins },
      discovery: discoveryFor(blocked),
    });

    expect(registry.providers).toEqual([]);
    expect(listImportedRuntimePluginIds()).not.toContain(blocked.id);
  });

  it.each(["source", "built"] as const)(
    "keeps %s-first artifact preferences isolated across registry snapshots",
    (firstArtifact) => {
      const plugin = writeArtifactPreferencePlugin(`capability-${firstArtifact}-first`);
      const discovery = discoveryFor(plugin);
      const loadCapability = () =>
        loadBundledCapabilityRuntimeRegistry({
          pluginIds: [plugin.id],
          pluginSdkResolution: "dist",
          discovery,
        });
      const first =
        firstArtifact === "source" ? loadCanonicalFixture(plugin, discovery) : loadCapability();
      const second =
        firstArtifact === "source" ? loadCapability() : loadCanonicalFixture(plugin, discovery);

      expect(first.providers.map((entry) => entry.provider.id)).toEqual([
        `${plugin.id}-${firstArtifact}`,
      ]);
      expect(second.providers.map((entry) => entry.provider.id)).toEqual([
        `${plugin.id}-${firstArtifact === "source" ? "built" : "source"}`,
      ]);
      expect(first.pluginRuntimeArtifacts).not.toBe(second.pluginRuntimeArtifacts);
    },
  );

  it("loads runtime-backed bundled capabilities through the dist SDK shims", () => {
    const target = writeDistShimCapabilityPlugin("capability-dist-shims");
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [target.id],
      pluginSdkResolution: "dist",
      discovery: discoveryFor(target),
    });

    const plugin = registry.plugins.find((entry) => entry.id === target.id);
    expect(
      plugin?.status,
      JSON.stringify({ plugin, diagnostics: registry.diagnostics }, null, 2),
    ).toBe("loaded");
    expect(registry.mediaUnderstandingProviders.map((entry) => entry.provider.id)).toEqual([
      target.id,
    ]);
    expect(registry.webSearchProviders.map((entry) => entry.provider.id)).toEqual([target.id]);
    expect(registry.migrationProviders.map((entry) => entry.provider.id)).toEqual([target.id]);
  });

  it("registers channel capabilities during discovery without replacing the active registry", () => {
    const target = writeChannelCapabilityPlugin("capability-channel");
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active, "existing-channel-registry");
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [target.id],
      pluginSdkResolution: "dist",
      discovery: discoveryFor(target),
    });

    const plugin = registry.plugins.find((entry) => entry.id === target.id);
    expect(
      plugin?.status,
      JSON.stringify({ plugin, diagnostics: registry.diagnostics }, null, 2),
    ).toBe("loaded");
    expect(plugin?.transcriptSourceProviderIds).toEqual([`${target.id}-voice`]);
    expect(registry.transcriptSourceProviders.map((entry) => entry.provider.id)).toEqual([
      `${target.id}-voice`,
    ]);
    expect(registry.typedHooks).toEqual([]);
    expect(getActivePluginRegistry()).toBe(active);
  });
});
