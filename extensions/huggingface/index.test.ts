import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import {
  buildManifestModelProviderConfig,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const bundledProvider = {
  baseUrl: "https://router.huggingface.co/v1",
  api: "openai-completions",
  models: [
    { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", contextWindow: 131072 },
    { id: "deepseek-ai/DeepSeek-V3.1", name: "DeepSeek V3.1" },
    { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B" },
  ],
};

function registerProvider() {
  const register = vi.fn<NonNullable<TestPluginApiInput["registerProvider"]>>();
  plugin.register(createTestPluginApi({ registerProvider: register }));
  return register.mock.calls[0]?.[0];
}

describe("huggingface plugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes the bundled catalog to manifest-only model selection", () => {
    expect(
      buildManifestModelProviderConfig({
        providerId: "huggingface",
        catalog: manifest.modelCatalog.providers.huggingface,
      }),
    ).toMatchObject(bundledProvider);
  });

  it.each([
    { label: "no key is configured", config: {}, apiKey: undefined },
    {
      label: "discovery is disabled",
      config: {
        plugins: {
          entries: { huggingface: { config: { discovery: { enabled: false } } } },
        },
      },
      apiKey: "hf_test_token",
    },
  ])("keeps the bundled catalog offline when $label", async ({ config, apiKey }) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const resolveProviderApiKey = vi.fn(() => ({ apiKey, discoveryApiKey: apiKey }));
    const context: ProviderCatalogContext = {
      config,
      env: {},
      resolveProviderApiKey,
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const provider = registerProvider();

    await expect(provider?.catalog?.run(context)).resolves.toBeNull();
    resolveProviderApiKey.mockClear();
    const result = await provider?.staticCatalog?.run(context);

    expect(result).toMatchObject({ provider: bundledProvider });
    expect(result).not.toHaveProperty("provider.apiKey");
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
