// Hugging Face stream tests cover Qwen thinking-mode payload normalization.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { wrapHuggingfaceProviderStream } from "./stream.js";

function capturePayload(params: {
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoning?: unknown;
  initialPayload?: Record<string, unknown>;
  model?: Partial<Model<"openai-completions">>;
}): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const baseStreamFn: StreamFn = (model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };
  const model = {
    api: "openai-completions",
    provider: "huggingface",
    id: "Qwen/Qwen3.5-9B",
    reasoning: true,
    compat: { thinkingFormat: "qwen-chat-template" },
    ...params.model,
  } as Model<"openai-completions">;
  const wrapped = wrapHuggingfaceProviderStream({
    provider: "huggingface",
    modelId: model.id,
    model,
    streamFn: baseStreamFn,
    thinkingLevel: params.thinkingLevel ?? "high",
  } as never);
  if (!wrapped) {
    return captured;
  }
  void wrapped(
    model,
    { messages: [] } as Context,
    params.reasoning === undefined ? {} : ({ reasoning: params.reasoning } as never),
  );
  return captured;
}

describe("Hugging Face Qwen thinking wrapper", () => {
  it("maps thinking off to Qwen chat-template kwargs", () => {
    expect(
      capturePayload({
        thinkingLevel: "off",
        initialPayload: {
          reasoning_effort: "high",
          reasoningEffort: "high",
          reasoning: { effort: "high" },
        },
      }),
    ).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    });
  });

  it("lets explicit per-call reasoning enable thinking", () => {
    expect(capturePayload({ thinkingLevel: "off", reasoning: "medium" })).toEqual({
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: true,
      },
    });
  });

  it("preserves existing chat-template kwargs", () => {
    expect(
      capturePayload({
        thinkingLevel: "off",
        initialPayload: {
          chat_template_kwargs: {
            preserve_thinking: false,
            force_nonempty_content: true,
          },
        },
      }),
    ).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: false,
        force_nonempty_content: true,
      },
    });
  });

  it("skips non-Qwen and non-Hugging-Face routes", () => {
    expect(
      capturePayload({
        model: { compat: undefined },
      }),
    ).toStrictEqual({});
    expect(
      capturePayload({
        model: { provider: "openrouter" },
      }),
    ).toStrictEqual({});
  });

  it("does not install a wrapper without the Qwen compat contract", () => {
    expect(
      wrapHuggingfaceProviderStream({
        provider: "huggingface",
        modelId: "Qwen/Qwen3-4B-Instruct-2507",
        model: {
          api: "openai-completions",
          provider: "huggingface",
          id: "Qwen/Qwen3-4B-Instruct-2507",
          compat: {},
        },
      } as never),
    ).toBeUndefined();
  });
});
