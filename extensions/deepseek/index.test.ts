import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import deepseekPlugin from "./index.js";
import { createDeepSeekV4ThinkingWrapper } from "./stream.js";

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
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("deepseek");
    expect(resolved?.method.id).toBe("api-key");
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
    expect(catalogProvider.models?.find((model) => model.id === "deepseek-v4-flash")).toMatchObject(
      {
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        compat: expect.objectContaining({
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
        }),
      },
    );
    expect(
      catalogProvider.models?.find((model) => model.id === "deepseek-reasoner")?.reasoning,
    ).toBe(true);
  });

  it("owns OpenAI-compatible replay policy", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    expect(provider.buildReplayPolicy?.({ modelApi: "openai-completions" } as never)).toMatchObject(
      {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        validateGeminiTurns: true,
        validateAnthropicTurns: true,
      },
    );
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

    const wrapThinkingOff = createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "off");
    expect(wrapThinkingOff).toBeDefined();
    await wrapThinkingOff?.(
      {
        provider: "deepseek",
        id: "deepseek-v4-pro",
        api: "openai-completions",
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(capturedPayload).toMatchObject({ thinking: { type: "disabled" } });
    expect(capturedPayload).not.toHaveProperty("reasoning_effort");

    const wrapThinkingXhigh = createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "xhigh");
    expect(wrapThinkingXhigh).toBeDefined();
    await wrapThinkingXhigh?.(
      {
        provider: "deepseek",
        id: "deepseek-v4-pro",
        api: "openai-completions",
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(capturedPayload).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });

  it("preserves replayed reasoning_content when DeepSeek V4 thinking is enabled", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const model = {
      provider: "deepseek",
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
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
    } as Model<"openai-completions">;
    const context = {
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          content: [
            {
              type: "thinking",
              thinking: "call reasoning",
              thinkingSignature: "reasoning_content",
            },
            { type: "toolCall", id: "call_1", name: "read", arguments: {} },
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
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 3,
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read data",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
    } as Context;
    const baseStreamFn = (
      streamModel: Model<"openai-completions">,
      streamContext: Context,
      options?: { onPayload?: (payload: unknown, model: unknown) => unknown },
    ) => {
      capturedPayload = buildOpenAICompletionsParams(streamModel, streamContext, {
        reasoning: "high",
      } as never);
      options?.onPayload?.(capturedPayload, streamModel);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };

    const wrapThinkingHigh = createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "high");
    expect(wrapThinkingHigh).toBeDefined();
    await wrapThinkingHigh?.(model, context, {});

    expect(capturedPayload).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect((capturedPayload?.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "call reasoning",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "read",
            arguments: "{}",
          },
        },
      ],
    });
  });

  it("adds blank reasoning_content for replayed tool calls from non-DeepSeek turns", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const model = {
      provider: "deepseek",
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
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
    } as Model<"openai-completions">;
    const context = {
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
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
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 3,
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read data",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
    } as Context;
    const baseStreamFn = (
      streamModel: Model<"openai-completions">,
      streamContext: Context,
      options?: { onPayload?: (payload: unknown, model: unknown) => unknown },
    ) => {
      capturedPayload = buildOpenAICompletionsParams(streamModel, streamContext, {
        reasoning: "high",
      } as never);
      options?.onPayload?.(capturedPayload, streamModel);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };

    const wrapThinkingHigh = createDeepSeekV4ThinkingWrapper(baseStreamFn as never, "high");
    expect(wrapThinkingHigh).toBeDefined();
    await wrapThinkingHigh?.(model, context, {});

    expect((capturedPayload?.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "read",
            arguments: "{}",
          },
        },
      ],
    });
  });

  it("strips replayed reasoning_content when DeepSeek V4 thinking is disabled", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const model = {
      provider: "deepseek",
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
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
    } as Model<"openai-completions">;
    const context = {
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          content: [
            {
              type: "thinking",
              thinking: "call reasoning",
              thinkingSignature: "reasoning_content",
            },
            { type: "toolCall", id: "call_1", name: "read", arguments: {} },
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
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 3,
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read data",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
    } as Context;
    const baseStreamFn = (
      streamModel: Model<"openai-completions">,
      streamContext: Context,
      options?: { onPayload?: (payload: unknown, model: unknown) => unknown },
    ) => {
      capturedPayload = buildOpenAICompletionsParams(streamModel, streamContext, {
        reasoning: "high",
      } as never);
      options?.onPayload?.(capturedPayload, streamModel);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };

    const wrapThinkingNone = createDeepSeekV4ThinkingWrapper(
      baseStreamFn as never,
      "none" as never,
    );
    expect(wrapThinkingNone).toBeDefined();
    await wrapThinkingNone?.(model, context, {});

    expect(capturedPayload).toMatchObject({ thinking: { type: "disabled" } });
    expect(capturedPayload).not.toHaveProperty("reasoning_effort");
    expect((capturedPayload?.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
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
