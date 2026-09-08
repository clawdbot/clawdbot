import { calculateCost } from "openclaw/plugin-sdk/llm";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

function modelRegistry(
  models: ProviderRuntimeModel[] = [],
): ProviderResolveDynamicModelContext["modelRegistry"] {
  return {
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    getAll: () => models,
    getAvailable: () => models,
    hasConfiguredAuth: () => false,
  };
}

const preferredModels = [
  { id: "gpt-5.6", cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
  { id: "gpt-5.6-sol", cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
  { id: "gpt-5.6-terra", cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 } },
  { id: "gpt-5.6-luna", cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 } },
  { id: "gpt-5.5", cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },
  { id: "gpt-5.5-pro", cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 } },
];

describe("OpenAI dynamic model capabilities", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { promptTokens: 272_000, inputRate: 10, output: 0.05, cacheRead: 0.0005, cacheWrite: 0.00625 },
    { promptTokens: 272_001, inputRate: 20, output: 0.075, cacheRead: 0.001, cacheWrite: 0.0125 },
  ])(
    "prices Astra's full request at $promptTokens input tokens",
    ({ promptTokens, inputRate, ...expected }) => {
      const model = buildOpenAIProvider().resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-6-astra",
        modelRegistry: modelRegistry(),
      });
      if (!model) {
        throw new Error("Astra must resolve before pricing");
      }
      const usage = {
        input: promptTokens - 1_000,
        output: 1_000,
        cacheRead: 500,
        cacheWrite: 500,
        totalTokens: promptTokens + 1_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const cost = calculateCost(model, usage);
      expect(cost).toMatchObject(expected);
      expect(cost.input).toBeCloseTo((usage.input * inputRate) / 1_000_000);
    },
  );

  it.each(["openai-responses", "openai-chatgpt-responses"] as const)(
    "resolves GPT-6 Astra with its own capabilities over %s",
    (api) => {
      const model = buildOpenAIProvider().resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-6-astra",
        providerConfig: {
          api,
          baseUrl:
            api === "openai-responses"
              ? "https://api.openai.com/v1"
              : "https://chatgpt.com/backend-api/codex",
          models: [],
        },
        modelRegistry: modelRegistry(),
      });

      expect(model).toMatchObject({
        id: "gpt-6-astra",
        provider: "openai",
        api,
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_050_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: "max" },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
          supportsTemperature: false,
          codeMode: "preferred",
        },
      });
    },
  );

  it.each(preferredModels)(
    "retains preferred capabilities for $id without discovery",
    ({ id, cost }) => {
      const model = buildOpenAIProvider().resolveDynamicModel?.({
        provider: "openai",
        modelId: id,
        agentRuntimeId: "openclaw",
        modelRegistry: modelRegistry(),
      });

      expect(model).toMatchObject({
        id,
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_050_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
        cost,
        compat: { codeMode: "preferred" },
      });
      if (id.startsWith("gpt-5.6")) {
        expect(model?.thinkingLevelMap).toEqual({ off: "none", xhigh: "xhigh", max: "max" });
        expect(model?.compat).toMatchObject({
          supportsReasoningEffort: true,
          supportsTemperature: false,
          supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        });
      } else {
        expect(model?.mediaInput).toEqual({
          image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
        });
      }
    },
  );

  it.each([
    {
      id: "gpt-6-astra",
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      codeMode: "preferred",
    },
    {
      id: "gpt-5.6-sol",
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      codeMode: "capable",
    },
    {
      id: "gpt-5.6-terra",
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
      codeMode: "preferred",
    },
    {
      id: "gpt-5.6-luna",
      cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
      codeMode: undefined,
    },
  ] as const)("preserves exact registry metadata for $id", ({ id, cost, codeMode }) => {
    const provider = buildOpenAIProvider();
    const exactModel: ProviderRuntimeModel = {
      id,
      name: id,
      provider: "openai",
      api: "openai-completions",
      baseUrl: "https://proxy.example/v1",
      headers: { "X-Model-Route": "authored" },
      reasoning: true,
      input: ["text", "image"],
      cost,
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      compat: { supportedReasoningEfforts: ["registry-exact"], codeMode },
    };

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: id,
      modelRegistry: modelRegistry([exactModel]),
    });

    expect(model).toBe(exactModel);
  });

  it.each(["chat-latest", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano"])(
    "does not promote unpreferred %s without discovery",
    (modelId) => {
      const model = buildOpenAIProvider().resolveDynamicModel?.({
        provider: "openai",
        modelId,
        modelRegistry: modelRegistry(),
      });
      expect(model?.id).toBe(modelId);
      expect(model?.compat?.codeMode).toBeUndefined();
    },
  );

  it("does not inherit a different model's Code Mode opt-out", () => {
    const template: ProviderRuntimeModel = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      compat: { codeMode: "capable" },
    };
    const model = buildOpenAIProvider().resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.5",
      modelRegistry: modelRegistry([template]),
    });
    expect(model?.compat?.codeMode).toBe("preferred");
  });

  it.each(["openai-responses", "openai-chatgpt-responses"] as const)(
    "constructs %s models without adding the template's transport defaults",
    (api) => {
      const template: ProviderRuntimeModel = {
        id: "gpt-5.4",
        name: "Template",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://template.example/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        headers: { "X-Template": "preserved" },
        compat: { supportsDeveloperRole: true, codeMode: "capable" },
      };
      const original = structuredClone(template);
      const model = buildOpenAIProvider().resolveDynamicModel?.({
        provider: "openai",
        modelId: template.id,
        providerConfig: {
          api,
          baseUrl:
            api === "openai-responses"
              ? "https://api.openai.com/v1"
              : "https://chatgpt.com/backend-api/codex",
          models: [],
        },
        modelRegistry: modelRegistry([template]),
      });

      expect(model).not.toBe(template);
      expect(model).toMatchObject({ id: template.id, api, headers: original.headers });
      expect(model?.compat).toEqual(original.compat);
      expect(template).toEqual(original);
    },
  );

  it("retains the environment-selected endpoint with preferred metadata", () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://proxy.example/v1");
    const model = buildOpenAIProvider().resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      modelRegistry: modelRegistry(),
    });
    expect(model).toMatchObject({
      baseUrl: "https://proxy.example/v1",
      compat: { codeMode: "preferred" },
    });
  });

  it.each(["capable", undefined] as const)("preserves exact GPT-5.5 compat (%s)", (codeMode) => {
    const exact: ProviderRuntimeModel = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      compat: { supportsTemperature: true, codeMode },
    };
    const model = buildOpenAIProvider().resolveDynamicModel?.({
      provider: "openai",
      modelId: ` ${exact.id} `,
      modelRegistry: modelRegistry([exact]),
    });
    expect(model?.compat).toEqual(exact.compat);
  });
});
