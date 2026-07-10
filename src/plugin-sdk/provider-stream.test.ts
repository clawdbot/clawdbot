// Provider stream tests cover shared stream-wrapper families and payload compatibility.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { VERSION } from "../version.js";
import {
  composeProviderStreamWrappers as composeProviderStreamWrappersShared,
  createMoonshotThinkingWrapper as createMoonshotThinkingWrapperShared,
  createPlainTextToolCallCompatWrapper as createPlainTextToolCallCompatWrapperShared,
  createToolStreamWrapper as createToolStreamWrapperShared,
} from "./provider-stream-shared.js";
import {
  buildProviderStreamFamilyHooks,
  composeProviderStreamWrappers,
  createMoonshotThinkingWrapper,
  createPlainTextToolCallCompatWrapper,
  createToolStreamWrapper,
  GOOGLE_THINKING_STREAM_HOOKS,
  KILOCODE_THINKING_STREAM_HOOKS,
  MINIMAX_FAST_MODE_STREAM_HOOKS,
  MOONSHOT_THINKING_STREAM_HOOKS,
  OPENAI_RESPONSES_STREAM_HOOKS,
  OPENROUTER_THINKING_STREAM_HOOKS,
  TOOL_STREAM_DEFAULT_ON_HOOKS,
} from "./provider-stream.js";

function requireWrapStreamFn(
  wrapStreamFn: ReturnType<typeof buildProviderStreamFamilyHooks>["wrapStreamFn"],
) {
  expect(wrapStreamFn).toBeTypeOf("function");
  if (!wrapStreamFn) {
    throw new Error("expected wrapStreamFn to be defined");
  }
  return wrapStreamFn;
}

function requireStreamFn(streamFn: StreamFn | null | undefined) {
  expect(streamFn).toBeTypeOf("function");
  if (!streamFn) {
    throw new Error("expected wrapped streamFn to be defined");
  }
  return streamFn;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requirePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) {
    throw new Error("expected captured payload");
  }
  return payload;
}

function expectDefaultThinkingBudget(payload: Record<string, unknown>) {
  const config = requireRecord(payload.config, "payload.config");
  const thinkingConfig = requireRecord(config.thinkingConfig, "payload.config.thinkingConfig");
  expect(thinkingConfig.thinkingBudget).toBe(-1);
}

describe("createMoonshotThinkingWrapper", () => {
  it("sanitizes K2.7 after an async caller replaces the payload", async () => {
    let finalPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = async (model, _context, options) => {
      const payload = { model: model.id };
      const replacement = await options?.onPayload?.(payload, model);
      finalPayload = requireRecord(replacement ?? payload, "final payload");
      return {} as never;
    };
    const wrapped = createMoonshotThinkingWrapper(baseStreamFn, "disabled", "all");

    await wrapped({ api: "openai-completions", id: "kimi-k2.7-code" } as never, {} as never, {
      onPayload: async () => ({
        model: "kimi-k2.7-code",
        thinking: { type: "disabled" },
        reasoning_effort: "low",
        temperature: 0,
        top_p: 0.5,
        tool_choice: "required",
      }),
    });

    const payload = requirePayload(finalPayload);
    expect(payload).not.toHaveProperty("thinking");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("top_p");
    expect(payload.tool_choice).toBe("auto");
  });
});

