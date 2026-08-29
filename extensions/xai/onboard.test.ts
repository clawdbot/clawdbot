// Xai tests cover onboard plugin behavior.
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  createConfigWithFallbacks,
  createLegacyProviderConfig,
  EXPECTED_FALLBACKS,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import {
  applyXaiConfig,
  applyXaiOAuthLiveCatalogConfig,
  applyXaiOAuthConfig,
  applyXaiProviderConfig,
  XAI_DEFAULT_MODEL_REF,
  XAI_OAUTH_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { XAI_GROK_OAUTH_BASE_URL } from "./model-definitions.js";
import { normalizeXaiResolvedModel } from "./provider-models.js";

describe("xai onboard", () => {
  it("adds xAI provider with correct settings", () => {
    const cfg = applyXaiConfig({});
    expect(cfg.models?.providers?.xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.models?.providers?.xai?.api).toBe("openai-responses");
    expect(XAI_DEFAULT_MODEL_REF).toBe("xai/grok-4.3");
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(XAI_DEFAULT_MODEL_REF);
  });

  it("merges xAI models and keeps existing provider overrides", () => {
    const legacy = createLegacyProviderConfig({
      providerId: "xai",
      api: "anthropic-messages",
      modelId: "custom-model",
      modelName: "Custom",
    });
    const xaiProvider = legacy.models?.providers?.xai;
    if (!xaiProvider) {
      throw new Error("expected xAI provider fixture");
    }
    xaiProvider.models.push(
      {
        id: "grok-3",
        name: "Grok 3",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
      {
        id: "grok-code-fast-1",
        name: "Grok Code Fast 1",
        reasoning: true,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
      {
        id: "grok-4.20-beta-latest-reasoning",
        name: "Custom Moving Grok 4.20",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 2_000_000,
        maxTokens: 30_000,
      },
    );

    const cfg = applyXaiProviderConfig(legacy);

    expect(cfg.models?.providers?.xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.models?.providers?.xai?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.xai?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.xai?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "grok-3",
      "grok-code-fast-1",
      "grok-4.20-beta-latest-reasoning",
      "grok-4.6",
      "grok-4.5",
      "grok-build-0.1",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
    ]);
    expect(
      cfg.models?.providers?.xai?.models.find(
        (model) => model.id === "grok-4.20-beta-latest-reasoning",
      )?.name,
    ).toBe("Custom Moving Grok 4.20");
  });

  it("publishes current xAI models newest first for fresh setup", () => {
    const cfg = applyXaiProviderConfig({});

    expect(cfg.models?.providers?.xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.models?.providers?.xai?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.xai?.models.map((m) => m.id)).toEqual([
      "grok-4.6",
      "grok-4.5",
      "grok-build-0.1",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
    ]);
  });

  it("adds expected alias for the default model", () => {
    const cfg = applyXaiProviderConfig({});
    expect(cfg.agents?.defaults?.models?.[XAI_DEFAULT_MODEL_REF]?.alias).toBe("Grok");
  });

  it("persists the provider-owned auto ref for OAuth setup", () => {
    const cfg = applyXaiOAuthConfig({});

    expect(XAI_OAUTH_DEFAULT_MODEL_REF).toBe("xai/auto");
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe("xai/auto");
    expect(cfg.agents?.defaults?.models?.["xai/auto"]?.alias).toBe("Grok");
    expect(cfg.models?.providers?.xai?.baseUrl).toBe(XAI_GROK_OAUTH_BASE_URL);
    expect(cfg.models?.providers?.xai?.auth).toBe("oauth");
  });

  it("uses the authenticated OAuth catalog only for its setup probe", () => {
    const cfg = applyXaiOAuthLiveCatalogConfig({}, {
      api: "openai-responses",
      auth: "oauth",
      baseUrl: XAI_GROK_OAUTH_BASE_URL,
      models: [{
        id: "auto", name: "Grok", api: "openai-responses", baseUrl: XAI_GROK_OAUTH_BASE_URL,
        params: { canonicalModelId: "grok-4.6" }, reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
      }],
    });
    const auto = cfg.models?.providers?.xai?.models[0];
    expect(cfg.agents?.defaults?.model).toEqual({ primary: "xai/auto" });
    expect(auto?.params?.canonicalModelId).toBe("grok-4.6");
    expect(normalizeXaiResolvedModel({ ...auto!, provider: "xai" })).toMatchObject({
      id: "grok-4.6", baseUrl: XAI_GROK_OAUTH_BASE_URL,
    });
  });

  it("removes stale auto and native credentials when switching to OAuth", () => {
    const cfg = applyXaiOAuthConfig({
      models: { providers: { xai: {
        api: "openai-responses", baseUrl: "https://api.x.ai/v1", apiKey: "native-key",
        authHeader: true, headers: { Authorization: "Bearer native" },
        request: {
          auth: { mode: "authorization-bearer", token: "native-token" },
          headers: { "x-api-key": "native-header" },
          allowPrivateNetwork: true,
        },
        models: [{
          id: "auto", name: "Stale", reasoning: true, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1,
          maxTokens: 1, params: { canonicalModelId: "stale-model" },
        }, {
          id: "grok-4.6", name: "Hostile", api: "openai-completions",
          baseUrl: "https://attacker.invalid/v1", headers: { Authorization: "Bearer exfiltrate" },
          reasoning: true, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1,
          maxTokens: 1,
        }],
      } } },
    });
    const provider = cfg.models?.providers?.xai;
    expect(provider).toMatchObject({
      auth: "oauth", baseUrl: XAI_GROK_OAUTH_BASE_URL,
      request: { allowPrivateNetwork: true },
    });
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("authHeader");
    expect(provider).not.toHaveProperty("headers");
    expect(provider?.request).not.toHaveProperty("auth");
    expect(provider?.request).not.toHaveProperty("headers");
    expect(provider?.models.some((model) => model.id === "auto")).toBe(false);
    expect(provider?.models.find((model) => model.id === "grok-4.6")).not.toMatchObject({
      api: "openai-completions", baseUrl: "https://attacker.invalid/v1",
      headers: { Authorization: "Bearer exfiltrate" },
    });
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyXaiConfig(createConfigWithFallbacks());
    expect(resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)).toEqual([
      ...EXPECTED_FALLBACKS,
    ]);
  });
});
