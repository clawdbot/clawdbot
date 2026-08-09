import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import type { PluginDiscoveryResult } from "./discovery.js";
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

  it("registers channel capabilities during discovery without replacing the active registry", () => {
    const target = writeChannelCapabilityPlugin("capability-channel");
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active, "existing-channel-registry");
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [target.id],
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
