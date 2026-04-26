import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { applyProviderNativeStreamingUsageCompat } from "../plugin-sdk/provider-catalog-shared.js";
import { resolveMissingProviderApiKey } from "./models-config.providers.secret-helpers.js";

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProvider: () => undefined,
}));

vi.mock("../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: () => [],
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("./model-auth-env-vars.js", () => {
  const candidates = {
    moonshot: ["MOONSHOT_API_KEY"],
  } as const;
  return {
    PROVIDER_ENV_API_KEY_CANDIDATES: candidates,
    listKnownProviderEnvApiKeyNames: () => [...new Set(Object.values(candidates).flat())],
    resolveProviderEnvApiKeyCandidates: () => candidates,
  };
});

vi.mock("../plugin-sdk/provider-http.js", () => ({
  resolveProviderRequestCapabilities: (params: { provider: string; baseUrl?: string }) => ({
    supportsNativeStreamingUsageCompat:
      params.provider === "moonshot" && params.baseUrl === "https://api.moonshot.cn/v1",
  }),
}));

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";

function buildMoonshotProvider(): ModelProviderConfig {
  return {
    baseUrl: MOONSHOT_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
      },
    ],
  };
}

describe("moonshot implicit provider (#33637)", () => {
  it("uses explicit CN baseUrl when provided", () => {
    const provider = {
      ...buildMoonshotProvider(),
      baseUrl: MOONSHOT_CN_BASE_URL,
    };

    expect(provider.baseUrl).toBe(MOONSHOT_CN_BASE_URL);
    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
    expect(
      applyProviderNativeStreamingUsageCompat({
        providerId: "moonshot",
        providerConfig: provider,
      }).models?.[0]?.compat?.supportsUsageInStreaming,
    ).toBe(true);
  });

  it("keeps streaming usage opt-in unset before the final compat pass", () => {
    const provider = {
      ...buildMoonshotProvider(),
      baseUrl: "https://proxy.example.com/v1",
    };

    expect(provider.baseUrl).toBe("https://proxy.example.com/v1");
    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
    expect(
      applyProviderNativeStreamingUsageCompat({
        providerId: "moonshot",
        providerConfig: provider,
      }).models?.[0]?.compat?.supportsUsageInStreaming,
    ).toBeUndefined();
  });

  it("includes moonshot when MOONSHOT_API_KEY is configured", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "moonshot",
      provider: buildMoonshotProvider(),
      env: { MOONSHOT_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });

    expect(provider.apiKey).toBe("MOONSHOT_API_KEY");
    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
  });
});
