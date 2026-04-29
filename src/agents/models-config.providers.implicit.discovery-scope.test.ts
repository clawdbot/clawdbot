import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderPlugin } from "../plugins/types.js";

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderCatalog: vi.fn(),
}));

vi.mock("../plugins/provider-discovery.js", () => ({
  resolveRuntimePluginDiscoveryProviders: mocks.resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog: mocks.runProviderCatalog,
  groupPluginDiscoveryProvidersByOrder: (providers: ProviderPlugin[]) => ({
    simple: providers,
    profile: [],
    paired: [],
    late: [],
  }),
  normalizePluginDiscoveryResult: ({
    provider,
    result,
  }: {
    provider: ProviderPlugin;
    result?: { provider?: unknown; providers?: Record<string, unknown> } | null;
  }) => result?.providers ?? (result?.provider ? { [provider.id]: result.provider } : {}),
}));

import { resolveImplicitProviders } from "./models-config.providers.implicit.js";

function metadataOwners(
  overrides: Partial<PluginMetadataSnapshotOwnerMaps>,
): PluginMetadataSnapshotOwnerMaps {
  return {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    ...overrides,
  };
}

function createProvider(id: string): ProviderPlugin {
  return {
    id,
    label: id,
    auth: [],
    catalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

describe("resolveImplicitProviders startup discovery scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("openai")]);
    mocks.runProviderCatalog.mockResolvedValue({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [],
        },
      },
    });
  });

  it("passes startup provider scopes as plugin owner filters", async () => {
    await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {},
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {},
      pluginMetadataSnapshot: {
        index: { plugins: [] } as never,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: metadataOwners({
          providers: new Map([["openai", ["openai"]]]),
        }),
      },
      providerDiscoveryProviderIds: ["openai"],
      providerDiscoveryTimeoutMs: 1234,
    });

    expect(mocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["openai"],
      }),
    );
    expect(mocks.runProviderCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1234,
      }),
    );
  });

  it("can keep startup discovery on provider discovery entries only", async () => {
    await resolveImplicitProviders({
      agentDir: "/tmp/openclaw-agent",
      config: {},
      env: {} as NodeJS.ProcessEnv,
      explicitProviders: {},
      providerDiscoveryEntriesOnly: true,
    });

    expect(mocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveryEntriesOnly: true,
      }),
    );
  });
});