describe("composeProviderStreamWrappers", () => {
  it("re-exports the shared wrapper composer", () => {
    expect(composeProviderStreamWrappers).toBe(composeProviderStreamWrappersShared);
  });

  it("re-exports shared helper wrappers", () => {
    expect(createMoonshotThinkingWrapper).toBe(createMoonshotThinkingWrapperShared);
    expect(createPlainTextToolCallCompatWrapper).toBe(createPlainTextToolCallCompatWrapperShared);
    expect(createToolStreamWrapper).toBe(createToolStreamWrapperShared);
  });

  it("applies wrappers left to right", () => {
    const order: string[] = [];
    const baseStreamFn: StreamFn = (_model, _context, _options) => {
      order.push("base");
      return {} as never;
    };

    const wrap =
      (label: string) =>
      (streamFn: StreamFn | undefined): StreamFn =>
      (model, context, options) => {
        order.push(`${label}:before`);
        const result = (streamFn ?? baseStreamFn)(model, context, options);
        order.push(`${label}:after`);
        return result;
      };

    const composed = requireStreamFn(
      composeProviderStreamWrappers(baseStreamFn, wrap("a"), undefined, wrap("b")),
    );

    void composed({} as never, {} as never, {});

    expect(order).toEqual(["b:before", "a:before", "base", "a:after", "b:after"]);
  });

  it("returns the original stream when no wrappers are provided", () => {
    const baseStreamFn: StreamFn = () => ({}) as never;
    expect(composeProviderStreamWrappers(baseStreamFn)).toBe(baseStreamFn);
  });
});

