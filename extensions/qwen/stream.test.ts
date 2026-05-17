import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createQwenThinkingWrapper, wrapQwenProviderStream } from "./stream.js";

function capturePayload(params: {
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  thinkingFormat?: string;
  reasoning?: unknown;
  initialPayload?: Record<string, unknown>;
  model?: Partial<Model<"openai-completions">>;
}): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createQwenThinkingWrapper(
    baseStreamFn,
    params.thinkingLevel ?? "high",
    params.thinkingFormat,
  );
  void wrapped(
    {
      api: "openai-completions",
      provider: "qwen",
      id: "qwen3.6-plus",
      reasoning: true,
      ...params.model,
    } as Model<"openai-completions">,
    { messages: [] } as Context,
    params.reasoning === undefined ? {} : ({ reasoning: params.reasoning } as never),
  );

  return captured;
}

describe("createQwenThinkingWrapper", () => {
  it("maps disabled thinking to Qwen top-level enable_thinking", () => {
    const payload = capturePayload({
      reasoning: "none",
      initialPayload: {
        reasoning_effort: "high",
        reasoning: { effort: "high" },
        reasoningEffort: "high",
      },
    });

    expect(payload).toEqual({ enable_thinking: false });
  });

  it("maps enabled thinking to Qwen top-level enable_thinking", () => {
    expect(capturePayload({ reasoning: "medium" })).toEqual({ enable_thinking: true });
  });

  it("falls back to the session thinking level", () => {
    expect(capturePayload({ thinkingLevel: "off" })).toEqual({ enable_thinking: false });
    expect(capturePayload({ thinkingLevel: "high" })).toEqual({ enable_thinking: true });
  });

  it("overrides qwen-chat-template thinking with the session level", () => {
    expect(
      capturePayload({
        thinkingFormat: "qwen-chat-template",
        thinkingLevel: "off",
        initialPayload: {
          chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
          enable_thinking: true,
          reasoning_effort: "high",
        },
      }),
    ).toEqual({
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    });
  });

  it("uses the runtime model qwen-chat-template format when the wrapper context omits it", () => {
    expect(
      capturePayload({
        thinkingLevel: "off",
        model: { compat: { thinkingFormat: "qwen-chat-template" } },
        initialPayload: {
          chat_template_kwargs: { enable_thinking: true },
          enable_thinking: true,
        },
      }),
    ).toEqual({
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    });
  });

  it("skips non-reasoning and non-completions models", () => {
    expect(capturePayload({ model: { reasoning: false } })).toStrictEqual({});
    expect(capturePayload({ model: { api: "openai-responses" as never } })).toStrictEqual({});
  });
});

describe("wrapQwenProviderStream", () => {
  it("only registers for Qwen-family OpenAI-compatible providers", () => {
    const streamFn = wrapQwenProviderStream({
      provider: "qwencloud",
      modelId: "qwen3.6-plus",
      model: {
        api: "openai-completions",
        provider: "qwen",
        id: "qwen3.6-plus",
        reasoning: true,
      } as Model<"openai-completions">,
      streamFn: undefined,
    } as never);
    expect(streamFn).toBeTypeOf("function");

    expect(
      wrapQwenProviderStream({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-5.4",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });

  it("passes qwen-chat-template format to the Qwen wrapper", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {
        chat_template_kwargs: { enable_thinking: true },
        enable_thinking: true,
      };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = wrapQwenProviderStream({
      provider: "qwen",
      modelId: "qwen3.6-plus",
      model: {
        api: "openai-completions",
        provider: "qwen",
        id: "qwen3.6-plus",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      } as Model<"openai-completions">,
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never);

    void wrapped?.(
      {
        api: "openai-completions",
        provider: "qwen",
        id: "qwen3.6-plus",
        reasoning: true,
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(captured).toStrictEqual({
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    });
  });
});
