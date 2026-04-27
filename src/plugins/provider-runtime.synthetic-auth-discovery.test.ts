import { describe, expect, it, vi } from "vitest";

const resolveProviderRuntimePlugin = vi.hoisted(() => vi.fn(() => undefined));
const resolvePluginDiscoveryProvidersRuntime = vi.hoisted(() =>
  vi.fn(() => [
    {
      id: "anthropic-vertex",
      label: "Anthropic Vertex",
      auth: [],
      resolveSyntheticAuth: () => ({
        apiKey: "gcp-vertex-credentials",
        source: "gcp-vertex-credentials (ADC)",
        mode: "api-key" as const,
      }),
    },
    {
      id: "ollama",
      label: "Ollama",
      auth: [],
      resolveSyntheticAuth: ({
        provider,
        providerConfig,
      }: {
        provider: string;
        providerConfig?: { api?: string; baseUrl?: string };
      }) =>
        providerConfig?.api === "ollama" && providerConfig.baseUrl?.startsWith("http://10.")
          ? {
              apiKey: "ollama-local",
              source: `models.providers.${provider} (synthetic local key)`,
              mode: "api-key" as const,
            }
          : undefined,
    },
  ]),
);

vi.mock("./provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-hook-runtime.js")>();
  return {
    ...actual,
    __testing: {},
    clearProviderRuntimeHookCache: vi.fn(),
    prepareProviderExtraParams: vi.fn(),
    resetProviderRuntimeHookCacheForTest: vi.fn(),
    resolveProviderHookPlugin: vi.fn(),
    resolveProviderPluginsForHooks: vi.fn(() => []),
    resolveProviderRuntimePlugin,
    wrapProviderStreamFn: vi.fn(),
  };
});

vi.mock("./provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime,
}));

vi.mock("./providers.js", () => ({
  resolveCatalogHookProviderPluginIds: vi.fn(() => []),
  resolveExternalAuthProfileCompatFallbackPluginIds: vi.fn(() => []),
  resolveExternalAuthProfileProviderPluginIds: vi.fn(() => []),
  resolveOwningPluginIdsForProvider: vi.fn(({ provider }: { provider: string }) =>
    provider === "ollama"
      ? ["ollama"]
      : provider === "anthropic-vertex"
        ? ["anthropic-vertex"]
        : [],
  ),
}));

import { resolveProviderSyntheticAuthWithPlugin } from "./provider-runtime.js";

describe("resolveProviderSyntheticAuthWithPlugin", () => {
  it("falls back to lightweight discovery providers when runtime hooks are unavailable", () => {
    expect(
      resolveProviderSyntheticAuthWithPlugin({
        provider: "anthropic-vertex",
        context: {
          config: undefined,
          provider: "anthropic-vertex",
          providerConfig: undefined,
        },
      }),
    ).toEqual({
      apiKey: "gcp-vertex-credentials",
      source: "gcp-vertex-credentials (ADC)",
      mode: "api-key",
    });
    expect(resolveProviderRuntimePlugin).not.toHaveBeenCalled();
    expect(resolvePluginDiscoveryProvidersRuntime).toHaveBeenCalled();
  });

  it("uses the configured provider api as the synthetic-auth hook owner", () => {
    expect(
      resolveProviderSyntheticAuthWithPlugin({
        provider: "ollama-remote",
        context: {
          config: undefined,
          provider: "ollama-remote",
          providerConfig: {
            api: "ollama",
            baseUrl: "http://10.0.0.8:11434",
            apiKey: "ollama-local",
            models: [],
          },
        },
      }),
    ).toEqual({
      apiKey: "ollama-local",
      source: "models.providers.ollama-remote (synthetic local key)",
      mode: "api-key",
    });
  });
});
