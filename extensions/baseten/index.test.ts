import type { Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import basetenPlugin from "./index.js";
import { applyBasetenConfig } from "./onboard.js";
import { createBasetenThinkingWrapper } from "./stream.js";

type OpenAICompletionsModel = Model<"openai-completions">;
const TEST_VALUE = "resolved-marker";

function basetenModel(id: string): OpenAICompletionsModel {
  return {
    id,
    name: id,
    provider: "baseten",
    api: "openai-completions",
    baseUrl: "https://inference.baseten.co/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 202_000,
    maxTokens: 202_000,
  };
}

function captureThinkingPayload(modelId: string, thinkingLevel: "off" | "high" | undefined) {
  let captured: Record<string, unknown> | undefined;
  const streamFn: NonNullable<ProviderWrapStreamFnContext["streamFn"]> = (
    model,
    _context,
    options,
  ) => {
    const payload: Record<string, unknown> = {
      chat_template_args: { preserve_me: true },
    };
    options?.onPayload?.(payload, model);
    captured = payload;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
  const wrapperContext: ProviderWrapStreamFnContext = {
    provider: "baseten",
    modelId,
    thinkingLevel,
    streamFn,
  };
  const wrapped = createBasetenThinkingWrapper(wrapperContext);
  if (!wrapped) {
    throw new Error("Baseten thinking wrapper missing");
  }
  void wrapped(basetenModel(modelId), { messages: [] }, {});
  return captured;
}

function captureDeepSeekReplayPayload(thinkingLevel: "off" | "high" | undefined) {
  let captured: Record<string, unknown> | undefined;
  const streamFn: NonNullable<ProviderWrapStreamFnContext["streamFn"]> = (
    model,
    _context,
    options,
  ) => {
    const payload: Record<string, unknown> = {
      ...(thinkingLevel === undefined
        ? {}
        : { reasoning_effort: thinkingLevel === "off" ? "none" : "high" }),
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
        { role: "assistant", content: "done", reasoning_content: "preserve me" },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    };
    options?.onPayload?.(payload, model);
    captured = payload;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
  const modelId = "deepseek-ai/DeepSeek-V4-Pro";
  const wrapped = createBasetenThinkingWrapper({
    provider: "baseten",
    modelId,
    thinkingLevel,
    streamFn,
  });
  if (!wrapped) {
    throw new Error("Baseten thinking wrapper missing");
  }
  void wrapped(basetenModel(modelId), { messages: [] }, {});
  return captured;
}

describe("Baseten provider registration", () => {
  it("registers authenticated live and network-free static catalogs", async () => {
    const provider = await registerSingleProviderPlugin(basetenPlugin);
    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "baseten-api-key",
    });
    const catalog = await runSingleProviderCatalog(provider, {
      resolveProviderAuth: () => ({
        apiKey: TEST_VALUE,
        discoveryApiKey: undefined,
        mode: "api_key",
        source: "env",
      }),
    });

    expect(provider).toMatchObject({
      id: "baseten",
      label: "Baseten",
      docsPath: "/providers/baseten",
      envVars: ["BASETEN_API_KEY"],
      resolveDynamicModel: expect.any(Function),
      resolveThinkingProfile: expect.any(Function),
      wrapStreamFn: expect.any(Function),
    });
    expect(choice?.provider.id).toBe("baseten");
    expect(choice?.method.id).toBe("api-key");
    expect(resolveAgentModelPrimaryValue(applyBasetenConfig({}).agents?.defaults?.model)).toBe(
      "baseten/thinkingmachines/inkling",
    );
    expect(catalog).toMatchObject({
      apiKey: TEST_VALUE,
      baseUrl: "https://inference.baseten.co/v1",
      api: "openai-completions",
    });
    expect(catalog.models).toHaveLength(12);
    expect(provider.staticCatalog).toBeDefined();
    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "deepseek-ai/DeepSeek-V4-Pro",
      } as never)?.dropReasoningFromHistory,
    ).not.toBe(true);
  });

  it("sets and clears chat-template thinking while preserving caller arguments", () => {
    expect(captureThinkingPayload("zai-org/GLM-5", "high")).toMatchObject({
      chat_template_args: { preserve_me: true, enable_thinking: true },
    });
    expect(captureThinkingPayload("moonshotai/Kimi-K2.6", "off")).toMatchObject({
      chat_template_args: { preserve_me: true, enable_thinking: false },
    });
    expect(captureThinkingPayload("NVIDIA/Nemotron-120B-A12B", undefined)).toMatchObject({
      chat_template_args: { preserve_me: true, enable_thinking: false },
    });
  });

  it("exposes opt-in thinking without duplicate reasoning levels", async () => {
    const provider = await registerSingleProviderPlugin(basetenPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "moonshotai/Kimi-K2.6",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "zai-org/GLM-5.2",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "thinkingmachines/inkling",
        reasoning: true,
      } as never),
    ).toBeUndefined();
  });

  it("leaves default-thinking models untouched", () => {
    expect(captureThinkingPayload("thinkingmachines/inkling", "high")).toEqual({
      chat_template_args: { preserve_me: true },
    });
  });

  it("normalizes DeepSeek V4 replay while preserving Baseten reasoning effort", () => {
    expect(captureDeepSeekReplayPayload(undefined)).toEqual({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
          reasoning_content: "",
        },
        { role: "assistant", content: "done", reasoning_content: "preserve me" },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    });
    expect(captureDeepSeekReplayPayload("high")).toEqual({
      reasoning_effort: "high",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
          reasoning_content: "",
        },
        { role: "assistant", content: "done", reasoning_content: "preserve me" },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    });
    expect(captureDeepSeekReplayPayload("off")).toEqual({
      reasoning_effort: "none",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
        { role: "assistant", content: "done" },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    });
  });

  it("uses Baseten's supported system role instead of developer", () => {
    const model = {
      ...basetenModel("thinkingmachines/inkling"),
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" as const },
    };
    const payload = buildOpenAICompletionsParams(
      model,
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      },
      { reasoning: "high", maxTokens: 32 },
    );

    const messages = payload.messages;
    expect(Array.isArray(messages)).toBe(true);
    if (!Array.isArray(messages)) {
      throw new Error("expected messages payload");
    }
    expect(messages[0]).toMatchObject({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "developer" })]),
    );
    expect(payload.max_tokens).toBe(32);
  });
});
