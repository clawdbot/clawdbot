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
    expect(resolveProviderRuntimePlugin).toHaveBeenCalled();
    expect(resolvePluginDiscoveryProvidersRuntime).toHaveBeenCalled();
  });
});
