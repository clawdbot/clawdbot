import { describe, expect, it } from "vitest";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "../plugins/bundled-compat.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginRegistrySnapshot } from "../plugins/plugin-registry.js";
import { resolveEnabledProviderPluginIds } from "../plugins/providers.js";

const PROVIDER_PLUGIN_IDS = ["kilocode", "moonshot", "openrouter"] as const;

function createProviderManifestRecord(pluginId: string): PluginManifestRecord {
  return {
    id: pluginId,
    channels: [],
    providers: [pluginId],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/virtual/${pluginId}`,
    source: `/virtual/${pluginId}/index.ts`,
    manifestPath: `/virtual/${pluginId}/openclaw.plugin.json`,
  };
}

function createProviderRegistryRecord(pluginId: string): PluginRegistrySnapshot["plugins"][number] {
  return {
    pluginId,
    manifestPath: `/virtual/${pluginId}/openclaw.plugin.json`,
    manifestHash: `${pluginId}-manifest-hash`,
    rootDir: `/virtual/${pluginId}`,
    origin: "bundled",
    enabled: true,
    enabledByDefault: true,
    startup: {
      sidecar: false,
      memory: false,
      deferConfiguredChannelFullLoadUntilAfterListen: false,
      agentHarnesses: [],
    },
    compat: [],
  };
}

const providerRegistry: PluginRegistrySnapshot = {
  version: 1,
  hostContractVersion: "2026.4.25",
  compatRegistryVersion: "compat-v1",
  migrationVersion: 1,
  policyHash: "policy-v1",
  generatedAtMs: 1777118400000,
  installRecords: {},
  plugins: PROVIDER_PLUGIN_IDS.map(createProviderRegistryRecord),
  diagnostics: [],
};

const providerManifestRegistry: PluginManifestRegistry = {
  plugins: PROVIDER_PLUGIN_IDS.map(createProviderManifestRecord),
  diagnostics: [],
};

describe("implicit provider plugin allowlist compatibility", () => {
  it("keeps bundled implicit providers discoverable in explicit compat mode", () => {
    const config = withBundledPluginEnablementCompat({
      config: withBundledPluginAllowlistCompat({
        config: {
          plugins: {
            allow: ["openrouter"],
            bundledDiscovery: "compat",
          },
        },
        pluginIds: ["kilocode", "moonshot"],
      }),
      pluginIds: ["kilocode", "moonshot"],
    });

    expect(
      resolveEnabledProviderPluginIds({
        config,
        registry: providerRegistry,
        manifestRegistry: providerManifestRegistry,
        onlyPluginIds: PROVIDER_PLUGIN_IDS,
      }),
    ).toEqual(["kilocode", "moonshot", "openrouter"]);
  });

  it("respects allowlist for bundled plugins by default", () => {
    const config = withBundledPluginEnablementCompat({
      config: withBundledPluginAllowlistCompat({
        config: {
          plugins: {
            allow: ["openrouter"],
          },
        },
        pluginIds: ["kilocode", "moonshot"],
      }),
      pluginIds: ["kilocode", "moonshot"],
    });

    expect(
      resolveEnabledProviderPluginIds({
        config,
        registry: providerRegistry,
        manifestRegistry: providerManifestRegistry,
        onlyPluginIds: PROVIDER_PLUGIN_IDS,
      }),
    ).toEqual(["openrouter"]);
  });

  it("respects allowlist for bundled plugins when bundledDiscovery is allowlist", () => {
    const config = withBundledPluginEnablementCompat({
      config: withBundledPluginAllowlistCompat({
        config: {
          plugins: {
            allow: ["openrouter"],
            bundledDiscovery: "allowlist",
          },
        },
        pluginIds: ["kilocode", "moonshot"],
      }),
      pluginIds: ["kilocode", "moonshot"],
    });

    expect(
      resolveEnabledProviderPluginIds({
        config,
        registry: providerRegistry,
        manifestRegistry: providerManifestRegistry,
        onlyPluginIds: PROVIDER_PLUGIN_IDS,
      }),
    ).toEqual(["openrouter"]);
  });

  it("does not re-enable plugins when allowlist mode rejects every compat plugin", () => {
    const config = withBundledPluginEnablementCompat({
      config: {
        plugins: {
          enabled: false,
          allow: ["openrouter"],
          bundledDiscovery: "allowlist",
        },
      },
      pluginIds: ["kilocode", "moonshot"],
    });

    expect(config).toEqual({
      plugins: {
        enabled: false,
        allow: ["openrouter"],
        bundledDiscovery: "allowlist",
      },
    });
  });

  it("re-enables globally disabled plugins when allowlist mode accepts a plugin alias", () => {
    const config = withBundledPluginEnablementCompat({
      config: {
        plugins: {
          enabled: false,
          allow: [" Google-Gemini-Cli "],
          bundledDiscovery: "allowlist",
        },
      },
      pluginIds: ["google"],
    });

    expect(config).toEqual({
      plugins: {
        enabled: true,
        allow: [" Google-Gemini-Cli "],
        bundledDiscovery: "allowlist",
        entries: {
          google: { enabled: true },
        },
      },
    });
  });

  it("still honors explicit plugin denies over compat allowlist injection", () => {
    const config = withBundledPluginEnablementCompat({
      config: withBundledPluginAllowlistCompat({
        config: {
          plugins: {
            allow: ["openrouter"],
            bundledDiscovery: "compat",
            deny: ["kilocode"],
          },
        },
        pluginIds: ["kilocode", "moonshot"],
      }),
      pluginIds: ["kilocode", "moonshot"],
    });

    expect(
      resolveEnabledProviderPluginIds({
        config,
        registry: providerRegistry,
        manifestRegistry: providerManifestRegistry,
        onlyPluginIds: PROVIDER_PLUGIN_IDS,
      }),
    ).toEqual(["moonshot", "openrouter"]);
  });
});
