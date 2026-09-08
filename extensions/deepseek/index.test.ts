// Deepseek tests cover index plugin behavior.
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import deepseekPlugin from "./index.js";
import { buildDeepSeekProvider } from "./provider-catalog.js";
import { createDeepSeekV4ThinkingWrapper } from "./stream.js";

type OpenAICompletionsModel = Model<"openai-completions">;

type PayloadCapture = {
  payload?: Record<string, unknown>;
};

type ThinkingPayload = {
  type?: unknown;
};

type ReplayToolCall = {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
};

type RegisteredProvider = Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

const emptyUsage = createZeroUsageFixture();

function requireThinkingProfileResolver(
  provider: RegisteredProvider,
): NonNullable<RegisteredProvider["resolveThinkingProfile"]> {
  if (!provider.resolveThinkingProfile) {
    throw new Error("DeepSeek provider did not register a thinking profile resolver");
  }
  return provider.resolveThinkingProfile;
}

const readToolCall = { type: "toolCall", id: "call_1", name: "read", arguments: {} };
const readToolResult = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "read",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 3,
};
const readTool = {
  name: "read",
  description: "Read data",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};

function deepSeekV4Model(id: string): OpenAICompletionsModel {
  const provider = buildDeepSeekProvider();
  const model = provider.models.find((entry) => entry.id === id);
  if (!model) {
    throw new Error(`DeepSeek bundled catalog does not include ${id}`);
  }
  return {
    ...model,
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: provider.baseUrl,
  } as OpenAICompletionsModel;
}

function replayAssistantMessage(params: {
  provider: string;
  model: string;
  content: Array<Record<string, unknown>>;
  stopReason: "stop" | "toolUse";
}) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: params.provider,
    model: params.model,
    content: params.content,
    usage: emptyUsage,
    stopReason: params.stopReason,
    timestamp: 2,
  };
}

function readToolReplayContext(assistantMessage: ReturnType<typeof replayAssistantMessage>) {
  return {
    messages: [{ role: "user", content: "hi", timestamp: 1 }, assistantMessage, readToolResult],
    tools: [readTool],
  } as Context;
}

function deepSeekReasoningToolReplayContext(modelId = "deepseek-v4-flash") {
  return readToolReplayContext(
    replayAssistantMessage({
      provider: "deepseek",
      model: modelId,
      content: [
        {
          type: "thinking",
          thinking: "call reasoning",
          thinkingSignature: "reasoning_content",
        },
        readToolCall,
      ],
      stopReason: "toolUse",
    }),
  );
}

