import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./provider-policy-api.js";

function createModel(compat?: ModelDefinitionConfig["compat"]): ModelDefinitionConfig {
  return {
    id: "synthetic-reasoning-model",
    name: "Synthetic reasoning model",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8_192,
    ...(compat ? { compat } : {}),
  };
}

describe("lmstudio lightweight provider policy", () => {
  it("normalizes saved reasoning metadata without changing endpoint or transport settings", () => {
    const legacyModel = createModel({
      codeMode: "preferred",
      supportsTools: true,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["off", "on"],
      reasoningEffortMap: { off: "off", high: "on" },
    });
    const unchangedModel = createModel({ codeMode: "capable" });
    const request = {
      allowPrivateNetwork: false,
      headers: { "X-Synthetic-Request": "synthetic" },
    };
    const headers = { "X-Synthetic-Provider": "synthetic" };
    const providerConfig: ModelProviderConfig = {
      baseUrl: "http://lmstudio.internal:1234/api/v1/",
      api: "openai-completions",
      headers,
      request,
      params: { preserveCustomSetting: true },
      models: [legacyModel, unchangedModel],
    };

    const normalized = normalizeConfig({ provider: "lmstudio", providerConfig });

    expect(normalized).toEqual({
      ...providerConfig,
      models: [
        {
          ...legacyModel,
          compat: {
            ...legacyModel.compat,
            supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
            reasoningEffortMap: {
              off: "none",
              none: "none",
              adaptive: "xhigh",
              max: "xhigh",
            },
          },
        },
        unchangedModel,
      ],
    });
    expect(normalized.baseUrl).toBe(providerConfig.baseUrl);
    expect(normalized.request).toBe(request);
    expect(normalized.headers).toBe(headers);
    expect(normalized.models[1]).toBe(unchangedModel);
    expect(legacyModel.compat?.supportedReasoningEfforts).toEqual(["off", "on"]);
  });

  it("preserves provider and model identities when saved reasoning is already canonical", () => {
    const models = [
      createModel({
        supportedReasoningEfforts: ["none", "low", "high"],
        reasoningEffortMap: { off: "none", high: "high" },
      }),
      createModel(),
    ];
    const providerConfig: ModelProviderConfig = {
      baseUrl: "http://localhost:1234/v1",
      models,
    };

    expect(normalizeConfig({ provider: "lmstudio", providerConfig })).toBe(providerConfig);
    expect(providerConfig.models).toBe(models);
  });

  it("ignores unrelated providers", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "http://localhost:1234/v1",
      models: [createModel({ supportedReasoningEfforts: ["off", "on"] })],
    };

    expect(normalizeConfig({ provider: "openai", providerConfig })).toBe(providerConfig);
  });

  it.each([undefined, null, [], "invalid"])(
    "leaves absent or malformed model compatibility metadata untouched: %j",
    (compat) => {
      const model = { ...createModel(), compat } as unknown as ModelDefinitionConfig;
      const providerConfig: ModelProviderConfig = {
        baseUrl: "http://localhost:1234/v1",
        models: [model],
      };

      expect(normalizeConfig({ provider: "lmstudio", providerConfig })).toBe(providerConfig);
      expect(providerConfig.models[0]).toBe(model);
    },
  );

  it("leaves partial provider declarations without model rows untouched", () => {
    const providerConfig = {
      baseUrl: "http://localhost:1234/v1",
    } as ModelProviderConfig;

    expect(normalizeConfig({ provider: "lmstudio", providerConfig })).toBe(providerConfig);
  });
});
