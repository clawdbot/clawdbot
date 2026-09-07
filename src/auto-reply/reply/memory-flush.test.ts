import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "@openclaw/ai/transports";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetContextWindowCacheForTest } from "../../agents/context.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { modelKey } from "../../shared/model-key.js";
import {
  resolveMemoryFlushContextWindowTokens,
  resolveResponsesServerCompactionThreshold,
} from "./memory-flush.js";

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRuntimeConfig: () => ({}),
}));

const TEST_MODEL_ID = "gpt-5.4";
const TEST_CONTEXT_WINDOW = 200_000;

function buildModelConfig(
  route: Pick<
    ModelDefinitionConfig,
    "api" | "baseUrl" | "compat" | "contextTokens" | "contextWindow"
  >,
): ModelDefinitionConfig {
  return {
    id: TEST_MODEL_ID,
    name: TEST_MODEL_ID,
    api: route.api,
    baseUrl: route.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextTokens: route.contextTokens,
    contextWindow: route.contextWindow ?? TEST_CONTEXT_WINDOW,
    maxTokens: 8_192,
    compat: route.compat,
  };
}

function buildHostConfig(params: {
  provider: string;
  api: ModelDefinitionConfig["api"];
  baseUrl?: string;
  compat?: ModelDefinitionConfig["compat"];
  contextTokens?: number;
  contextWindow?: number;
  extraParams?: Record<string, unknown>;
}): OpenClawConfig {
  const modelEntry = {
    [modelKey(params.provider, TEST_MODEL_ID)]: { params: params.extraParams },
  };
  if (params.baseUrl === undefined) {
    return { agents: { defaults: { models: modelEntry } } };
  }
  const providerConfig: ModelProviderConfig = {
    api: params.api,
    baseUrl: params.baseUrl,
    models: [
      buildModelConfig({
        api: params.api,
        baseUrl: params.baseUrl,
        compat: params.compat,
        contextTokens: params.contextTokens,
        contextWindow: params.contextWindow,
      }),
    ],
  };
  return {
    models: { providers: { [params.provider]: providerConfig } },
    agents: {
      defaults: { models: modelEntry },
    },
  };
}

describe("Responses server compaction host/transport parity", () => {
  it.each([
    {
      name: "OpenAI default route without an authored base URL",
      provider: "openai",
      api: "openai-responses" as const,
      resolvedBaseUrl: "https://api.openai.com/v1",
      // No authored rows: the bundled gpt-5.4 manifest catalog window (1_050_000)
      // resolves instead of the generic 200k default.
      contextWindow: 1_050_000,
      expectedEnabled: true,
      expectedThreshold: 735_000,
    },
    {
      name: "OpenAI direct Sol route with an active runtime cap",
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      resolvedBaseUrl: "https://api.openai.com/v1",
      contextTokens: 272_000,
      contextWindow: 1_050_000,
      expectedEnabled: true,
      expectedThreshold: 190_400,
    },
    {
      name: "OpenAI public route",
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      resolvedBaseUrl: "https://api.openai.com/v1",
      expectedEnabled: true,
      expectedThreshold: 140_000,
    },
    {
      name: "ChatGPT OAuth route",
      provider: "openai",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      resolvedBaseUrl: "https://chatgpt.com/backend-api/codex",
      extraParams: { responsesCompactThreshold: 150_000 },
      expectedEnabled: false,
    },
    {
      name: "Azure OpenAI route",
      provider: "azure-openai",
      api: "azure-openai-responses" as const,
      baseUrl: "https://foo.openai.azure.com/openai/v1",
      resolvedBaseUrl: "https://foo.openai.azure.com/openai/v1",
      expectedEnabled: false,
    },
    {
      name: "Azure Cognitive Services route",
      provider: "azure",
      api: "azure-openai-responses" as const,
      baseUrl: "https://foo.cognitiveservices.azure.com/openai/v1",
      resolvedBaseUrl: "https://foo.cognitiveservices.azure.com/openai/v1",
      expectedEnabled: false,
    },
    {
      name: "OpenAI route with store disabled by compatibility metadata",
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      resolvedBaseUrl: "https://api.openai.com/v1",
      compat: { supportsStore: false },
      extraParams: { responsesCompactThreshold: 150_000 },
      expectedEnabled: false,
    },
    {
      name: "case-normalized OpenAI provider",
      provider: "OpenAI",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      resolvedBaseUrl: "https://api.openai.com/v1",
      expectedEnabled: true,
      expectedThreshold: 140_000,
    },
    {
      name: "custom proxy route",
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: "https://proxy.example.com/v1",
      resolvedBaseUrl: "https://proxy.example.com/v1",
      extraParams: { responsesCompactThreshold: 150_000 },
      expectedEnabled: false,
    },
    {
      name: "explicitly disabled OpenAI server compaction",
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      resolvedBaseUrl: "https://api.openai.com/v1",
      extraParams: { responsesServerCompaction: false },
      expectedEnabled: false,
    },
    {
      name: "explicitly enabled Azure server compaction",
      provider: "azure-openai",
      api: "azure-openai-responses" as const,
      baseUrl: "https://foo.openai.azure.com/openai/v1",
      resolvedBaseUrl: "https://foo.openai.azure.com/openai/v1",
      extraParams: { responsesServerCompaction: true, responsesCompactThreshold: 150_000 },
      expectedEnabled: true,
      expectedThreshold: 150_000,
    },
  ])("keeps $name gates aligned", async (testCase) => {
    const cfg = buildHostConfig({
      provider: testCase.provider,
      api: testCase.api,
      baseUrl: testCase.baseUrl,
      compat: testCase.compat,
      contextTokens: testCase.contextTokens,
      contextWindow: testCase.contextWindow,
      extraParams: testCase.extraParams,
    });
    const hostThreshold = await resolveResponsesServerCompactionThreshold({
      cfg,
      provider: testCase.provider,
      modelId: TEST_MODEL_ID,
    });
    const payload: Record<string, unknown> = {};
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        id: TEST_MODEL_ID,
        provider: testCase.provider,
        api: testCase.api,
        baseUrl: testCase.resolvedBaseUrl,
        compat: testCase.compat,
        contextTokens: testCase.contextTokens,
        contextWindow: testCase.contextWindow ?? TEST_CONTEXT_WINDOW,
      },
      {
        storeMode: "provider-policy",
        enableServerCompaction: true,
        extraParams: testCase.extraParams,
      },
    );
    applyOpenAIResponsesPayloadPolicy(payload, policy);
    const transportEnabled = payload.context_management !== undefined;

    expect(hostThreshold !== undefined).toBe(transportEnabled);
    expect(policy.compactThreshold).toBe(hostThreshold);
    expect(transportEnabled).toBe(testCase.expectedEnabled);
    expect(hostThreshold).toBe(testCase.expectedThreshold);
  });
});

