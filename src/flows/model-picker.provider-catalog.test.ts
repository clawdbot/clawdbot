// Model picker provider catalog tests cover catalog-driven provider options.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin } from "../plugins/types.js";

function textModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

const providerDiscoveryMocks = vi.hoisted(() => ({
  resolveRuntimePluginDiscoveryProviders: vi.fn<() => Promise<ProviderPlugin[]>>(),
  runProviderCatalog: vi.fn(
    async ({ provider, ...ctx }: { provider: ProviderPlugin } & Record<string, unknown>) =>
      provider.catalog?.run(ctx as never),
  ),
  normalizePluginDiscoveryResult: vi.fn(
    ({
      provider,
      result,
    }: {
      provider: ProviderPlugin;
      result:
        | { provider: { models?: unknown[] } }
        | { providers: Record<string, { models?: unknown[] }> }
        | null
        | undefined;
    }) => {
      if (!result) {
        return {};
      }
      if ("provider" in result) {
        return { [provider.id]: result.provider };
      }
      return result.providers;
    },
  ),
  groupPluginDiscoveryProvidersByOrder: vi.fn((providers: ProviderPlugin[]) => ({
    simple: providers,
    profile: [],
    paired: [],
    late: [],
  })),
}));

const providersRuntimeMocks = vi.hoisted(() => ({
  resolvePluginProviders: vi.fn<() => ProviderPlugin[]>(),
}));

const providerCatalogListMocks = vi.hoisted(() => ({
  resolveProviderCatalogPluginIdsForFilter: vi.fn(async () => ["nvidia"]),
}));

vi.mock("../plugins/provider-discovery.js", () => providerDiscoveryMocks);
vi.mock("../plugins/providers.runtime.js", () => providersRuntimeMocks);
vi.mock("../commands/models/list.provider-catalog.js", () => providerCatalogListMocks);
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ profiles: {} })),
}));

const { loadPreferredProviderPickerCatalog } = await import("./model-picker.provider-catalog.js");

describe("loadPreferredProviderPickerCatalog", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the full live provider when manifest static discovery masks the runtime catalog", async () => {
    const manifestStaticProvider = {
      id: "nvidia",
      label: "nvidia",
      auth: [],
      staticCatalog: {
        run: async () => ({
          provider: {
            baseUrl: "https://static.invalid/v1",
            models: [textModel("minimaxai/minimax-m2.5", "Static MiniMax M2.5")],
          },
        }),
      },
    } satisfies ProviderPlugin;
    const liveProvider = {
      id: "nvidia",
      label: "NVIDIA",
      envVars: ["NVIDIA_API_KEY"],
      auth: [],
      catalog: {
        run: async (ctx) => {
          expect(ctx.resolveProviderApiKey("nvidia")).toEqual({
            apiKey: "nvapi-test",
            discoveryApiKey: "nvapi-test",
          });
          return {
            provider: {
              baseUrl: "https://integrate.api.nvidia.com/v1",
              models: [
                textModel("nvidia/nemotron-3-super-120b-a12b", "Nemotron"),
                textModel("minimaxai/minimax-m2.7", "MiniMax M2.7"),
              ],
            },
          };
        },
      },
    } satisfies ProviderPlugin;
    providerDiscoveryMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      manifestStaticProvider,
    ]);
    providersRuntimeMocks.resolvePluginProviders.mockReturnValue([liveProvider]);

    const rows = await loadPreferredProviderPickerCatalog({
      cfg: {} as OpenClawConfig,
      preferredProvider: "nvidia",
      env: { NVIDIA_API_KEY: "nvapi-test" },
    });

    expect(rows.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "nvidia/nvidia/nemotron-3-super-120b-a12b",
      "nvidia/minimaxai/minimax-m2.7",
    ]);
    expect(rows.map((entry) => entry.id)).not.toContain("minimaxai/minimax-m2.5");
    expect(providersRuntimeMocks.resolvePluginProviders).toHaveBeenCalledWith({
      config: {},
      env: { NVIDIA_API_KEY: "nvapi-test" },
      onlyPluginIds: ["nvidia"],
      includeUntrustedWorkspacePlugins: false,
      mode: "setup",
      activate: false,
      cache: false,
    });
  });
});
