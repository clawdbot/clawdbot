import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import xiaomiPlugin from "./index.js";
import { createMiMoThinkingWrapper } from "./stream.js";

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
type FakeStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

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
    throw new Error("Xiaomi provider did not register a thinking profile resolver");
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

function mimoReasoningModel(
  id: "mimo-v2-pro" | "mimo-v2-omni" | "mimo-v2.5" | "mimo-v2.5-pro" | "mimo-v2.6-pro",
): OpenAICompletionsModel {
  return {
    provider: "xiaomi",
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://api.xiaomimimo.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 32_000,
    compat: {},
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

function mimoReasoningToolReplayContext() {
  return readToolReplayContext(
    replayAssistantMessage({
      provider: "xiaomi",
      model: "mimo-v2.5-pro",
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

function createPayloadCapturingStream(capture: PayloadCapture, model: OpenAICompletionsModel) {
  return (
    _streamModel: OpenAICompletionsModel,
    streamContext: Context,
    options?: { onPayload?: (payload: unknown, m: unknown) => unknown },
  ) => {
    capture.payload = buildOpenAICompletionsParams(model, streamContext, {
      reasoning: "high",
    } as never);
    options?.onPayload?.(capture.payload, model);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
}

function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): FakeStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

function createResultStreamFn(params: { events?: unknown[]; resultMessage: unknown }): StreamFn {
  return () =>
    createFakeStream({
      events: params.events ?? [],
      resultMessage: params.resultMessage,
    }) as ReturnType<StreamFn>;
}

function requireThinkingWrapper(
  wrapper: ReturnType<typeof createMiMoThinkingWrapper>,
  label: string,
): NonNullable<ReturnType<typeof createMiMoThinkingWrapper>> {
  if (!wrapper) {
    throw new Error(`expected MiMo thinking wrapper for ${label}`);
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

describe("xiaomi provider plugin", () => {
  it("registers Xiaomi with api-key auth metadata", async () => {
    const provider = await registerSingleProviderPlugin(xiaomiPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "xiaomi-api-key",
    });

    expect(provider.id).toBe("xiaomi");
    expect(provider.label).toBe("Xiaomi");
    expect(provider.envVars).toEqual(["XIAOMI_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected Xiaomi api-key auth choice");
    }
    expect(resolved.provider.id).toBe("xiaomi");
    expect(resolved.method.id).toBe("api-key");
  });

  it("builds the static Xiaomi model catalog with reasoning flags", async () => {
    const provider = await registerSingleProviderPlugin(xiaomiPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.xiaomimimo.com/v1");

    const modelIds = catalogProvider.models?.map((m) => m.id);
    expect(modelIds).toContain("mimo-v2-pro");
    expect(modelIds).toContain("mimo-v2-omni");
    expect(modelIds).toContain("mimo-v2-flash");

    expect(catalogProvider.models?.find((m) => m.id === "mimo-v2-pro")?.reasoning).toBe(true);
    expect(catalogProvider.models?.find((m) => m.id === "mimo-v2-omni")?.reasoning).toBe(true);
    expect(catalogProvider.models?.find((m) => m.id === "mimo-v2-flash")?.reasoning).toBeFalsy();
  });

  it("owns OpenAI-compatible replay policy", async () => {
    const provider = await registerSingleProviderPlugin(xiaomiPlugin);

    const replayPolicy = provider.buildReplayPolicy?.({ modelApi: "openai-completions" } as never);
    expect(replayPolicy?.sanitizeToolCallIds).toBe(true);
    expect(replayPolicy?.toolCallIdMode).toBe("strict");
    expect(replayPolicy?.validateGeminiTurns).toBe(true);
    expect(replayPolicy?.validateAnthropicTurns).toBe(true);
  });

  it("marks resolved MiMo models for empty array items omission", async () => {
    const provider = await registerSingleProviderPlugin(xiaomiPlugin);
    const model = mimoReasoningModel("mimo-v2.5");

    const normalized = provider.normalizeResolvedModel?.({
      provider: "xiaomi",
      modelId: model.id,
      modelApi: model.api,
      model,
    } as never);

    expect(
      (normalized?.compat as { omitEmptyArrayItems?: unknown } | undefined)?.omitEmptyArrayItems,
    ).toBe(true);
  });

  it("advertises thinking profiles for MiMo reasoning models only", async () => {
    const provider = await registerSingleProviderPlugin(xiaomiPlugin);
    const resolveThinkingProfile = requireThinkingProfileResolver(provider);
    const expectedLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    for (const modelId of [
      "mimo-v2-pro",
      "mimo-v2-omni",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "mimo-v2.6-pro",
    ]) {
      const profile = resolveThinkingProfile({ provider: "xiaomi", modelId } as never);
      expect(profile?.levels.map((l) => l.id)).toEqual(expectedLevels);
      expect(profile?.defaultLevel).toBe("high");
    }

    expect(resolveThinkingProfile({ provider: "xiaomi", modelId: "mimo-v2-flash" } as never)).toBe(
      undefined,
    );
  });

  it("isModernModelRef returns true only for MiMo reasoning models", async () => {
    const provider = await registerSingleProviderPlugin(xiaomiPlugin);

    expect(
      provider.isModernModelRef?.({ provider: "xiaomi", modelId: "mimo-v2.5-pro" } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({ provider: "xiaomi", modelId: "mimo-v2.6-pro" } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({ provider: "xiaomi", modelId: "mimo-v2-pro" } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({ provider: "xiaomi", modelId: "mimo-v2-flash" } as never),
    ).toBe(false);
  });

  it("adds blank reasoning_content for replayed tool calls from non-xiaomi turns", async () => {
    const capture: PayloadCapture = {};
    const model = mimoReasoningModel("mimo-v2.5-pro");
    const context = readToolReplayContext(
      replayAssistantMessage({
        provider: "openai",
        model: "gpt-5.5",
        content: [readToolCall],
        stopReason: "toolUse",
      }),
    );
    const baseStreamFn = createPayloadCapturingStream(capture, model);

    const wrapThinkingHigh = requireThinkingWrapper(
      createMiMoThinkingWrapper(baseStreamFn as never, "high"),
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

  it("preserves replayed reasoning_content when MiMo thinking is enabled", async () => {
    const capture: PayloadCapture = {};
    const model = mimoReasoningModel("mimo-v2.5-pro");
    const context = mimoReasoningToolReplayContext();
    const baseStreamFn = createPayloadCapturingStream(capture, model);

    const wrapThinkingHigh = requireThinkingWrapper(
      createMiMoThinkingWrapper(baseStreamFn as never, "high"),
      "high",
    );
    await wrapThinkingHigh(model, context, {});

    expect(readThinking(capture.payload)?.type).toBe("enabled");
    const assistantMessage = readPayloadMessage(capture, 1);
    expect(assistantMessage?.role).toBe("assistant");
    expect(assistantMessage?.reasoning_content).toBe("call reasoning");
    const toolCall = readFirstToolCall(assistantMessage);
    expect(toolCall?.id).toBe("call_1");
    expect(toolCall?.type).toBe("function");
    expect(toolCall?.function?.name).toBe("read");
  });

  it("strips reasoning_content when MiMo thinking is disabled", async () => {
    const capture: PayloadCapture = {};
    const model = mimoReasoningModel("mimo-v2-pro");
    const context = mimoReasoningToolReplayContext();
    const baseStreamFn = createPayloadCapturingStream(capture, model);

    const wrapThinkingNone = requireThinkingWrapper(
      createMiMoThinkingWrapper(baseStreamFn as never, "none" as never),
      "none",
    );
    await wrapThinkingNone(model, context, {});

    expect(readThinking(capture.payload)?.type).toBe("disabled");
    expect((capture.payload?.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  it.each(["mimo-v2-pro", "mimo-v2-omni"] as const)(
    "promotes reasoning-only terminal output to visible text for %s",
    async (modelId) => {
      const model = mimoReasoningModel(modelId);
      const wrapped = requireThinkingWrapper(
        createMiMoThinkingWrapper(
          createResultStreamFn({
            events: [
              {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "thinking", thinking: "MiMo final answer" }],
                  stopReason: "stop",
                },
              },
            ],
            resultMessage: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "MiMo final answer" }],
              stopReason: "stop",
            },
          }),
          "high",
        ),
        modelId,
      );

      const stream = (await wrapped(model, { messages: [] } as Context, {})) as FakeStream;
      const events: unknown[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "MiMo final answer" }],
            stopReason: "stop",
          },
        },
      ]);
      await expect(stream.result()).resolves.toEqual({
        role: "assistant",
        content: [{ type: "text", text: "MiMo final answer" }],
        stopReason: "stop",
      });
    },
  );

  it("does not promote reasoning when the MiMo assistant turn also has text or tool calls", async () => {
    const model = mimoReasoningModel("mimo-v2-pro");
    const textMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "already visible" },
      ],
      stopReason: "stop",
    };
    const toolMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "call reasoning" }, readToolCall],
      stopReason: "toolUse",
    };

    for (const resultMessage of [textMessage, toolMessage]) {
      const wrapped = requireThinkingWrapper(
        createMiMoThinkingWrapper(createResultStreamFn({ resultMessage }), "high"),
        "mixed-content",
      );
      const stream = (await wrapped(model, { messages: [] } as Context, {})) as FakeStream;

      await expect(stream.result()).resolves.toEqual(resultMessage);
    }
  });

  it("does not promote reasoning-only output for newer MiMo replay models", async () => {
    const model = mimoReasoningModel("mimo-v2.5-pro");
    const resultMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "actual reasoning" }],
      stopReason: "stop",
    };
    const wrapped = requireThinkingWrapper(
      createMiMoThinkingWrapper(createResultStreamFn({ resultMessage }), "high"),
      "mimo-v2.5-pro",
    );
    const stream = (await wrapped(model, { messages: [] } as Context, {})) as FakeStream;

    await expect(stream.result()).resolves.toEqual(resultMessage);
  });
});
