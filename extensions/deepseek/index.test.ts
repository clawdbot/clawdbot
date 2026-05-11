import type { Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import deepseekPlugin from "./index.js";
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

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function deepSeekV4Model(id: "deepseek-v4-flash" | "deepseek-v4-pro"): OpenAICompletionsModel {
  return {
    provider: "deepseek",
    id,
    name: id === "deepseek-v4-flash" ? "DeepSeek V4 Flash" : "DeepSeek V4 Pro",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
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

function deepSeekReasoningToolReplayContext() {
  return readToolReplayContext(
    replayAssistantMessage({
      provider: "deepseek",
      model: "deepseek-v4-flash",
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
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.deepseek.com");
    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    const flashModel = catalogProvider.models?.find((model) => model.id === "deepseek-v4-flash");
    expect(flashModel?.reasoning).toBe(true);
    expect(flashModel?.contextWindow).toBe(1_000_000);
    expect(flashModel?.maxTokens).toBe(384_000);
    expect(flashModel?.compat?.supportsReasoningEffort).toBe(true);
    expect(flashModel?.compat?.maxTokensField).toBe("max_tokens");
    expect(
      catalogProvider.models?.find((model) => model.id === "deepseek-reasoner")?.reasoning,
    ).toBe(true);
  });

  it("owns OpenAI-compatible replay policy", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    const replayPolicy = provider.buildReplayPolicy?.({ modelApi: "openai-completions" } as never);
    expect(replayPolicy?.sanitizeToolCallIds).toBe(true);
    expect(replayPolicy?.toolCallIdMode).toBe("strict");
    expect(replayPolicy?.validateGeminiTurns).toBe(true);
    expect(replayPolicy?.validateAnthropicTurns).toBe(true);
  });

  it("advertises max thinking levels for DeepSeek V4 models only", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const resolveThinkingProfile = requireThinkingProfileResolver(provider);
    const expectedV4Levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    expect(
      resolveThinkingProfile({
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
      } as never)?.levels.map((level) => level.id),
    ).toEqual(expectedV4Levels);
    expect(
      resolveThinkingProfile({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
      } as never)?.defaultLevel,
    ).toBe("high");
    expect(
      resolveThinkingProfile({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
      } as never)?.levels.map((level) => level.id),
    ).toEqual(expectedV4Levels);
    expect(
      resolveThinkingProfile({ provider: "deepseek", modelId: "deepseek-chat" } as never),
    ).toBe(undefined);
    expect(
      resolveThinkingProfile({ provider: "deepseek", modelId: "deepseek-reasoner" } as never),
    ).toBe(undefined);
  });

  it("maps thinking levels to DeepSeek V4 payload controls", async () => {
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
        id: "deepseek-v4-pro",
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
        id: "deepseek-v4-pro",
        api: "openai-completions",
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(readThinking(capturedPayload)?.type).toBe("enabled");
    expect(capturedPayload?.reasoning_effort).toBe("max");
  });

  it("preserves replayed reasoning_content when DeepSeek V4 thinking is enabled", async () => {
    const capture: PayloadCapture = {};
    const model = deepSeekV4Model("deepseek-v4-flash");
    const context = deepSeekReasoningToolReplayContext();
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
    expect((capture.payload?.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
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
