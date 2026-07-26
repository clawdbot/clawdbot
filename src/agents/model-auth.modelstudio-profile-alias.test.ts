/**
 * End-to-end profile resolution for legacy modelstudio profile ids (#84081).
 * Uses the bundled qwen manifest providerAuthAliases (not test mocks).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { pluginTestRepoRoot as repoRoot } from "../plugins/generated-plugin-test-helpers.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { resetProviderAuthAliasMapCacheForTest } from "./provider-auth-aliases.test-support.js";

function readQwenBundledManifest(): { providerAuthAliases?: Record<string, string> } {
  return JSON.parse(
    readFileSync(join(repoRoot, "extensions/qwen/openclaw.plugin.json"), "utf-8"),
  ) as { providerAuthAliases?: Record<string, string> };
}

function createQwenAliasSnapshot(cfg: OpenClawConfig): PluginMetadataSnapshot {
  const manifest = readQwenBundledManifest();
  const policyHash = resolveInstalledPluginIndexPolicyHash(cfg);
  const plugin: PluginManifestRecord = {
    id: "qwen",
    origin: "bundled",
    channels: [],
    providers: ["qwen", "modelstudio", "qwencloud", "dashscope"],
    cliBackends: [],
    skills: [],
    hooks: [],
    rootDir: join(repoRoot, "extensions/qwen"),
    source: join(repoRoot, "extensions/qwen"),
    manifestPath: join(repoRoot, "extensions/qwen/openclaw.plugin.json"),
    providerAuthAliases: manifest.providerAuthAliases,
  };
  return {
    policyHash,
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins: [plugin], diagnostics: [] },
    plugins: [plugin],
    diagnostics: [],
    byPluginId: new Map([[plugin.id, plugin]]),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 1,
      manifestPluginCount: 1,
    },
  };
}

const sharedCfg: OpenClawConfig = {
  models: {
    providers: {
      qwen: {
        api: "openai-completions",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [],
      },
      modelstudio: {
        api: "openai-completions",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [],
      },
    },
  },
};

describe("modelstudio profile alias resolution (#84081)", () => {
  beforeEach(() => {
    clearCurrentPluginMetadataSnapshot();
    resetProviderAuthAliasMapCacheForTest();
    setCurrentPluginMetadataSnapshot(createQwenAliasSnapshot(sharedCfg), { config: sharedCfg });
  });

  afterEach(() => {
    clearCurrentPluginMetadataSnapshot();
    resetProviderAuthAliasMapCacheForTest();
  });

  it("resolves modelstudio:default through production qwen manifest auth aliases", async () => {
    const manifest = readQwenBundledManifest();
    expect(manifest.providerAuthAliases?.modelstudio).toBe("qwen");
    expect(manifest.providerAuthAliases?.qwencloud).toBe("qwen");

    const resolved = await resolveApiKeyForProvider({
      provider: "modelstudio",
      profileId: "modelstudio:default",
      store: {
        version: 1,
        profiles: {
          "qwen:default": {
            type: "api_key",
            provider: "qwen",
            key: "qwen-key",
          },
        },
      },
      cfg: sharedCfg,
    });

    expect(resolved.apiKey).toBe("qwen-key");
    expect(resolved.profileId).toBe("qwen:default");
    expect(resolved.source).toBe("profile:qwen:default");
  });

  it("prefers explicit modelstudio:default credentials over alias fallback", async () => {
    const resolved = await resolveApiKeyForProvider({
      provider: "modelstudio",
      profileId: "modelstudio:default",
      store: {
        version: 1,
        profiles: {
          "modelstudio:default": {
            type: "api_key",
            provider: "modelstudio",
            key: "modelstudio-key",
          },
          "qwen:default": {
            type: "api_key",
            provider: "qwen",
            key: "qwen-key",
          },
        },
      },
      cfg: sharedCfg,
    });

    expect(resolved.apiKey).toBe("modelstudio-key");
    expect(resolved.profileId).toBe("modelstudio:default");
  });
});
