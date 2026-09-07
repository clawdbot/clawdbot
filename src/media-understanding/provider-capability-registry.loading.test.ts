import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { pluginLoaderCacheState } from "../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { buildMediaUnderstandingCapabilityRegistry } from "./provider-capability-registry.js";

let root: string;

function resetFixtureState() {
  resetPluginRuntimeStateForTest();
  pluginLoaderCacheState.clear();
  clearPluginMetadataLifecycleCaches();
}

function createMediaOwner(pluginId: string, providerId: string) {
  const rootDir = path.join(root, pluginId);
  fs.mkdirSync(rootDir);
  const fixture = createColdPluginFixture({
    rootDir,
    pluginId,
    providerId,
    manifest: {
      channels: [],
      providers: [],
      activation: { onStartup: false },
      contracts: { mediaUnderstandingProviders: [providerId] },
    },
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `require("node:fs").appendFileSync(${JSON.stringify(fixture.runtimeMarker)}, ${JSON.stringify("import\n")});
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerMediaUnderstandingProvider({
      id: ${JSON.stringify(providerId)}, capabilities: ["audio"]
    });
  }
};
`,
  );
  return fixture;
}

describe("media capability inference owner loading", () => {
  beforeEach(() => {
    resetFixtureState();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-media-inference-"));
  });

  afterEach(() => {
    resetFixtureState();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    {
      name: "direct active provider",
      active: true,
      providerId: "qa-audio",
      configuredId: "qa-audio",
      imageFallback: false,
    },
    {
      name: "cold runtime-only provider",
      active: false,
      providerId: "qa-audio",
      configuredId: "qa-audio",
      imageFallback: false,
    },
    {
      name: "normalized media alias",
      active: true,
      providerId: "google",
      configuredId: " GEMINI ",
      imageFallback: false,
    },
    {
      name: "plugin capability ahead of config image fallback",
      active: true,
      providerId: "qa-audio",
      configuredId: "qa-audio",
      imageFallback: true,
    },
    {
      name: "provider alongside explicitly tagged shared models",
      active: true,
      providerId: "qa-audio",
      configuredId: "qa-audio",
      imageFallback: false,
      taggedPeers: true,
    },
  ])(
    "infers a $name without importing unrelated owners",
    ({ active, providerId, configuredId, imageFallback, taggedPeers }) => {
      const selected = createMediaOwner("qa-selected-owner", providerId);
      const unrelated = createMediaOwner("qa-unrelated-owner", "qa-unrelated");
      const config: OpenClawConfig = {
        plugins: {
          allow: [selected.pluginId, unrelated.pluginId],
          load: { paths: [selected.rootDir, unrelated.rootDir] },
          entries: {
            [selected.pluginId]: { enabled: true },
            [unrelated.pluginId]: { enabled: true },
          },
        },
        tools: {
          media: {
            models: [
              ...(taggedPeers
                ? [
                    { provider: configuredId, capabilities: ["image" as const] },
                    { provider: unrelated.providerId, capabilities: ["audio" as const] },
                  ]
                : []),
              { provider: configuredId },
            ],
          },
        },
      };
      if (imageFallback) {
        config.models = {
          providers: {
            [providerId]: {
              baseUrl: "https://example.invalid",
              models: [
                {
                  id: "fixture-image",
                  name: "Fixture image",
                  reasoning: false,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 1024,
                },
              ],
            },
          },
        };
      }
      const registry = createEmptyPluginRegistry();
      if (active) {
        registry.mediaUnderstandingProviders.push({
          pluginId: selected.pluginId,
          pluginName: "Selected fixture",
          source: selected.runtimeSource,
          provider: { id: providerId, capabilities: ["audio"] },
        });
      }

      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [selected, unrelated].map((fixture) => ({
          id: fixture.pluginId,
          origin: "global",
          rootDir: fixture.rootDir,
          source: fixture.runtimeSource,
          configSchema: { type: "object" },
          contracts: { mediaUnderstandingProviders: [fixture.providerId] },
        })),
      });
      const capabilities = withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry: registry },
        () => buildMediaUnderstandingCapabilityRegistry(config),
      );
      expect(capabilities.get(providerId)?.capabilities).toEqual(["audio"]);
      expect(fs.existsSync(unrelated.runtimeMarker)).toBe(false);
      expect(fs.existsSync(selected.runtimeMarker)).toBe(!active);
    },
  );
});
