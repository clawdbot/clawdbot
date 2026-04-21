import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  composeProviderStreamWrappers as composeProviderStreamWrappersShared,
  createMoonshotThinkingWrapper as createMoonshotThinkingWrapperShared,
  createToolStreamWrapper as createToolStreamWrapperShared,
} from "./provider-stream-shared.js";
import {
  buildProviderStreamFamilyHooks,
  composeProviderStreamWrappers,
  createMoonshotThinkingWrapper,
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

describe("composeProviderStreamWrappers", () => {
  it("re-exports the shared wrapper composer", () => {
    expect(composeProviderStreamWrappers).toBe(composeProviderStreamWrappersShared);
  });

  it("re-exports shared helper wrappers", () => {
    expect(createMoonshotThinkingWrapper).toBe(createMoonshotThinkingWrapperShared);
    expect(createToolStreamWrapper).toBe(createToolStreamWrapperShared);
  });

  it("applies wrappers left to right", async () => {
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

    const composed = composeProviderStreamWrappers(baseStreamFn, wrap("a"), undefined, wrap("b"));

    expect(typeof composed).toBe("function");
    void composed?.({} as never, {} as never, {});

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
    let capturedHeaders: Record<string, string> | undefined;
    let payloadSeed: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      capturedModelId = model.id;
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
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingLevel: "HIGH" } },
    });
    const googleThinkingConfig = (
      (capturedPayload as Record<string, unknown>).config as Record<string, unknown>
    ).thinkingConfig as Record<string, unknown>;
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
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      reasoning: { effort: "high" },
    });

    void requireStreamFn(
      requireWrapStreamFn(kilocodeHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "kilo/auto",
      } as never),
    )({ provider: "kilocode", id: "kilo/auto" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
    });
    expect(capturedPayload).not.toHaveProperty("reasoning");

    const moonshotHooks = MOONSHOT_THINKING_STREAM_HOOKS;
    const moonshotStream = requireStreamFn(
      requireWrapStreamFn(moonshotHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "off",
      } as never),
    );
    await moonshotStream({ api: "openai-completions", id: "kimi-k2.5" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      thinking: { type: "disabled" },
    });

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
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      thinking: { type: "enabled", keep: "all" },
    });

    await moonshotKeepStream(
      { api: "openai-completions", id: "kimi-k2.5" } as never,
      {} as never,
      {},
    );
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      thinking: { type: "enabled" },
    });
    expect((capturedPayload?.thinking as Record<string, unknown>) ?? {}).not.toHaveProperty("keep");

    payloadSeed = { tool_choice: { type: "tool", name: "read" } };
    await moonshotKeepStream(
      { api: "openai-completions", id: "kimi-k2.6" } as never,
      {} as never,
      {},
    );
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      tool_choice: { type: "tool", name: "read" },
      thinking: { type: "disabled" },
    });
    expect((capturedPayload?.thinking as Record<string, unknown>) ?? {}).not.toHaveProperty("keep");

    const openAiHooks = OPENAI_RESPONSES_STREAM_HOOKS;
    void requireStreamFn(
      requireWrapStreamFn(openAiHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        extraParams: { serviceTier: "flex" },
        config: {},
        agentDir: "/tmp/provider-stream-test",
      } as never),
    )(
      {
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
      } as never,
      {} as never,
      {},
    );
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      service_tier: "flex",
    });
    expect(capturedHeaders).toBeDefined();

    const openRouterHooks = OPENROUTER_THINKING_STREAM_HOOKS;
    void requireStreamFn(
      requireWrapStreamFn(openRouterHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "openai/gpt-5.4",
      } as never),
    )({ provider: "openrouter", id: "openai/gpt-5.4" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      reasoning: { effort: "high" },
    });

    void requireStreamFn(
      requireWrapStreamFn(openRouterHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        thinkingLevel: "high",
        modelId: "x-ai/grok-3",
      } as never),
    )({ provider: "openrouter", id: "x-ai/grok-3" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
    });
    expect(capturedPayload).not.toHaveProperty("reasoning");

    const toolStreamHooks = TOOL_STREAM_DEFAULT_ON_HOOKS;
    const toolStreamDefault = requireStreamFn(
      requireWrapStreamFn(toolStreamHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        extraParams: {},
      } as never),
    );
    await toolStreamDefault({ id: "glm-4.7" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      tool_stream: true,
    });

    const toolStreamDisabled = requireStreamFn(
      requireWrapStreamFn(toolStreamHooks.wrapStreamFn)({
        streamFn: baseStreamFn,
        extraParams: { tool_stream: false },
      } as never),
    );
    await toolStreamDisabled({ id: "glm-4.7" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
    });
    expect(capturedPayload).not.toHaveProperty("tool_stream");
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
