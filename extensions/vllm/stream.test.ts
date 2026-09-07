// Vllm tests cover stream plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createVllmQwenThinkingWrapper, wrapVllmProviderStream } from "./stream.js";

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

  it("patches configured Qwen models unless reasoning is explicitly disabled", () => {
    expect(capturePayload({ format: "chat-template", model: { reasoning: undefined } })).toEqual({
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: true,
      },
    });
    expect(capturePayload({ format: "chat-template", model: { reasoning: false } })).toStrictEqual(
      {},
    );
  });

  it("skips non-completions models", () => {
    expect(
      capturePayload({ format: "chat-template", model: { api: "openai-responses" as never } }),
    ).toStrictEqual({});
  });
});

describe("vLLM provider thinking composition", () => {
  function captureProviderPayload(params: {
    thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
    initialPayload?: Record<string, unknown>;
    contextModelId?: string;
    model?: Partial<Model<"openai-completions">>;
  }): Record<string, unknown> {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = { ...params.initialPayload };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };

    const model = {
      api: "openai-completions",
      provider: "vllm",
      id: "nemotron-3-super",
      reasoning: true,
      ...params.model,
    } as Model<"openai-completions">;
    const wrapped = wrapVllmProviderStream({
      provider: "vllm",
      modelId: params.contextModelId ?? model.id,
      model,
      thinkingLevel: params.thinkingLevel ?? "high",
      streamFn: baseStreamFn,
    } as never);
    void wrapped?.(model, { messages: [] } as Context, {});

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
    expect(captureProviderPayload({ thinkingLevel: "low" })).toStrictEqual({});
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

  it("composes Qwen thinking before runtime Nemotron payload defaults", () => {
    expect(
      captureProviderPayload({
        thinkingLevel: "off",
        contextModelId: "Qwen/Qwen3-8B",
        model: {
          compat: { thinkingFormat: "qwen-chat-template" },
        },
      }),
    ).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
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
    ).toStrictEqual({});
  });

  // Regression: see the matching DeepSeek V4 alias test below for why a
  // leading `\b` anchor breaks "_"-joined served-model-name aliases.
  it("injects Nemotron 3 chat-template kwargs for underscore-prefixed aliases", () => {
    const aliasId = "yk_nemotron-3-super";
    expect(
      captureProviderPayload({
        thinkingLevel: "off",
        contextModelId: aliasId,
        model: { id: aliasId },
      }),
    ).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        force_nonempty_content: true,
      },
    });
  });
});

