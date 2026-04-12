import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "./manifest-registry.js";

const mocks = vi.hoisted(() => ({
  findBundledPluginMetadataById: vi.fn(),
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("./bundled-plugin-metadata.js", () => ({
  findBundledPluginMetadataById: mocks.findBundledPluginMetadataById,
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

import { resolvePluginConfigContractsById } from "./config-contracts.js";

function createRegistry(plugins: PluginManifestRegistry["plugins"]): PluginManifestRegistry {
  return {
    plugins,
    diagnostics: [],
  };
}

describe("resolvePluginConfigContractsById", () => {
  beforeEach(() => {
    mocks.findBundledPluginMetadataById.mockReset();
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue(createRegistry([]));
  });

  it("does not fall back to bundled metadata when registry already resolved a plugin without config contracts", () => {
    mocks.loadPluginManifestRegistry.mockReturnValue(
      createRegistry([
        {
          id: "brave",
          origin: "bundled",
          rootDir: "/tmp/brave",
          manifestPath: "/tmp/brave/openclaw.plugin.json",
          channelConfigs: undefined,
          providerAuthEnvVars: undefined,
          configUiHints: undefined,
          configSchema: undefined,
          configContracts: undefined,
          contracts: undefined,
          name: undefined,
          description: undefined,
          version: undefined,
          enabledByDefault: undefined,
          autoEnableWhenConfiguredProviders: undefined,
          legacyPluginIds: undefined,
          format: undefined,
          bundleFormat: undefined,
          bundleCapabilities: undefined,
          kind: undefined,
          channels: [],
          providers: [],
          modelSupport: undefined,
          cliBackends: [],
          channelEnvVars: undefined,
          providerAuthAliases: undefined,
          providerAuthChoices: undefined,
          skills: [],
          settingsFiles: undefined,
          hooks: [],
          source: "/tmp/brave/openclaw.plugin.json",
          setupSource: undefined,
          startupDeferConfiguredChannelFullLoadUntilAfterListen: undefined,
          channelCatalogMeta: undefined,
        },
      ]),
    );

    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["brave"],
      }),
    ).toEqual(new Map());
    expect(mocks.findBundledPluginMetadataById).not.toHaveBeenCalled();
  });

  it("can skip bundled metadata fallback for registry-scoped callers", () => {
    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["missing"],
        fallbackToBundledMetadata: false,
      }),
    ).toEqual(new Map());
    expect(mocks.findBundledPluginMetadataById).not.toHaveBeenCalled();
  });
});
