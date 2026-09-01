import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiProviderRequestCapabilities,
  type AiProviderRequestPolicyInput,
} from "../host.js";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat } from "../types.js";

const mockOpenAI = vi.hoisted(() => ({
  chunks: [] as unknown[],
  clientOptions: [] as unknown[],
  payloads: [] as unknown[],
  requestOptions: [] as unknown[],
  nextError: undefined as Error | undefined,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(options: unknown) {
      mockOpenAI.clientOptions.push(options);
    }

    chat = {
      completions: {
        create: (payload: unknown, requestOptions: unknown) => {
          mockOpenAI.payloads.push(payload);
          mockOpenAI.requestOptions.push(requestOptions);
          return {
            withResponse: async () => {
              if (mockOpenAI.nextError !== undefined) {
                throw mockOpenAI.nextError;
              }
              async function* stream() {
                yield* mockOpenAI.chunks;
              }
              return {
                data: stream(),
                response: { status: 200, headers: new Headers() },
              };
            },
          };
        },
      },
    };
  }

  return { default: MockOpenAI };
});

import {
  resolveOpenAICompletionsCompat,
  type ResolvedOpenAICompletionsCompat,
} from "../transports/openai-completions-compat.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const baseModel: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "custom-openai-compatible",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const userMessage = { role: "user", content: "hello", timestamp: 1 } as const;
const context: Context = { messages: [userMessage] };
let previousAiTransportHost: ReturnType<typeof getAiTransportHost>;

function createModel(
  overrides: Partial<Model<"openai-completions">> & {
    compat?: OpenAICompletionsCompat;
  } = {},
): Model<"openai-completions"> {
  return { ...baseModel, ...overrides };
}

function resolveTestEndpointClass(baseUrl: string | undefined): string {
  if (!baseUrl) {
    return "default";
  }
  const host = new URL(baseUrl).hostname;
  const exactClasses: Record<string, string> = {
    "api.openai.com": "openai-public",
    "api.cerebras.ai": "cerebras-native",
    "api.x.ai": "xai-native",
    "api.moonshot.ai": "moonshot-native",
    "api.moonshot.cn": "moonshot-native",
    "llm.chutes.ai": "chutes-native",
    "api.z.ai": "zai-native",
    "api.deepseek.com": "deepseek-native",
    "dashscope.aliyuncs.com": "modelstudio-native",
    "127.0.0.1": "local",
    localhost: "local",
  };
  const exactClass = exactClasses[host];
  if (exactClass) {
    return exactClass;
  }
  if (host.endsWith(".openai.azure.com")) {
    return "azure-openai";
  }
  if (host.endsWith("openrouter.ai")) {
    return "openrouter";
  }
  if (host.endsWith("opencode.ai")) {
    return "opencode-native";
  }
  if (host.endsWith("xiaomimimo.com")) {
    return "xiaomi-native";
  }
  return "custom";
}

function resolveTestCapabilities(
  input: AiProviderRequestPolicyInput,
): AiProviderRequestCapabilities {
  const endpointClass = resolveTestEndpointClass(input.baseUrl);
  const provider = input.provider;
  const knownProviderFamily =
    provider === "moonshotai" || provider === "moonshotai-cn"
      ? "moonshot"
      : provider === "openai" || provider === "azure-openai"
        ? "openai-family"
        : provider === "qwen" || provider === "dashscope"
          ? "modelstudio"
          : (provider ?? "unknown");
  const usesConfiguredBaseUrl = endpointClass !== "default";
  const usesKnownNativeOpenAIEndpoint =
    endpointClass === "openai-public" ||
    endpointClass === "openai" ||
    endpointClass === "azure-openai";
  return {
    endpointClass,
    knownProviderFamily,
    supportsNativeStreamingUsageCompat: endpointClass === "moonshot-native",
    supportsOpenAICompletionsStreamingUsageCompat: false,
    usesExplicitProxyLikeEndpoint: usesConfiguredBaseUrl && !usesKnownNativeOpenAIEndpoint,
    allowsAnthropicServiceTier: false,
  };
}

