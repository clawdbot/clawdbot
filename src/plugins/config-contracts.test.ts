import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "./manifest-registry.js";

const mocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  return {
    discoverOpenClawPlugins: vi.fn(() => ({ candidates: [], diagnostics: [] })),
    loadBundledManifestRegistry: vi.fn(),
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  };
});

vi.mock("./discovery.js", () => ({
  discoverOpenClawPlugins: mocks.discoverOpenClawPlugins,
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadBundledManifestRegistry,
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: mocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: mocks.loadPluginRegistrySnapshot,
}));

import { resolvePluginConfigContractsById } from "./config-contracts.js";

type PluginManifestRecord = PluginManifestRegistry["plugins"][number];

function createRegistry(plugins: PluginManifestRegistry["plugins"]): PluginManifestRegistry {
  return {
    plugins,
    diagnostics: [],
  };
}

function createPluginRecord(
  overrides: Pick<PluginManifestRecord, "id" | "origin"> & Partial<PluginManifestRecord>,
): PluginManifestRecord {
  return {
    rootDir: `/tmp/${overrides.id}`,
    manifestPath: `/tmp/${overrides.id}/openclaw.plugin.json`,
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
    source: `/tmp/${overrides.id}/openclaw.plugin.json`,
    setupSource: undefined,
    startupDeferConfiguredChannelFullLoadUntilAfterListen: undefined,
    channelCatalogMeta: undefined,
    ...overrides,
  };
}

describe("resolvePluginConfigContractsById", () => {
  beforeEach(() => {
    mocks.discoverOpenClawPlugins.mockReset();
    mocks.discoverOpenClawPlugins.mockReturnValue({ candidates: [], diagnostics: [] });
    mocks.loadBundledManifestRegistry.mockReset();
    mocks.loadBundledManifestRegistry.mockReturnValue(createRegistry([]));
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(createRegistry([]));
    mocks.loadPluginRegistrySnapshot.mockReset();
    mocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
  });

  it("does not fall back to bundled registry when registry already resolved a plugin without config contracts", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createRegistry([
        createPluginRecord({
          id: "brave",
          origin: "bundled",
        }),
      ]),
    );

    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["brave"],
      }),
    ).toEqual(new Map());
    expect(mocks.loadBundledManifestRegistry).not.toHaveBeenCalled();
  });

  it("can hydrate missing contracts from bundled registry for resolved bundled plugins", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createRegistry([
        createPluginRecord({
          id: "voice-call",
          origin: "bundled",
          configContracts: {
            compatibilityMigrationPaths: ["plugins.entries.voice-call.config"],
          },
        }),
      ]),
    );
    mocks.loadBundledManifestRegistry.mockReturnValue(
      createRegistry([
        createPluginRecord({
          id: "voice-call",
          origin: "bundled",
          configContracts: {
            secretInputs: {
              paths: [{ path: "twilio.authToken", expected: "string" }],
            },
          },
        }),
      ]),
    );

    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["voice-call"],
        fallbackToBundledMetadataForResolvedBundled: true,
      }),
    ).toEqual(
      new Map([
        [
          "voice-call",
          {
            origin: "bundled",
            configContracts: {
              compatibilityMigrationPaths: ["plugins.entries.voice-call.config"],
              secretInputs: {
                paths: [{ path: "twilio.authToken", expected: "string" }],
              },
            },
          },
        ],
      ]),
    );
  });

  it("refreshes stale bundled SecretInput contracts from bundled registry", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createRegistry([
        createPluginRecord({
          id: "voice-call",
          origin: "bundled",
          configContracts: {
            compatibilityMigrationPaths: ["plugins.entries.voice-call.config"],
            secretInputs: {
              paths: [{ path: "twilio.authToken", expected: "string" }],
            },
          },
        }),
      ]),
    );
    mocks.loadBundledManifestRegistry.mockReturnValue(
      createRegistry([
        createPluginRecord({
          id: "voice-call",
          origin: "bundled",
          configContracts: {
            secretInputs: {
              paths: [
                { path: "twilio.authToken", expected: "string" },
                { path: "realtime.providers.*.apiKey", expected: "string" },
              ],
            },
          },
        }),
      ]),
    );

    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["voice-call"],
        fallbackToBundledMetadataForResolvedBundled: true,
      }),
    ).toEqual(
      new Map([
        [
          "voice-call",
          {
            origin: "bundled",
            configContracts: {
              compatibilityMigrationPaths: ["plugins.entries.voice-call.config"],
              secretInputs: {
                paths: [
                  { path: "twilio.authToken", expected: "string" },
                  { path: "realtime.providers.*.apiKey", expected: "string" },
                ],
              },
            },
          },
        ],
      ]),
    );
  });

  it("can hydrate missing contracts for plugin ids known to be bundled by runtime discovery", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createRegistry([
        createPluginRecord({
          id: "voice-call",
          origin: "config",
        }),
      ]),
    );
    mocks.loadBundledManifestRegistry.mockReturnValue(
      createRegistry([
        createPluginRecord({
          id: "voice-call",
          origin: "bundled",
          configContracts: {
            secretInputs: {
              paths: [{ path: "tts.providers.*.apiKey", expected: "string" }],
            },
          },
        }),
      ]),
    );

    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["voice-call"],
        fallbackBundledPluginIds: ["voice-call"],
      }),
    ).toEqual(
      new Map([
        [
          "voice-call",
          {
            origin: "bundled",
            configContracts: {
              secretInputs: {
                paths: [{ path: "tts.providers.*.apiKey", expected: "string" }],
              },
            },
          },
        ],
      ]),
    );
  });

  it("can skip bundled metadata fallback for registry-scoped callers", () => {
    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["missing"],
        fallbackToBundledMetadata: false,
      }),
    ).toEqual(new Map());
    expect(mocks.loadBundledManifestRegistry).not.toHaveBeenCalled();
  });
});