describe("Anthropic server compaction host threshold", () => {
  const modelId = "claude-sonnet-4-6";

  it.each([
    {
      name: "keeps Anthropic disabled by default",
      params: {},
      contextWindowTokens: 200_000,
      expected: undefined,
    },
    {
      name: "uses 70 percent of the Anthropic context window",
      params: { anthropicServerCompaction: true },
      contextWindowTokens: 200_000,
      expected: 140_000,
    },
    {
      name: "uses the Anthropic minimum for small windows",
      params: { anthropicServerCompaction: true },
      contextWindowTokens: 32_000,
      expected: 50_000,
    },
    {
      name: "clamps configured Anthropic thresholds",
      params: { anthropicServerCompaction: true, anthropicCompactThreshold: 42_000 },
      contextWindowTokens: 200_000,
      expected: 50_000,
    },
    {
      name: "uses configured Anthropic thresholds",
      params: { anthropicServerCompaction: true, anthropicCompactThreshold: 80_000 },
      contextWindowTokens: 200_000,
      expected: 80_000,
    },
  ])("$name", async ({ params, contextWindowTokens, expected }) => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          anthropic: {
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com/v1",
            models: [
              {
                id: modelId,
                name: modelId,
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: contextWindowTokens,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
      agents: { defaults: { params } },
    };

    expect(
      await resolveResponsesServerCompactionThreshold({
        cfg,
        provider: "anthropic",
        modelId,
      }),
    ).toBe(expected);
  });
});

describe("bundled static catalog fallback for flush budgets", () => {
  afterEach(() => {
    resetContextWindowCacheForTest();
  });

  it("resolves the bundled deepseek catalog window for flush budgets without async discovery", async () => {
    resetContextWindowCacheForTest();
    expect(
      await resolveMemoryFlushContextWindowTokens({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
      }),
    ).toBe(1_000_000);
  });

  it("resolves bundled manifest catalog rows for flush budgets without async discovery", async () => {
    resetContextWindowCacheForTest();
    expect(
      await resolveMemoryFlushContextWindowTokens({
        provider: "openai",
        modelId: "gpt-5.4-mini",
      }),
    ).toBe(400_000);
  });
});