function createPayloadCapturingStream(capture: PayloadCapture) {
  return (
    streamModel: OpenAICompletionsModel,
    streamContext: Context,
    options?: { onPayload?: (payload: unknown, model: unknown) => unknown },
  ) => {
    capture.payload = buildOpenAICompletionsParams(streamModel, streamContext, {
      reasoning: "high",
    } as never);
    options?.onPayload?.(capture.payload, streamModel);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
}

function requireThinkingWrapper(
  wrapper: ReturnType<typeof createDeepSeekV4ThinkingWrapper>,
  label: string,
): NonNullable<ReturnType<typeof createDeepSeekV4ThinkingWrapper>> {
  if (!wrapper) {
    throw new Error(`expected DeepSeek thinking wrapper for ${label}`);
  }
  return wrapper;
}

function readThinking(payload: Record<string, unknown> | undefined): ThinkingPayload | undefined {
  return payload?.thinking as ThinkingPayload | undefined;
}

function readPayloadMessage(
  capture: PayloadCapture,
  index: number,
): Record<string, unknown> | undefined {
  return (capture.payload?.messages as Array<Record<string, unknown>> | undefined)?.[index];
}

function readFirstToolCall(
  message: Record<string, unknown> | undefined,
): ReplayToolCall | undefined {
  return (message?.tool_calls as ReplayToolCall[] | undefined)?.[0];
}

describe("deepseek provider plugin", () => {
  it("registers DeepSeek with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "deepseek-api-key",
    });

    expect(provider.id).toBe("deepseek");
    expect(provider.label).toBe("DeepSeek");
    expect(provider.envVars).toEqual(["DEEPSEEK_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected DeepSeek api-key auth choice");
    }
    expect(resolved.provider.id).toBe("deepseek");
    expect(resolved.method.id).toBe("api-key");
  });

  it("builds the static DeepSeek model catalog", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const catalogProvider = await runSingleProviderCatalog({ catalog: provider.staticCatalog });

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.deepseek.com");
    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]);
    const flashModel = catalogProvider.models?.find((model) => model.id === "deepseek-v4-flash");
    expect(flashModel?.reasoning).toBe(true);
    expect(flashModel?.contextWindow).toBe(1_000_000);
    expect(flashModel?.maxTokens).toBe(384_000);
    expect(flashModel?.compat?.supportsReasoningEffort).toBe(true);
    expect(flashModel?.compat?.maxTokensField).toBe("max_tokens");
    expect(
      Object.fromEntries(
        (catalogProvider.models ?? []).map((model) => [
          model.id,
          {
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            cost: model.cost,
          },
        ]),
      ),
    ).toEqual({
      "deepseek-v4-flash": {
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      },
      "deepseek-v4-pro": {
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
      },
      "deepseek-v4-flash-vision-exp": {
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
      },
    });
  });

  it("resolves API-key usage auth from DeepSeek config sources", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    await expect(
      provider.resolveUsageAuth?.({
        env: {},
        resolveApiKeyFromConfigAndStore: (options?: { envDirect?: Array<string | undefined> }) => {
          expect(options?.envDirect).toEqual([undefined]);
          return "config-deepseek-key";
        },
      } as never),
    ).resolves.toEqual({ token: "config-deepseek-key" });
  });

  it("fetches DeepSeek usage balance through the provider hook", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "8.88", granted_balance: "1.00" }],
      }),
    );

    await expect(
      provider.fetchUsageSnapshot?.({
        token: "deepseek-key",
        timeoutMs: 5000,
        fetchFn: mockFetch,
      } as never),
    ).resolves.toMatchObject({
      provider: "deepseek",
      displayName: "DeepSeek",
      windows: [],
      summary: "Balance ¥8.88 · Granted ¥1.00",
    });
  });

  it("owns OpenAI-compatible replay policy", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    const replayPolicy = provider.buildReplayPolicy?.({ modelApi: "openai-completions" } as never);
    expect(replayPolicy?.sanitizeToolCallIds).toBe(true);
    expect(replayPolicy?.toolCallIdMode).toBe("strict");
    expect(replayPolicy?.validateGeminiTurns).toBe(true);
    expect(replayPolicy?.validateAnthropicTurns).toBe(true);
  });

  it("owns DeepSeek tool schema compatibility for MCP union schemas", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const mcpTool = {
      name: "unusual-whales__get_balance_sheet_screener",
      description: "",
      parameters: {
        type: "object",
        properties: {
          date: {
            anyOf: [{ type: "string" }, { type: "integer" }],
          },
          period: {
            oneOf: [{ type: "string" }, { type: "null" }],
          },
        },
      },
      execute: () => undefined,
    } as never;

    const normalized = provider.normalizeToolSchemas?.({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      modelApi: "openai-completions",
      model: deepSeekV4Model("deepseek-v4-pro"),
      tools: [mcpTool],
    } as never);

    expect(normalized?.[0]?.parameters).toEqual({
      type: "object",
      properties: {
        date: { type: "string" },
        period: { type: "string", nullable: true },
      },
    });
    expect(
      provider.inspectToolSchemas?.({
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        modelApi: "openai-completions",
        model: deepSeekV4Model("deepseek-v4-pro"),
        tools: normalized ?? [],
      } as never),
    ).toStrictEqual([]);
  });

  it("advertises max thinking levels for DeepSeek V4 models only", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const resolveThinkingProfile = requireThinkingProfileResolver(provider);
    const expectedV4Levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    for (const modelId of [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]) {
      const profile = resolveThinkingProfile({ provider: "deepseek", modelId } as never);
      expect(profile?.defaultLevel).toBe("high");
      expect(profile?.levels.map((level) => level.id)).toEqual(expectedV4Levels);
    }
    expect(
      resolveThinkingProfile({ provider: "deepseek", modelId: "deepseek-chat" } as never),
    ).toBe(undefined);
    expect(
      resolveThinkingProfile({ provider: "deepseek", modelId: "deepseek-reasoner" } as never),
    ).toBe(undefined);
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"])(
    "maps thinking levels to %s payload controls",
    async (modelId) => {
      let capturedPayload: Record<string, unknown> | undefined;
      const baseStreamFn = (
        _model: Model<"openai-completions">,
        _context: Context,
        options?: { onPayload?: (payload: unknown) => unknown },
      ) => {
        capturedPayload = {
          model: "deepseek-v4-pro",
          reasoning_effort: "high",
        };
        options?.onPayload?.(capturedPayload);
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.end());
        return stream;
      };

      const wrapThinkingOff = requireThinkingWrapper(
        createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "off"),
        "off",
      );
      await wrapThinkingOff(
        {
          provider: "deepseek",
          id: modelId,
          api: "openai-completions",
        } as never,
        { messages: [] } as never,
        {},
      );

      expect(readThinking(capturedPayload)?.type).toBe("disabled");
      expect(capturedPayload).not.toHaveProperty("reasoning_effort");

      const wrapThinkingXhigh = requireThinkingWrapper(
        createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "xhigh"),
        "xhigh",
      );
      await wrapThinkingXhigh(
        {
          provider: "deepseek",
          id: modelId,
          api: "openai-completions",
        } as never,
        { messages: [] } as never,
        {},
      );

      expect(readThinking(capturedPayload)?.type).toBe("enabled");
      expect(capturedPayload?.reasoning_effort).toBe("max");
    },
  );

  it.each(["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"])(
    "preserves replayed reasoning_content for %s",
    async (modelId) => {
      const capture: PayloadCapture = {};
      const model = deepSeekV4Model(modelId);
      const context = deepSeekReasoningToolReplayContext(modelId);
      const baseStreamFn = createPayloadCapturingStream(capture);

      const wrapThinkingHigh = requireThinkingWrapper(
        createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "high"),
        "high",
      );
      await wrapThinkingHigh(model, context, {});

      expect(readThinking(capture.payload)?.type).toBe("enabled");
      expect(capture.payload?.reasoning_effort).toBe("high");
      const assistantMessage = readPayloadMessage(capture, 1);
      expect(assistantMessage?.role).toBe("assistant");
      expect(assistantMessage?.reasoning_content).toBe("call reasoning");
      const toolCall = readFirstToolCall(assistantMessage);
      expect(toolCall?.id).toBe("call_1");
      expect(toolCall?.type).toBe("function");
      expect(toolCall?.function?.name).toBe("read");
      expect(toolCall?.function?.arguments).toBe("{}");
    },
  );

  it("keeps image input in requests for the bundled vision model", () => {
    const provider = buildDeepSeekProvider();
    const entry = provider.models?.find((model) => model.id === "deepseek-v4-flash-vision-exp");
    expect(entry).toMatchObject({ reasoning: true, input: ["text", "image"] });
    const model = {
      ...entry,
      provider: "deepseek",
      baseUrl: provider.baseUrl,
      api: "openai-completions",
    } as OpenAICompletionsModel;
    const payload = buildOpenAICompletionsParams(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image." },
              { type: "image", data: "fixture-image", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
      },
      {},
    );
    expect(payload.messages).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe this image." },
        { type: "image_url", image_url: { url: "data:image/png;base64,fixture-image" } },
      ],
    });
  });

  it("adds blank reasoning_content for replayed tool calls from non-DeepSeek turns", async () => {
    const capture: PayloadCapture = {};
    const model = deepSeekV4Model("deepseek-v4-pro");
    const context = readToolReplayContext(
      replayAssistantMessage({
        provider: "openai",
        model: "gpt-5.4",
        content: [readToolCall],
        stopReason: "toolUse",
      }),
    );
    const baseStreamFn = createPayloadCapturingStream(capture);

    const wrapThinkingHigh = requireThinkingWrapper(
      createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "high"),
      "high",
    );
    await wrapThinkingHigh(model, context, {});

    const assistantMessage = readPayloadMessage(capture, 1);
    expect(assistantMessage?.role).toBe("assistant");
    expect(assistantMessage?.reasoning_content).toBe("");
    const toolCall = readFirstToolCall(assistantMessage);
    expect(toolCall?.id).toBe("call_1");
    expect(toolCall?.type).toBe("function");
    expect(toolCall?.function?.name).toBe("read");
    expect(toolCall?.function?.arguments).toBe("{}");
  });

  it("adds blank reasoning_content for replayed plain assistant messages", async () => {
    const capture: PayloadCapture = {};
    const model = deepSeekV4Model("deepseek-v4-pro");
    const context = {
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        replayAssistantMessage({
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Hello." }],
          stopReason: "stop",
        }),
        { role: "user", content: "next", timestamp: 3 },
      ],
    } as Context;
    const baseStreamFn = createPayloadCapturingStream(capture);

    const wrapThinkingHigh = requireThinkingWrapper(
      createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "high"),
      "high",
    );
    await wrapThinkingHigh(model, context, {});

    const assistantMessage = readPayloadMessage(capture, 1);
    expect(assistantMessage?.role).toBe("assistant");
    expect(assistantMessage?.content).toBe("Hello.");
    expect(assistantMessage?.reasoning_content).toBe("");
  });

  it("strips replayed reasoning_content when DeepSeek V4 thinking is disabled", async () => {
    const capture: PayloadCapture = {};
    const model = deepSeekV4Model("deepseek-v4-flash");
    const context = deepSeekReasoningToolReplayContext();
    const baseStreamFn = createPayloadCapturingStream(capture);

    const wrapThinkingNone = requireThinkingWrapper(
      createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "none" as never),
      "none",
    );
    await wrapThinkingNone(model, context, {});

    expect(readThinking(capture.payload)?.type).toBe("disabled");
    expect(capture.payload).not.toHaveProperty("reasoning_effort");
    expect((capture.payload!.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  it("publishes configured DeepSeek models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              deepseek: {
                models: [
                  {
                    id: "deepseek-chat",
                    name: "DeepSeek Chat",
                    input: ["text"],
                    reasoning: false,
                    contextWindow: 65536,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        provider: "deepseek",
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        input: ["text"],
        reasoning: false,
        contextWindow: 65536,
      },
    ]);
  });
});