describe("vLLM DeepSeek-V4 thinking composition", () => {
  function captureDeepSeekV4Payload(params: {
    thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
    initialPayload?: Record<string, unknown>;
    modelId?: string;
  }): Record<string, unknown> {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = { ...params.initialPayload };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };

    const modelId = params.modelId ?? "deepseek-ai/DeepSeek-V4-Flash";
    const model = {
      api: "openai-completions",
      provider: "vllm",
      id: modelId,
      reasoning: true,
    } as Model<"openai-completions">;
    const wrapped = wrapVllmProviderStream({
      provider: "vllm",
      modelId,
      model,
      thinkingLevel: params.thinkingLevel ?? "high",
      streamFn: baseStreamFn,
    } as never);
    void wrapped?.(model, { messages: [] } as Context, {});

    return captured;
  }

  it("injects Think High chat-template kwargs", () => {
    expect(captureDeepSeekV4Payload({ thinkingLevel: "high" })).toEqual({
      chat_template_kwargs: {
        thinking: true,
        reasoning_effort: "high",
      },
    });
  });

  it("injects Think Max chat-template kwargs", () => {
    expect(captureDeepSeekV4Payload({ thinkingLevel: "max" })).toEqual({
      chat_template_kwargs: {
        thinking: true,
        reasoning_effort: "max",
      },
    });
    expect(captureDeepSeekV4Payload({ thinkingLevel: "xhigh" })).toEqual({
      chat_template_kwargs: {
        thinking: true,
        reasoning_effort: "max",
      },
    });
  });

  it("does not inject chat-template kwargs when thinking is off (vLLM default is non-think)", () => {
    expect(captureDeepSeekV4Payload({ thinkingLevel: "off" })).toStrictEqual({});
  });

  it("preserves existing chat-template kwargs over generated defaults", () => {
    expect(
      captureDeepSeekV4Payload({
        thinkingLevel: "high",
        initialPayload: {
          chat_template_kwargs: {
            reasoning_effort: "max",
          },
        },
      }),
    ).toEqual({
      chat_template_kwargs: {
        thinking: true,
        reasoning_effort: "max",
      },
    });
  });

  it("matches self-hosted DeepSeek V4 Pro/Flash ids case-insensitively", () => {
    for (const modelId of ["deepseek-v4-pro", "DeepSeek-V4-Flash-0731", "deepseek_v4_pro"]) {
      expect(captureDeepSeekV4Payload({ thinkingLevel: "high", modelId })).toEqual({
        chat_template_kwargs: {
          thinking: true,
          reasoning_effort: "high",
        },
      });
    }
  });

  // Regression: vLLM's --served-model-name lets operators alias the upstream
  // checkpoint id however they like, and joining an org/user tag with "_"
  // (e.g. "yk_deepseek_v4") is common. "_" is a regex word character, so a
  // leading `\b` anchor in the id matcher would sit right at that alias
  // boundary and never match, silently disabling reasoning for the alias.
  it("matches underscore-prefixed served-model-name aliases like yk_deepseek_v4", () => {
    for (const modelId of ["yk_deepseek_v4", "yk_deepseek_v4_pro", "team_deepseek-v4-flash"]) {
      expect(captureDeepSeekV4Payload({ thinkingLevel: "high", modelId })).toEqual({
        chat_template_kwargs: {
          thinking: true,
          reasoning_effort: "high",
        },
      });
    }
  });

  it("skips non-DeepSeek-V4 vLLM models", () => {
    expect(
      captureDeepSeekV4Payload({ thinkingLevel: "high", modelId: "Qwen/Qwen3-8B" }),
    ).toStrictEqual({});
  });

  // Regression coverage: this wrapper must stay registered (non-undefined) at
  // every thinking level, including "off"/unset. extra-params.ts only skips
  // its own DeepSeek V4 fallback (which sends the hosted-API `thinking: {
  // type }` shape vLLM chat templates reject) when this plugin's wrapper is
  // defined and distinct from the unwrapped base stream function. Gating
  // registration on a non-off thinking level would leave the default "off"
  // request path routed through that incompatible fallback.
  it.each([{ thinkingLevel: "off" as const }, { thinkingLevel: undefined }])(
    "stays registered for DeepSeek-V4 models at thinkingLevel=$thinkingLevel",
    ({ thinkingLevel }) => {
      const modelId = "deepseek-ai/DeepSeek-V4-Pro";
      const model = {
        api: "openai-completions",
        provider: "vllm",
        id: modelId,
        reasoning: true,
      } as Model<"openai-completions">;
      const baseStreamFn: StreamFn = () => ({}) as ReturnType<StreamFn>;
      const wrapped = wrapVllmProviderStream({
        provider: "vllm",
        modelId,
        model,
        thinkingLevel,
        streamFn: baseStreamFn,
      } as never);

      expect(wrapped).toBeTypeOf("function");
      expect(wrapped).not.toBe(baseStreamFn);
    },
  );
});

describe("wrapVllmProviderStream", () => {
  it("registers when vLLM Qwen thinking format compat is configured", () => {
    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        extraParams: {},
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "Qwen/Qwen3-8B",
          reasoning: true,
          compat: { thinkingFormat: "qwen-chat-template" },
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeTypeOf("function");
  });

  it("ignores request params when Qwen thinking format compat is not configured", () => {
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
    ).toBeUndefined();
  });

  it("uses model compat for Qwen thinking format", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {};
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: "vllm",
      id: "Qwen/Qwen3-8B",
      reasoning: true,
      compat: { thinkingFormat: "qwen-chat-template" },
    } as unknown as Model<"openai-completions">;
    const wrapped = wrapVllmProviderStream({
      provider: "vllm",
      modelId: "Qwen/Qwen3-8B",
      extraParams: {},
      thinkingLevel: "off",
      model,
      streamFn: baseStreamFn,
    } as never);

    expect(wrapped).toBeTypeOf("function");
    void wrapped?.(model, { messages: [] } as Context, {});

    expect(captured).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    });
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
        extraParams: {},
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