const defaultResolvedCompat = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  openRouterRouting: undefined,
  vercelGatewayRouting: {},
  zaiToolStream: false,
  supportsStrictMode: true,
  supportsJsonSchemaResponseFormat: false,
  cacheControlFormat: undefined,
  sessionAffinity: "none",
  supportsPromptCacheKey: false,
  supportsLongCacheRetention: true,
  visibleReasoningDetailTypes: [],
  requiresNonEmptyUserOrAssistantMessage: false,
} satisfies ResolvedOpenAICompletionsCompat;

const proxyResolvedCompat = {
  ...defaultResolvedCompat,
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  supportsStrictMode: false,
} satisfies ResolvedOpenAICompletionsCompat;

type DuplicatedCompatFields = Pick<
  ResolvedOpenAICompletionsCompat,
  | "supportsStore"
  | "supportsDeveloperRole"
  | "supportsReasoningEffort"
  | "maxTokensField"
  | "thinkingFormat"
  | "supportsStrictMode"
  | "supportsJsonSchemaResponseFormat"
>;

const defaultDuplicatedCompat = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  maxTokensField: "max_completion_tokens",
  thinkingFormat: "openai",
  supportsStrictMode: true,
  supportsJsonSchemaResponseFormat: false,
} satisfies DuplicatedCompatFields;

function duplicatedCompatFields(compat: ResolvedOpenAICompletionsCompat): DuplicatedCompatFields {
  return {
    supportsStore: compat.supportsStore,
    supportsDeveloperRole: compat.supportsDeveloperRole,
    supportsReasoningEffort: compat.supportsReasoningEffort,
    maxTokensField: compat.maxTokensField,
    thinkingFormat: compat.thinkingFormat,
    supportsStrictMode: compat.supportsStrictMode,
    supportsJsonSchemaResponseFormat: compat.supportsJsonSchemaResponseFormat,
  };
}

const legacyOpenRouterCompat = {
  ...defaultDuplicatedCompat,
  supportsDeveloperRole: false,
  thinkingFormat: "openrouter",
} satisfies DuplicatedCompatFields;
const legacyCerebrasCompat = {
  ...defaultDuplicatedCompat,
  supportsStore: false,
  supportsDeveloperRole: false,
} satisfies DuplicatedCompatFields;
const legacyXaiCompat = {
  ...legacyCerebrasCompat,
  supportsReasoningEffort: false,
} satisfies DuplicatedCompatFields;
const legacyMoonshotCompat = {
  ...legacyXaiCompat,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
} satisfies DuplicatedCompatFields;
const legacyCloudflareGatewayCompat = legacyMoonshotCompat;
const legacyTogetherCompat = {
  ...legacyMoonshotCompat,
  thinkingFormat: "together",
} satisfies DuplicatedCompatFields;
const legacyZaiCompat = {
  ...legacyXaiCompat,
  maxTokensField: "max_tokens",
  thinkingFormat: "zai",
} satisfies DuplicatedCompatFields;
const legacyXiaomiCompat = {
  ...defaultDuplicatedCompat,
  thinkingFormat: "deepseek",
} satisfies DuplicatedCompatFields;
const legacyDeepseekEndpointCompat = {
  ...defaultDuplicatedCompat,
  supportsStore: false,
  supportsDeveloperRole: false,
  thinkingFormat: "deepseek",
} satisfies DuplicatedCompatFields;
const legacyChutesCompat = {
  ...legacyCerebrasCompat,
  maxTokensField: "max_tokens",
} satisfies DuplicatedCompatFields;

const canonicalProxyCompat = {
  ...defaultDuplicatedCompat,
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStrictMode: false,
} satisfies DuplicatedCompatFields;
const canonicalOpenRouterCompat = {
  ...canonicalProxyCompat,
  thinkingFormat: "openrouter",
} satisfies DuplicatedCompatFields;
const canonicalChutesCompat = {
  ...canonicalProxyCompat,
  maxTokensField: "max_tokens",
} satisfies DuplicatedCompatFields;
const canonicalTogetherCompat = {
  ...canonicalChutesCompat,
  thinkingFormat: "together",
} satisfies DuplicatedCompatFields;
const canonicalZaiCompat = {
  ...canonicalChutesCompat,
  thinkingFormat: "zai",
} satisfies DuplicatedCompatFields;
const canonicalDeepseekCompat = {
  ...canonicalProxyCompat,
  thinkingFormat: "deepseek",
} satisfies DuplicatedCompatFields;
const endpointPolicyDivergence =
  "canonical transport endpoint policy replaces the legacy provider/URL heuristic";

