import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createVllmProviderThinkingWrapper,
  createVllmQwenThinkingWrapper,
  wrapVllmProviderStream,
} from "./stream.js";

function capturePayload(params: {
  format: "chat-template" | "top-level";
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
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

  const wrapped = createVllmQwenThinkingWrapper({
    baseStreamFn,
    format: params.format,
    thinkingLevel: params.thinkingLevel ?? "high",
  });
  void wrapped(
    {
      api: "openai-completions",
      provider: "vllm",
      id: "Qwen/Qwen3-8B",
      reasoning: true,
      ...params.model,
    } as Model<"openai-completions">,
    { messages: [] } as Context,
    params.reasoning === undefined ? {} : ({ reasoning: params.reasoning } as never),
  );

  return captured;
}

describe("createVllmQwenThinkingWrapper", () => {
  it("maps Qwen chat-template thinking off to chat_template_kwargs", () => {
    const payload = capturePayload({
      format: "chat-template",
      reasoning: "none",
      initialPayload: {
        reasoning_effort: "high",
        reasoning: { effort: "high" },
        reasoningEffort: "high",
      },
    });

    expect(payload).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    });
  });

  it("maps Qwen chat-template thinking on to chat_template_kwargs", () => {
    expect(capturePayload({ format: "chat-template", reasoning: "medium" })).toEqual({
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: true,
      },
    });
  });

  it("preserves explicit chat-template kwargs while setting enable_thinking", () => {
    expect(
      capturePayload({
        format: "chat-template",
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

  it("maps Qwen top-level thinking format to enable_thinking", () => {
    expect(capturePayload({ format: "top-level", thinkingLevel: "off" })).toEqual({
      enable_thinking: false,
    });
    expect(capturePayload({ format: "top-level", thinkingLevel: "high" })).toEqual({
      enable_thinking: true,
    });
  });

  it("skips non-reasoning and non-completions models", () => {
    expect(capturePayload({ format: "chat-template", model: { reasoning: false } })).toEqual({});
    expect(
      capturePayload({ format: "chat-template", model: { api: "openai-responses" as never } }),
    ).toEqual({});
  });
});

describe("createVllmProviderThinkingWrapper", () => {
  function captureProviderPayload(params: {
    thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
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

    const wrapped = createVllmProviderThinkingWrapper({
      baseStreamFn,
      thinkingLevel: params.thinkingLevel ?? "high",
    });
    void wrapped(
      {
        api: "openai-completions",
        provider: "vllm",
        id: "nemotron-3-super",
        reasoning: true,
        ...params.model,
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    return captured;
  }

  it("injects Nemotron 3 chat-template kwargs when thinking is off", () => {
    expect(captureProviderPayload({ thinkingLevel: "off" })).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        force_nonempty_content: true,
      },
    });
  });

  it("does not inject Nemotron 3 chat-template kwargs when thinking is enabled", () => {
    expect(captureProviderPayload({ thinkingLevel: "low" })).toEqual({});
  });

  it("preserves existing Nemotron 3 chat-template kwargs over defaults", () => {
    expect(
      captureProviderPayload({
        thinkingLevel: "off",
        initialPayload: {
          chat_template_kwargs: {
            enable_thinking: true,
          },
        },
      }),
    ).toEqual({
      chat_template_kwargs: {
        enable_thinking: true,
        force_nonempty_content: true,
      },
    });
  });

  it("skips non-Nemotron vLLM models", () => {
    expect(
      captureProviderPayload({
        thinkingLevel: "off",
        model: { id: "Qwen/Qwen3-8B" },
      }),
    ).toEqual({});
  });
});

describe("wrapVllmProviderStream", () => {
  it("registers when vLLM Qwen thinking format params are configured", () => {
    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        extraParams: { qwenThinkingFormat: "chat-template" },
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "Qwen/Qwen3-8B",
          reasoning: true,
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeTypeOf("function");

    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        extraParams: { qwen_thinking_format: "enable_thinking" },
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "Qwen/Qwen3-8B",
          reasoning: true,
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeTypeOf("function");
  });

  it("skips unconfigured vLLM and non-vLLM providers", () => {
    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        extraParams: {},
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "Qwen/Qwen3-8B",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();

    expect(
      wrapVllmProviderStream({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: { qwenThinkingFormat: "chat-template" },
        model: {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-5.4",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });

  it("registers for vLLM Nemotron when thinking is off", () => {
    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "nemotron-3-super",
        extraParams: {},
        thinkingLevel: "off",
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "nemotron-3-super",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeTypeOf("function");

    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "nemotron-3-super",
        extraParams: {},
        thinkingLevel: "low",
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "nemotron-3-super",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});
