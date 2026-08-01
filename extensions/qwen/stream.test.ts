// Qwen tests cover stream plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
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

  it.each(
    ["qwen-token-plan", "bailian-token-plan"].flatMap((providerId) =>
      ["kimi-k2.7-code", "MiniMax-M2.5"].map((modelId) => [providerId, modelId] as const),
    ),
  )("keeps thinking enabled for %s/%s", (providerId, modelId) => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: providerId,
      id: modelId,
      reasoning: true,
    } as Model<"openai-completions">;
    const wrapped = wrapQwenProviderStream({
      provider: providerId,
      modelId: model.id,
      model,
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never);

    void wrapped?.(model, { messages: [] } as Context, { reasoning: "none" } as never);

    expect(captured).toStrictEqual({ enable_thinking: true });
  });

  it.each(["kimi-k2.7-code", "MiniMax-M2.5"])(
    "forces thinking for %s when configured catalog metadata disables reasoning",
    (modelId) => {
      let captured: Record<string, unknown> = {};
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        const payload: Record<string, unknown> = {};
        options?.onPayload?.(payload, _model);
        captured = payload;
        return {} as ReturnType<StreamFn>;
      };
      const model = {
        api: "openai-completions",
        provider: "qwen-token-plan",
        id: modelId,
        reasoning: false,
      } as Model<"openai-completions">;
      const wrapped = wrapQwenProviderStream({
        provider: model.provider,
        modelId,
        model,
        streamFn: baseStreamFn,
        thinkingLevel: "off",
      } as never);

      void wrapped?.(model, { messages: [] } as Context, { reasoning: "none" } as never);

      expect(captured).toStrictEqual({ enable_thinking: true });
    },
  );

  it.each(
    ["qwen-token-plan", "bailian-token-plan"].flatMap((providerId) =>
      ["deepseek-v4-pro", "deepseek-v4-flash"].map((modelId) => [providerId, modelId] as const),
    ),
  )("uses DashScope DeepSeek V4 thinking and replay fields for %s/%s", (providerId, modelId) => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "enabled" },
        messages: [
          { role: "assistant", content: "earlier answer" },
          { role: "user", content: "continue" },
        ],
      };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: providerId,
      id: modelId,
      reasoning: true,
    } as Model<"openai-completions">;
    const wrapped = wrapQwenProviderStream({
      provider: providerId,
      modelId,
      model,
      streamFn: baseStreamFn,
      thinkingLevel: "max",
    } as never);

    void wrapped?.(model, { messages: [] } as Context, {});

    expect(captured).toStrictEqual({
      messages: [
        { role: "assistant", content: "earlier answer", reasoning_content: "" },
        { role: "user", content: "continue" },
      ],
      enable_thinking: true,
      reasoning_effort: "max",
    });
  });

  it("strips DeepSeek V4 replay reasoning when Token Plan thinking is off", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [
          { role: "assistant", content: "earlier answer", reasoning_content: "earlier reasoning" },
        ],
        thinking: { type: "disabled" },
        reasoning_effort: "max",
      };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: "qwen-token-plan",
      id: "deepseek-v4-pro",
      reasoning: true,
    } as Model<"openai-completions">;
    const wrapped = wrapQwenProviderStream({
      provider: model.provider,
      modelId: model.id,
      model,
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never);

    void wrapped?.(model, { messages: [] } as Context, {});

    expect(captured).toStrictEqual({
      messages: [{ role: "assistant", content: "earlier answer" }],
      enable_thinking: false,
    });
  });

  it.each(["qwen-token-plan", "bailian-token-plan"])(
    "backfills Kimi thinking tool-call replay for %s",
    (providerId) => {
      let captured: Record<string, unknown> = {};
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        const payload: Record<string, unknown> = {
          thinking: { type: "enabled" },
          reasoning_effort: "high",
          tool_choice: "required",
          messages: [
            { role: "user", content: "continue" },
            {
              role: "assistant",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
              ],
            },
            {
              role: "assistant",
              reasoning_content: "native reasoning",
              tool_calls: [
                { id: "call_2", type: "function", function: { name: "read", arguments: "{}" } },
              ],
            },
            { role: "assistant", content: "done" },
          ],
        };
        options?.onPayload?.(payload, _model);
        captured = payload;
        return {} as ReturnType<StreamFn>;
      };
      const model = {
        api: "openai-completions",
        provider: providerId,
        id: "kimi-k2.6",
        reasoning: true,
      } as Model<"openai-completions">;
      const wrapped = wrapQwenProviderStream({
        provider: providerId,
        modelId: model.id,
        model,
        streamFn: baseStreamFn,
        thinkingLevel: "high",
      } as never);

      void wrapped?.(model, { messages: [] } as Context, {});

      expect(captured).toStrictEqual({
        messages: [
          { role: "user", content: "continue" },
          {
            role: "assistant",
            reasoning_content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
          {
            role: "assistant",
            reasoning_content: "native reasoning",
            tool_calls: [
              { id: "call_2", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
          { role: "assistant", content: "done" },
        ],
        enable_thinking: true,
        tool_choice: "auto",
      });
    },
  );

  it("does not backfill Kimi tool-call replay when thinking is disabled", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: "qwen-token-plan",
      id: "kimi-k2.6",
      reasoning: true,
    } as Model<"openai-completions">;
    const wrapped = wrapQwenProviderStream({
      provider: model.provider,
      modelId: model.id,
      model,
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never);

    void wrapped?.(model, { messages: [] } as Context, {});

    expect(captured).toStrictEqual({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
      ],
      enable_thinking: false,
    });
  });

  it.each([
    {
      modelId: "kimi-k2.7-code",
      thinkingLevel: "off",
      callerOverride: {
        enable_thinking: false,
        thinking: { type: "disabled" },
        reasoning_effort: "max",
        tool_choice: { type: "function", function: { name: "read" } },
      },
      expected: { enable_thinking: true, tool_choice: "auto" },
    },
    {
      modelId: "MiniMax-M2.5",
      thinkingLevel: "off",
      callerOverride: {
        enable_thinking: false,
        thinking: { type: "disabled" },
        reasoning_effort: "max",
        tool_choice: { type: "function", function: { name: "read" } },
      },
      expected: { enable_thinking: true, tool_choice: "auto" },
    },
    {
      modelId: "glm-5.1",
      thinkingLevel: "max",
      callerOverride: {
        enable_thinking: true,
        thinking: { type: "enabled" },
        reasoning_effort: "max",
      },
      expected: { enable_thinking: true, reasoning_effort: "xhigh" },
    },
    {
      modelId: "glm-5.2",
      thinkingLevel: "high",
      callerOverride: {
        enable_thinking: true,
        reasoning_effort: "none",
      },
      expected: { enable_thinking: true, reasoning_effort: "none" },
    },
    {
      modelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      callerOverride: {
        enable_thinking: true,
        reasoning_effort: "xhigh",
      },
      expected: { enable_thinking: true, reasoning_effort: "max" },
    },
    {
      modelId: "glm-5.2",
      thinkingLevel: "high",
      callerOverride: {
        enable_thinking: true,
        reasoning_effort: "off",
        tool_choice: "required",
      },
      expected: { enable_thinking: false, tool_choice: "required" },
    },
    {
      modelId: "qwen3.7-plus",
      thinkingLevel: "high",
      callerOverride: {
        enable_thinking: true,
        tool_choice: { type: "none" },
      },
      expected: { enable_thinking: true, tool_choice: "none" },
    },
  ] as const)(
    "reapplies Token Plan wire constraints after caller hooks for $modelId",
    ({ modelId, thinkingLevel, callerOverride, expected }) => {
      let captured: Record<string, unknown> = {};
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        const payload: Record<string, unknown> = { messages: [] };
        options?.onPayload?.(payload, _model);
        captured = payload;
        return {} as ReturnType<StreamFn>;
      };
      const model = {
        api: "openai-completions",
        provider: "qwen-token-plan",
        id: modelId,
        reasoning: true,
      } as Model<"openai-completions">;
      const wrapped = wrapQwenProviderStream({
        provider: model.provider,
        modelId,
        model,
        streamFn: baseStreamFn,
        thinkingLevel,
      } as never);

      void wrapped?.(
        model,
        { messages: [] } as Context,
        {
          onPayload(payload: unknown) {
            Object.assign(payload as Record<string, unknown>, callerOverride);
          },
        } as never,
      );

      expect(captured).toStrictEqual({ messages: [], ...expected });
    },
  );

  it("keeps pinned Kimi tool choice by disabling thinking before replay backfill", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
        ],
        tool_choice: { type: "function", function: { name: "read" } },
      };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: "qwen-token-plan",
      id: "kimi-k2.6",
      reasoning: true,
    } as Model<"openai-completions">;
    const wrapped = wrapQwenProviderStream({
      provider: model.provider,
      modelId: model.id,
      model,
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(model, { messages: [] } as Context, {});

    expect(captured).toStrictEqual({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
      ],
      enable_thinking: false,
      tool_choice: { type: "function", function: { name: "read" } },
    });
  });

  it("leaves non-reasoning legacy custom models untouched", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [],
        reasoning_effort: "custom",
        tool_choice: "required",
      };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: "bailian-token-plan",
      id: "custom-model",
      reasoning: false,
    } as Model<"openai-completions">;
    const wrapped = wrapQwenProviderStream({
      provider: model.provider,
      modelId: model.id,
      model,
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(model, { messages: [] } as Context, {});

    expect(captured).toStrictEqual({
      messages: [],
      reasoning_effort: "custom",
      tool_choice: "required",
    });
  });

  it.each([
    { providerId: "qwen-token-plan", modelId: "custom-model" },
    { providerId: "bailian-token-plan", modelId: "qwen3.7-plus" },
  ])(
    "preserves explicit qwen-chat-template transport for $providerId/$modelId",
    ({ providerId, modelId }) => {
      let captured: Record<string, unknown> = {};
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        const payload: Record<string, unknown> = {
          chat_template_kwargs: { enable_thinking: true },
          enable_thinking: true,
        };
        options?.onPayload?.(payload, _model);
        captured = payload;
        return {} as ReturnType<StreamFn>;
      };
      const model = {
        api: "openai-completions",
        provider: providerId,
        id: modelId,
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      } as Model<"openai-completions">;
      const wrapped = wrapQwenProviderStream({
        provider: providerId,
        modelId: model.id,
        model,
        streamFn: baseStreamFn,
        thinkingLevel: "off",
      } as never);

      void wrapped?.(model, { messages: [] } as Context, {});

      expect(captured).toStrictEqual({
        chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
      });
    },
  );

  it("defers explicit non-Qwen legacy thinking formats to the configured transport", () => {
    const baseStreamFn: StreamFn = () => ({}) as ReturnType<StreamFn>;
    const model = {
      api: "openai-completions",
      provider: "bailian-token-plan",
      id: "deepseek-v4-pro",
      reasoning: true,
      compat: { thinkingFormat: "deepseek" },
    } as Model<"openai-completions">;

    expect(
      wrapQwenProviderStream({
        provider: model.provider,
        modelId: model.id,
        model,
        streamFn: baseStreamFn,
        thinkingLevel: "high",
      } as never),
    ).toBe(baseStreamFn);
  });

  it("forces GLM tool streaming after caller hooks", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [],
        tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: "qwen-token-plan",
      id: "glm-5.2",
      reasoning: true,
    } as Model<"openai-completions">;
    const wrapped = wrapQwenProviderStream({
      provider: model.provider,
      modelId: model.id,
      model,
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(
      model,
      { messages: [] } as Context,
      {
        onPayload(payload: unknown) {
          (payload as Record<string, unknown>).tool_stream = false;
        },
      } as never,
    );

    expect(captured).toStrictEqual({
      messages: [],
      tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      enable_thinking: true,
      reasoning_effort: "high",
      tool_stream: true,
    });
  });

  it("reapplies Token Plan constraints after asynchronous caller hooks", async () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = async (_model, _context, options) => {
      const payload: Record<string, unknown> = { messages: [] };
      await options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as Awaited<ReturnType<StreamFn>>;
    };
    const model = {
      api: "openai-completions",
      provider: "qwen-token-plan",
      id: "kimi-k2.7-code",
      reasoning: true,
    } as Model<"openai-completions">;
    const wrapped = wrapQwenProviderStream({
      provider: model.provider,
      modelId: model.id,
      model,
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never);

    await wrapped?.(
      model,
      { messages: [] } as Context,
      {
        async onPayload(payload: unknown) {
          await Promise.resolve();
          Object.assign(payload as Record<string, unknown>, {
            enable_thinking: false,
            reasoning_effort: "max",
            tool_choice: "required",
          });
        },
      } as never,
    );

    expect(captured).toStrictEqual({
      messages: [],
      enable_thinking: true,
      tool_choice: "auto",
    });
  });

  it.each([
    {
      modelId: "qwen3.7-plus",
      thinkingLevel: "off",
      expected: { messages: [], enable_thinking: false },
    },
    {
      modelId: "glm-5.2",
      thinkingLevel: "max",
      expected: { messages: [], enable_thinking: true, reasoning_effort: "max" },
    },
    {
      modelId: "deepseek-v4-pro",
      thinkingLevel: "max",
      expected: { messages: [], enable_thinking: true, reasoning_effort: "max" },
    },
  ] as const)(
    "preserves requested thinking when caller hooks replace the $modelId payload",
    async ({ modelId, thinkingLevel, expected }) => {
      let captured: Record<string, unknown> = {};
      const baseStreamFn: StreamFn = async (_model, _context, options) => {
        const payload: Record<string, unknown> = { messages: [{ role: "user", content: "hi" }] };
        const replacement = await options?.onPayload?.(payload, _model);
        captured =
          replacement && typeof replacement === "object"
            ? (replacement as Record<string, unknown>)
            : payload;
        return {} as Awaited<ReturnType<StreamFn>>;
      };
      const model = {
        api: "openai-completions",
        provider: "qwen-token-plan",
        id: modelId,
        reasoning: true,
      } as Model<"openai-completions">;
      const wrapped = wrapQwenProviderStream({
        provider: model.provider,
        modelId,
        model,
        streamFn: baseStreamFn,
        thinkingLevel,
      } as never);

      await wrapped?.(model, { messages: [] } as Context, {
        onPayload: async () => ({ messages: [] }),
      });

      expect(captured).toStrictEqual(expected);
    },
  );

  it.each([
    {
      modelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      options: { reasoningEffort: "max" },
      expected: { enable_thinking: true, reasoning_effort: "max" },
    },
    {
      modelId: "deepseek-v4-pro",
      thinkingLevel: "max",
      options: { reasoning: "medium" },
      expected: { enable_thinking: true, reasoning_effort: "high" },
    },
    {
      modelId: "glm-5.2",
      thinkingLevel: "low",
      options: { reasoningEffort: "max" },
      expected: { enable_thinking: true, reasoning_effort: "max" },
    },
    {
      modelId: "glm-5.2",
      thinkingLevel: "max",
      options: { reasoning: "medium" },
      expected: { enable_thinking: true, reasoning_effort: "medium" },
    },
    {
      modelId: "glm-5.1",
      thinkingLevel: "max",
      options: { reasoningEffort: "off" },
      expected: { enable_thinking: false },
    },
  ] as const)(
    "uses the runtime reasoning override for $modelId ($thinkingLevel)",
    ({ modelId, thinkingLevel, options, expected }) => {
      let captured: Record<string, unknown> = {};
      const baseStreamFn: StreamFn = (_model, _context, streamOptions) => {
        const payload: Record<string, unknown> = {};
        streamOptions?.onPayload?.(payload, _model);
        captured = payload;
        return {} as ReturnType<StreamFn>;
      };
      const model = {
        api: "openai-completions",
        provider: "qwen-token-plan",
        id: modelId,
        reasoning: true,
      } as Model<"openai-completions">;
      const wrapped = wrapQwenProviderStream({
        provider: model.provider,
        modelId,
        model,
        streamFn: baseStreamFn,
        thinkingLevel,
      } as never);

      void wrapped?.(model, { messages: [] } as Context, options as never);

      expect(captured).toStrictEqual(expected);
    },
  );

  it.each(
    ["qwen-token-plan", "bailian-token-plan"].flatMap((providerId) =>
      ["glm-5.2", "glm-5.1", "glm-5"].flatMap(
        (modelId) =>
          [
            [providerId, modelId, "high", "high"],
            [providerId, modelId, "max", modelId === "glm-5.2" ? "max" : "xhigh"],
            [providerId, modelId, "off", undefined],
          ] as const,
      ),
    ),
  )(
    "maps Token Plan GLM reasoning for %s/%s at %s",
    (providerId, modelId, thinkingLevel, expectedEffort) => {
      let captured: Record<string, unknown> = {};
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        const payload: Record<string, unknown> = {
          messages: [
            {
              role: "assistant",
              content: "earlier answer",
              reasoning_content: "earlier reasoning",
            },
          ],
          thinking: { type: "enabled" },
          reasoning_effort: "stale",
        };
        options?.onPayload?.(payload, _model);
        captured = payload;
        return {} as ReturnType<StreamFn>;
      };
      const model = {
        api: "openai-completions",
        provider: providerId,
        id: modelId,
        reasoning: true,
      } as Model<"openai-completions">;
      const wrapped = wrapQwenProviderStream({
        provider: providerId,
        modelId,
        model,
        streamFn: baseStreamFn,
        thinkingLevel,
      } as never);

      void wrapped?.(model, { messages: [] } as Context, {});

      expect(captured).toStrictEqual({
        messages: [
          { role: "assistant", content: "earlier answer", reasoning_content: "earlier reasoning" },
        ],
        enable_thinking: thinkingLevel !== "off",
        ...(expectedEffort ? { reasoning_effort: expectedEffort } : {}),
      });
    },
  );
});