type MatrixParityCase = readonly [
  name: string,
  overrides: Partial<Model<"openai-completions">>,
  legacyExpected: DuplicatedCompatFields,
  expected: DuplicatedCompatFields,
  divergence: string | undefined,
];

const legacyMatrixParityCases = [
  [
    "provider openrouter",
    { provider: "openrouter" },
    legacyOpenRouterCompat,
    canonicalOpenRouterCompat,
    endpointPolicyDivergence,
  ],
  [
    "endpoint openrouter.ai",
    { provider: "custom", baseUrl: "https://openrouter.ai/api/v1" },
    legacyOpenRouterCompat,
    canonicalOpenRouterCompat,
    endpointPolicyDivergence,
  ],
  [
    "OpenRouter Anthropic model",
    { provider: "openrouter", id: "anthropic/claude-sonnet-4.6" },
    { ...legacyOpenRouterCompat, supportsDeveloperRole: true },
    canonicalOpenRouterCompat,
    endpointPolicyDivergence,
  ],
  [
    "OpenRouter OpenAI model",
    { provider: "openrouter", id: "openai/gpt-5.6-luna" },
    { ...legacyOpenRouterCompat, supportsDeveloperRole: true },
    canonicalOpenRouterCompat,
    endpointPolicyDivergence,
  ],
  [
    "provider cerebras",
    { provider: "cerebras" },
    legacyCerebrasCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "endpoint cerebras.ai",
    { provider: "custom", baseUrl: "https://api.cerebras.ai/v1" },
    legacyCerebrasCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "provider xai",
    { provider: "xai" },
    legacyXaiCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "endpoint api.x.ai",
    { provider: "custom", baseUrl: "https://api.x.ai/v1" },
    legacyXaiCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "provider moonshotai",
    { provider: "moonshotai" },
    legacyMoonshotCompat,
    legacyMoonshotCompat,
    undefined,
  ],
  [
    "provider moonshotai-cn",
    { provider: "moonshotai-cn" },
    legacyMoonshotCompat,
    legacyMoonshotCompat,
    undefined,
  ],
  [
    "endpoint Moonshot global",
    { provider: "custom", baseUrl: "https://api.moonshot.ai/v1" },
    legacyMoonshotCompat,
    legacyMoonshotCompat,
    undefined,
  ],
  [
    "endpoint Moonshot China",
    { provider: "custom", baseUrl: "https://api.moonshot.cn/v1" },
    legacyMoonshotCompat,
    legacyMoonshotCompat,
    undefined,
  ],
  [
    "provider Cloudflare Workers AI",
    { provider: "cloudflare-workers-ai" },
    legacyCerebrasCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "endpoint Cloudflare Workers AI",
    { provider: "custom", baseUrl: "https://api.cloudflare.com/client/v4/accounts/test/ai/run" },
    legacyCerebrasCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "provider Cloudflare AI Gateway",
    { provider: "cloudflare-ai-gateway" },
    legacyCloudflareGatewayCompat,
    legacyCloudflareGatewayCompat,
    undefined,
  ],
  [
    "endpoint Cloudflare AI Gateway",
    { provider: "custom", baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/compat" },
    legacyCloudflareGatewayCompat,
    legacyCloudflareGatewayCompat,
    undefined,
  ],
  [
    "provider opencode",
    { provider: "opencode" },
    legacyCerebrasCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "endpoint opencode.ai",
    { provider: "custom", baseUrl: "https://api.opencode.ai/v1" },
    legacyCerebrasCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "endpoint chutes.ai",
    { provider: "custom", baseUrl: "https://llm.chutes.ai/v1" },
    legacyChutesCompat,
    canonicalChutesCompat,
    endpointPolicyDivergence,
  ],
  [
    "provider together",
    { provider: "together" },
    legacyTogetherCompat,
    canonicalTogetherCompat,
    undefined,
  ],
  [
    "endpoint together.ai",
    { provider: "custom", baseUrl: "https://api.together.ai/v1" },
    legacyTogetherCompat,
    canonicalTogetherCompat,
    undefined,
  ],
  [
    "endpoint together.xyz",
    { provider: "custom", baseUrl: "https://api.together.xyz/v1" },
    legacyTogetherCompat,
    canonicalTogetherCompat,
    undefined,
  ],
  [
    "provider zai",
    { provider: "zai" },
    legacyZaiCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "endpoint api.z.ai",
    { provider: "custom", baseUrl: "https://api.z.ai/api/paas/v4" },
    legacyZaiCompat,
    canonicalZaiCompat,
    endpointPolicyDivergence,
  ],
  [
    "provider xiaomi",
    { provider: "xiaomi" },
    legacyXiaomiCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "endpoint xiaomimimo.com",
    { provider: "custom", baseUrl: "https://api.xiaomimimo.com/v1" },
    legacyXiaomiCompat,
    canonicalDeepseekCompat,
    endpointPolicyDivergence,
  ],
  [
    "provider deepseek",
    { provider: "deepseek" },
    legacyXiaomiCompat,
    canonicalProxyCompat,
    endpointPolicyDivergence,
  ],
  [
    "endpoint deepseek.com",
    { provider: "custom", baseUrl: "https://api.deepseek.com/v1" },
    legacyDeepseekEndpointCompat,
    canonicalDeepseekCompat,
    endpointPolicyDivergence,
  ],
] satisfies MatrixParityCase[];

function chunk(delta: Record<string, unknown>, finishReason?: string): unknown {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
}

beforeEach(() => {
  previousAiTransportHost = getAiTransportHost();
  configureAiTransportHost({ resolveProviderRequestCapabilities: resolveTestCapabilities });
  mockOpenAI.chunks = [chunk({ content: "ok" }), chunk({}, "stop")];
  mockOpenAI.clientOptions = [];
  mockOpenAI.payloads = [];
  mockOpenAI.requestOptions = [];
  mockOpenAI.nextError = undefined;
});

afterEach(() => {
  configureAiTransportHost(previousAiTransportHost);
});

describe("OpenAI-compatible completions compatibility", () => {
  it.each([
    { provider: "dashscope", baseUrl: "", expected: "anthropic" },
    { provider: "modelstudio", baseUrl: "", expected: "anthropic" },
    { provider: "qwen", baseUrl: "", expected: "anthropic" },
    {
      provider: "custom",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      expected: "anthropic",
    },
    { provider: "custom", baseUrl: "https://proxy.example/v1", expected: undefined },
    { provider: "qwen", baseUrl: "https://proxy.example/v1", expected: undefined },
    { provider: "moonshot", baseUrl: "https://api.moonshot.ai/v1", expected: undefined },
  ])("defaults cache markers for $provider at $baseUrl", ({ provider, baseUrl, expected }) => {
    expect(
      resolveOpenAICompletionsCompat(createModel({ provider, baseUrl })).cacheControlFormat,
    ).toBe(expected);
  });

  it("honors explicit cache compatibility settings on Model Studio", () => {
    const compat = { cacheControlFormat: "anthropic", supportsLongCacheRetention: true } as const;
    expect(
      resolveOpenAICompletionsCompat(createModel({ provider: "modelstudio", compat })),
    ).toMatchObject(compat);
  });

  it.each([undefined, "anthropic"] as const)(
    "requires explicit cache format %s for Qwen behind a custom endpoint",
    async (cacheControlFormat) => {
      const model = createModel({
        id: "qwen-plus",
        provider: "qwen",
        compat: { cacheControlFormat },
      });
      await streamOpenAICompletions(
        model,
        {
          systemPrompt: "Follow instructions.",
          messages: [userMessage],
          tools: [
            {
              name: "lookup",
              description: "Look up data",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        { apiKey: "test", cacheRetention: "short" },
      ).result();

      expect(mockOpenAI.payloads).toHaveLength(1);
      const markers = JSON.stringify(mockOpenAI.payloads[0]).match(/"cache_control":/g) ?? [];
      expect(markers).toHaveLength(cacheControlFormat === "anthropic" ? 3 : 0);
      expect(resolveOpenAICompletionsCompat(model).cacheControlFormat).toBe(cacheControlFormat);
    },
  );

  it.each([undefined, "short", "long", "none"] as const)(
    "sends Model Studio cache markers without OpenAI cache fields for retention %s",
    async (cacheRetention) => {
      const model = createModel({
        id: "qwen-plus",
        provider: "custom",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      });
      await streamOpenAICompletions(
        model,
        {
          systemPrompt: "Follow instructions.",
          messages: [userMessage, { ...userMessage, content: "latest", timestamp: 2 }],
          tools: ["alpha", "zeta"].map((name) => ({
            name,
            description: name,
            parameters: { type: "object", properties: {} },
          })),
        },
        { apiKey: "test", sessionId: "session-test", cacheRetention },
      ).result();

      const cacheControl = cacheRetention === "none" ? undefined : { type: "ephemeral" };
      const content = (text: string) =>
        cacheControl ? [{ type: "text", text, cache_control: cacheControl }] : text;
      const expectedPayload = {
        model: "qwen-plus",
        messages: [
          { role: "system", content: content("Follow instructions.") },
          { role: "user", content: "hello" },
          { role: "user", content: content("latest") },
        ],
        stream: true,
        tools: ["alpha", "zeta"].map((name) => ({
          type: "function",
          function: { name, description: name, parameters: { type: "object", properties: {} } },
          cache_control: name === "zeta" ? cacheControl : undefined,
        })),
      };
      // Compare wire JSON, where undefined cache fields must be omitted.
      expect(JSON.stringify(mockOpenAI.payloads[0])).toBe(JSON.stringify(expectedPayload));
    },
  );

  it.each(legacyMatrixParityCases)(
    "maps former provider matrix case %s to canonical endpoint policy",
    (_name, overrides, legacyExpected, expected, divergence) => {
      expect(
        duplicatedCompatFields(resolveOpenAICompletionsCompat(createModel(overrides))),
      ).toEqual(expected);
      if (divergence) {
        expect(expected).not.toEqual(legacyExpected);
        expect(divergence).toBe(endpointPolicyDivergence);
      } else {
        expect(expected).toEqual(legacyExpected);
      }
    },
  );

  it("lets Ollama tools win over JSON Schema response formats", async () => {
    const model = createModel({
      id: "gemma4:e4b",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      compat: { supportsJsonSchemaResponseFormat: true },
    });

    await streamOpenAICompletions(
      model,
      {
        messages: [userMessage],
        tools: [
          {
            name: "weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      {
        apiKey: "test",
        responseFormat: {
          type: "object",
          properties: { reply: { type: "string" } },
          required: ["reply"],
          additionalProperties: false,
        },
      },
    ).result();

    expect(mockOpenAI.payloads[0]).toMatchObject({ tools: [expect.any(Object)] });
    expect(mockOpenAI.payloads[0]).not.toHaveProperty("response_format");
  });

  it("omits JSON Schema response formats for hosted Ollama Cloud", async () => {
    const model = createModel({
      id: "gemma4",
      provider: "ollama",
      baseUrl: "https://ollama.com/v1",
      compat: { supportsJsonSchemaResponseFormat: true },
    });

    await streamOpenAICompletions(model, context, {
      apiKey: "test",
      responseFormat: {
        type: "object",
        properties: { reply: { type: "string" } },
        required: ["reply"],
        additionalProperties: false,
      },
    }).result();

    expect(mockOpenAI.payloads[0]).not.toHaveProperty("response_format");
  });

  it.each([
    {
      name: "OpenRouter Anthropic",
      model: createModel({
        id: "anthropic/claude-sonnet-4.6",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: { sendSessionAffinityHeaders: true },
      }),
      expected: {
        ...proxyResolvedCompat,
        thinkingFormat: "openrouter",
        cacheControlFormat: "anthropic",
        sessionAffinity: "openrouter",
        visibleReasoningDetailTypes: ["response.output_text", "response.text"],
      },
    },
    {
      name: "OpenRouter Kimi",
      model: createModel({
        id: "moonshotai/kimi-k2.6",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      expected: {
        ...proxyResolvedCompat,
        thinkingFormat: "openrouter",
        visibleReasoningDetailTypes: ["response.output_text", "response.text"],
      },
    },
    {
      name: "Z.AI GLM",
      model: createModel({
        id: "glm-5",
        provider: "zai",
        baseUrl: "https://api.z.ai/api/paas/v4",
      }),
      expected: {
        ...proxyResolvedCompat,
        maxTokensField: "max_tokens",
        thinkingFormat: "zai",
      },
    },
    {
      name: "OpenAI",
      model: createModel({
        id: "gpt-5.6-luna",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
      expected: { ...defaultResolvedCompat, supportsJsonSchemaResponseFormat: true },
    },
    {
      name: "Azure OpenAI",
      model: createModel({
        id: "gpt-5.6-luna",
        provider: "azure-openai",
        baseUrl: "https://example.openai.azure.com/openai/deployments/luna",
      }),
      expected: {
        ...defaultResolvedCompat,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
        supportsStrictMode: false,
      },
    },
    {
      name: "OpenAI legacy model",
      model: createModel({
        id: "gpt-4-turbo",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
      expected: defaultResolvedCompat,
    },
    {
      name: "custom proxy",
      model: createModel(),
      expected: proxyResolvedCompat,
    },
    {
      name: "custom proxy with OpenRouter routing",
      model: createModel({
        compat: {
          openRouterRouting: { only: ["google-vertex"] },
          sendSessionAffinityHeaders: true,
        },
      }),
      expected: {
        ...proxyResolvedCompat,
        openRouterRouting: { only: ["google-vertex"] },
        sessionAffinity: "openrouter",
      },
    },
  ])("resolves the $name compat record", ({ model, expected }) => {
    expect(resolveOpenAICompletionsCompat(model)).toEqual(expected);
  });

  it("buffers encrypted reasoning details until their tool call arrives", async () => {
    const reasoningDetail = {
      type: "reasoning.encrypted",
      id: "call_1",
      data: "encrypted-signature",
    };
    mockOpenAI.chunks = [
      chunk({ reasoning_details: [reasoningDetail] }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"cats"}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ];
    const model = createModel({
      id: "google/gemini-test",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
    });

    const result = await streamOpenAICompletions(model, context, {
      apiKey: "test",
    }).result();

    expect(result.content.find((block) => block.type === "toolCall")).toMatchObject({
      id: "call_1",
      thoughtSignature: JSON.stringify(reasoningDetail),
    });

    let replayPayload: unknown;
    await streamOpenAICompletions(
      model,
      { messages: [result] },
      {
        apiKey: "test",
        onPayload(payload) {
          replayPayload = payload;
          throw new Error("payload captured");
        },
      },
    ).result();
    const replayedAssistant = (
      replayPayload as { messages?: Array<{ role?: string; reasoning_details?: unknown }> }
    ).messages?.find((message) => message.role === "assistant");
    expect(replayedAssistant?.reasoning_details).toEqual([reasoningDetail]);
  });

  it.each([
    { modelId: "openai/gpt-5.6-luna", expectedRole: "system" },
    { modelId: "anthropic/claude-sonnet-4.6", expectedRole: "system" },
    { modelId: "moonshotai/kimi-k2.6", expectedRole: "system" },
  ])("uses $expectedRole instructions for OpenRouter model $modelId", async (testCase) => {
    let payload: unknown;
    const model = createModel({
      id: testCase.modelId,
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
    });

    await streamOpenAICompletions(
      model,
      { ...context, systemPrompt: "Follow instructions." },
      {
        apiKey: "test",
        onPayload(nextPayload) {
          payload = nextPayload;
          throw new Error("payload captured");
        },
      },
    ).result();

    expect((payload as { messages?: Array<{ role?: string }> }).messages?.[0]?.role).toBe(
      testCase.expectedRole,
    );
  });

  it("sends configured OpenRouter routing through a compatible proxy", async () => {
    let payload: unknown;
    const routing = { only: ["google-vertex"] };
    const model = createModel({ compat: { openRouterRouting: routing } });

    await streamOpenAICompletions(model, context, {
      apiKey: "test",
      onPayload(nextPayload) {
        payload = nextPayload;
        throw new Error("payload captured");
      },
    }).result();

    expect((payload as { provider?: unknown }).provider).toEqual(routing);
  });

  it.each([
    {
      name: "OpenAI",
      model: createModel({ compat: { sendSessionAffinityHeaders: true } }),
      expectedHeaders: {
        session_id: "session-123",
        "x-client-request-id": "session-123",
        "x-session-affinity": "session-123",
      },
    },
    {
      name: "OpenRouter",
      model: createModel({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: { sendSessionAffinityHeaders: true },
      }),
      expectedHeaders: { "x-session-id": "session-123" },
    },
    {
      name: "OpenRouter-compatible proxy",
      model: createModel({
        compat: {
          sendSessionAffinityHeaders: true,
          thinkingFormat: "openrouter",
        },
      }),
      expectedHeaders: { "x-session-id": "session-123" },
    },
  ])("sends exact $name session-affinity headers", async ({ model, expectedHeaders }) => {
    await streamOpenAICompletions(model, context, {
      apiKey: "test",
      sessionId: "session-123",
    }).result();

    const clientOptions = mockOpenAI.clientOptions[0] as {
      defaultHeaders?: Record<string, string>;
    };
    expect(clientOptions.defaultHeaders).toEqual(expectedHeaders);
  });

  it("retains replayed Z.AI thinking when reasoning is enabled", async () => {
    let payload: unknown;
    const model = createModel({
      id: "glm-test",
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
    });
    const assistant: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        {
          type: "thinking",
          thinking: "prior reasoning",
          thinkingSignature: "reasoning_content",
        },
        { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
      ],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    };

    await streamOpenAICompletions(
      model,
      {
        messages: [
          userMessage,
          assistant,
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "lookup",
            content: [{ type: "text", text: "done" }],
            isError: false,
            timestamp: 3,
          },
        ],
      },
      {
        apiKey: "test",
        reasoningEffort: "high",
        onPayload(nextPayload) {
          payload = nextPayload;
          throw new Error("payload captured");
        },
      },
    ).result();

    const request = payload as {
      thinking?: unknown;
      messages?: Array<Record<string, unknown>>;
    };
    expect(request.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(request.messages?.find((message) => message.role === "assistant")).toMatchObject({
      reasoning_content: "prior reasoning",
    });
  });

  it("pins OpenAI SDK retries to zero", async () => {
    await streamOpenAICompletions(baseModel, context, { apiKey: "test" }).result();

    expect(mockOpenAI.clientOptions[0]).toMatchObject({ maxRetries: 0 });
  });

  it("surfaces HTTP response body text from OpenAI-compatible errors", async () => {
    mockOpenAI.nextError = Object.assign(new Error("502 status code (no body)"), {
      status: 502,
      body: "gateway maintenance",
    });

    const result = await streamOpenAICompletions(baseModel, context, {
      apiKey: "test",
    }).result();

    expect(result.errorMessage).toBe("502: gateway maintenance");
  });

  it("redacts OpenRouter terminal body and raw metadata from one error projection", async () => {
    const media = "QUJDRA==";
    mockOpenAI.nextError = Object.assign(new Error("400 status code (no body)"), {
      status: 400,
      body: { data: [{ b64_json: media }] },
      error: {
        code: "bad_image",
        type: "invalid_request_error",
        metadata: { raw: `render failed data:image/png;base64,${media}` },
      },
    });

    const result = await streamOpenAICompletions(baseModel, context, { apiKey: "test" }).result();

    expect(result).toMatchObject({
      errorCode: "bad_image",
      errorType: "invalid_request_error",
    });
    expect(JSON.stringify(result)).not.toContain(media);
  });
});