describe("buildProviderStreamFamilyHooks", () => {
  it("covers the stream family matrix", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    let capturedModelId: string | undefined;
    let capturedModelReasoning: boolean | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedReasoning: string | undefined;
    let payloadSeed: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      capturedModelId = model.id;
      capturedModelReasoning = model.reasoning;
      capturedReasoning = options?.reasoning;
      const payload = {
        model: model.id,
        config: { thinkingConfig: { thinkingBudget: -1 } },
        ...payloadSeed,
      } as Record<string, unknown>;
      payloadSeed = undefined;
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      capturedHeaders = options?.headers;
      return {} as never;
    };

    const googleHooks = GOOGLE_THINKING_STREAM_HOOKS;
    const googleStream = requireStreamFn(
      requireWrapStreamFn(googleHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
      } as never),
    );
    await googleStream(
      { api: "google-generative-ai", id: "gemini-3.1-pro-preview" } as never,
      {} as never,
      {},
    );
    const googlePayload = requirePayload(capturedPayload);
    const googleConfig = requireRecord(googlePayload.config, "google payload config");
    const googleThinkingConfig = requireRecord(
      googleConfig.thinkingConfig,
      "google thinking config",
    );
    expect(googleThinkingConfig.thinkingLevel).toBe("HIGH");
    expect(googleThinkingConfig).not.toHaveProperty("thinkingBudget");

    const minimaxHooks = MINIMAX_FAST_MODE_STREAM_HOOKS;
    const minimaxStream = requireStreamFn(
      requireWrapStreamFn(minimaxHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        extraParams: { fastMode: true },
      } as never),
    );
    await minimaxStream(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as never,
      {} as never,
      {},
    );
    expect(capturedModelId).toBe("MiniMax-M2.7-highspeed");

    const kilocodeHooks = KILOCODE_THINKING_STREAM_HOOKS;
    void requireStreamFn(
      requireWrapStreamFn(kilocodeHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "openai/gpt-5.4",
      } as never),
    )({ provider: "kilocode", id: "openai/gpt-5.4" } as never, {} as never, {});
    const kilocodeOpenAiPayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(kilocodeOpenAiPayload);
    expect(requireRecord(kilocodeOpenAiPayload.reasoning, "kilocode reasoning").effort).toBe(
      "high",
    );

    void requireStreamFn(
      requireWrapStreamFn(kilocodeHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "kilo/auto",
      } as never),
    )({ provider: "kilocode", id: "kilo/auto" } as never, {} as never, {});
    const kilocodeAutoPayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(kilocodeAutoPayload);
    expect(kilocodeAutoPayload).not.toHaveProperty("reasoning");

    const moonshotHooks = MOONSHOT_THINKING_STREAM_HOOKS;
    const moonshotStream = requireStreamFn(
      requireWrapStreamFn(moonshotHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "off",
      } as never),
    );
    await moonshotStream({ api: "openai-completions", id: "kimi-k2.5" } as never, {} as never, {});
    const moonshotDisabledPayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(moonshotDisabledPayload);
    expect(requireRecord(moonshotDisabledPayload.thinking, "moonshot thinking").type).toBe(
      "disabled",
    );

    const moonshotKeepStream = requireStreamFn(
      requireWrapStreamFn(moonshotHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "low",
        extraParams: { thinking: { type: "enabled", keep: "all" } },
      } as never),
    );
    await moonshotKeepStream(
      { api: "openai-completions", id: "kimi-k2.6" } as never,
      {} as never,
      {},
    );
    const moonshotKeepPayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(moonshotKeepPayload);
    const moonshotKeepThinking = requireRecord(
      moonshotKeepPayload.thinking,
      "moonshot keep thinking",
    );
    expect(moonshotKeepThinking.type).toBe("enabled");
    expect(moonshotKeepThinking.keep).toBe("all");

    await moonshotKeepStream(
      { api: "openai-completions", id: "kimi-k2.5" } as never,
      {} as never,
      {},
    );
    const moonshotStrippedPayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(moonshotStrippedPayload);
    const moonshotStrippedThinking = requireRecord(
      moonshotStrippedPayload.thinking,
      "moonshot stripped thinking",
    );
    expect(moonshotStrippedThinking.type).toBe("enabled");
    expect(moonshotStrippedThinking).not.toHaveProperty("keep");

    payloadSeed = { tool_choice: { type: "tool", name: "read" } };
    await moonshotKeepStream(
      { api: "openai-completions", id: "kimi-k2.6" } as never,
      {} as never,
      {},
    );
    const moonshotToolChoicePayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(moonshotToolChoicePayload);
    expect(requireRecord(moonshotToolChoicePayload.tool_choice, "tool choice")).toEqual({
      type: "tool",
      name: "read",
    });
    const moonshotToolChoiceThinking = requireRecord(
      moonshotToolChoicePayload.thinking,
      "moonshot tool-choice thinking",
    );
    expect(moonshotToolChoiceThinking.type).toBe("disabled");
    expect(moonshotToolChoiceThinking).not.toHaveProperty("keep");

    payloadSeed = {
      tool_choice: { type: "tool", name: "read" },
      temperature: 0,
      top_p: 0.5,
      n: 2,
      presence_penalty: 1,
      frequency_penalty: 1,
      reasoning_effort: "low",
    };
    await moonshotKeepStream(
      { api: "openai-completions", id: "kimi-k2.7-code", reasoning: false } as never,
      {} as never,
      {},
    );
    const moonshotK27Payload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(moonshotK27Payload);
    expect(moonshotK27Payload).not.toHaveProperty("thinking");
    expect(moonshotK27Payload).not.toHaveProperty("reasoning_effort");
    expect(moonshotK27Payload.tool_choice).toBe("auto");
    expect(moonshotK27Payload).not.toHaveProperty("temperature");
    expect(moonshotK27Payload).not.toHaveProperty("top_p");
    expect(moonshotK27Payload).not.toHaveProperty("n");
    expect(moonshotK27Payload).not.toHaveProperty("presence_penalty");
    expect(moonshotK27Payload).not.toHaveProperty("frequency_penalty");
    expect(capturedReasoning).toBe("low");
    expect(capturedModelReasoning).toBe(true);

    const openAiHooks = OPENAI_RESPONSES_STREAM_HOOKS;
    payloadSeed = { reasoning: { effort: "medium", summary: "auto" } };
    void requireStreamFn(
      requireWrapStreamFn(openAiHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "max",
        extraParams: { serviceTier: "flex" },
        config: {},
        agentDir: "/tmp/provider-stream-test",
      } as never),
    )(
      {
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.6-sol",
        thinkingLevelMap: { max: "max" },
      } as never,
      {} as never,
      {},
    );
    const openAiPayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(openAiPayload);
    expect(openAiPayload.reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(openAiPayload.service_tier).toBe("flex");
    expect(capturedHeaders).toEqual({
      "User-Agent": `openclaw/${VERSION}`,
      originator: "openclaw",
      version: VERSION,
    });

    const openRouterHooks = OPENROUTER_THINKING_STREAM_HOOKS;
    void requireStreamFn(
      requireWrapStreamFn(openRouterHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "openai/gpt-5.4",
      } as never),
    )({ provider: "openrouter", id: "openai/gpt-5.4" } as never, {} as never, {});
    const openRouterOpenAiPayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(openRouterOpenAiPayload);
    expect(requireRecord(openRouterOpenAiPayload.reasoning, "openrouter reasoning").effort).toBe(
      "high",
    );

    void requireStreamFn(
      requireWrapStreamFn(openRouterHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "x-ai/grok-3",
      } as never),
    )({ provider: "openrouter", id: "x-ai/grok-3" } as never, {} as never, {});
    const openRouterGrokPayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(openRouterGrokPayload);
    expect(openRouterGrokPayload).not.toHaveProperty("reasoning");

    const toolStreamHooks = TOOL_STREAM_DEFAULT_ON_HOOKS;
    const toolStreamDefault = requireStreamFn(
      requireWrapStreamFn(toolStreamHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        extraParams: {},
      } as never),
    );
    await toolStreamDefault({ id: "glm-4.7" } as never, {} as never, {});
    const toolStreamDefaultPayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(toolStreamDefaultPayload);
    expect(toolStreamDefaultPayload.tool_stream).toBe(true);

    const toolStreamDisabled = requireStreamFn(
      requireWrapStreamFn(toolStreamHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        extraParams: { tool_stream: false },
      } as never),
    );
    await toolStreamDisabled({ id: "glm-4.7" } as never, {} as never, {});
    const toolStreamDisabledPayload = requirePayload(capturedPayload);
    expectDefaultThinkingBudget(toolStreamDisabledPayload);
    expect(toolStreamDisabledPayload).not.toHaveProperty("tool_stream");
  });

  it("exposes canonical stream hook constants for reused families", () => {
    expect(GOOGLE_THINKING_STREAM_HOOKS.wrapStreamFn).toBeTypeOf("function");
    expect(KILOCODE_THINKING_STREAM_HOOKS.wrapStreamFn).toBeTypeOf("function");
    expect(MINIMAX_FAST_MODE_STREAM_HOOKS.wrapStreamFn).toBeTypeOf("function");
    expect(MOONSHOT_THINKING_STREAM_HOOKS.wrapStreamFn).toBeTypeOf("function");
    expect(OPENAI_RESPONSES_STREAM_HOOKS.wrapStreamFn).toBeTypeOf("function");
    expect(OPENROUTER_THINKING_STREAM_HOOKS.wrapStreamFn).toBeTypeOf("function");
    expect(TOOL_STREAM_DEFAULT_ON_HOOKS.wrapStreamFn).toBeTypeOf("function");
  });
});

describe("createPlainTextToolCallCompatWrapper", () => {
  it("streams normal prose that starts with a Harmony channel word", async () => {
    let pushSourceEvent: ((event: never) => void) | undefined;
    const baseStreamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      pushSourceEvent = (event) => stream.push(event);
      return stream;
    };
    const wrapped = requireStreamFn(createPlainTextToolCallCompatWrapper(baseStreamFn));
    const output = wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>;
    const iterator = output[Symbol.asyncIterator]();
    const first = iterator.next();

    pushSourceEvent?.({
      type: "text_delta",
      contentIndex: 0,
      delta: "final answer starts here",
      partial: { role: "assistant", content: "final answer starts here" },
    } as never);

    const firstResult = await Promise.race([
      first,
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 20);
      }),
    ]);
    expect(firstResult).not.toBe("timeout");
    expect(firstResult).toMatchObject({
      done: false,
      value: { type: "text_delta", delta: "final answer starts here" },
    });

    pushSourceEvent?.({
      type: "done",
      message: { role: "assistant", content: "final answer starts here" },
    } as never);
    await iterator.next();
  });
});
