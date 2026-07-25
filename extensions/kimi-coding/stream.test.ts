// Kimi Coding tests cover stream plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { wrapKimiProviderStream } from "./stream.js";

type FakeStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

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

const KIMI_TOOL_TEXT =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.read:0 <|tool_call_argument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_calls_section_end|>';
const KIMI_MULTI_TOOL_TEXT =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.read:0 <|tool_call_argument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_call_begin|> functions.write:1 <|tool_call_argument_begin|> {"file_path":"./out.txt","content":"done"} <|tool_call_end|> <|tool_calls_section_end|>';
const KIMI_MODEL = {
  api: "anthropic-messages",
  provider: "kimi",
  id: "k2p5",
} as Model<"anthropic-messages">;
const KIMI_CONTEXT = { messages: [] } as Context;

function createReadToolCall() {
  return {
    type: "toolCall",
    id: "functions.read:0",
    name: "functions.read",
    arguments: { file_path: "./package.json" },
  };
}

function createAssistantTextMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  };
}

function createResultStreamFn(resultMessage: unknown): StreamFn {
  return () =>
    createFakeStream({
      events: [],
      resultMessage,
    }) as ReturnType<StreamFn>;
}

async function callKimiStream(wrapped: StreamFn): Promise<FakeStream> {
  return (await wrapped(KIMI_MODEL, KIMI_CONTEXT, {})) as FakeStream;
}

function createPayloadCapturingStream(initialPayload: Record<string, unknown> = {}) {
  let capturedPayload: Record<string, unknown> | undefined;
  const streamFn: StreamFn = (model, _context, options) => {
    const payload: Record<string, unknown> = { ...initialPayload };
    options?.onPayload?.(payload as never, model as never);
    capturedPayload = payload;
    return createFakeStream({
      events: [],
      resultMessage: { role: "assistant", content: [] },
    }) as never;
  };
  return { streamFn, getCapturedPayload: () => capturedPayload };
}

function wrapKimiStream(streamFn: StreamFn, thinking: "enabled" | "off" = "off"): StreamFn {
  return wrapKimiProviderStream({ streamFn, extraParams: { thinking } } as never);
}

describe("kimi tool-call markup wrapper", () => {
  it("converts tagged Kimi tool-call text into structured tool calls", async () => {
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const finalMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to read the file first." },
        { type: "text", text: KIMI_TOOL_TEXT },
      ],
      stopReason: "stop",
    };

    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [{ type: "message_end", partial, message }],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = wrapKimiStream(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = (await stream.result()) as {
      content: unknown[];
      stopReason: string;
    };

    expect(events).toEqual([
      {
        type: "message_end",
        partial: {
          role: "assistant",
          content: [
            {
              ...createReadToolCall(),
            },
          ],
          stopReason: "toolUse",
        },
        message: {
          role: "assistant",
          content: [
            {
              ...createReadToolCall(),
            },
          ],
          stopReason: "toolUse",
        },
      },
    ]);
    expect(result).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to read the file first." },
        {
          ...createReadToolCall(),
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("leaves normal assistant text unchanged", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "normal response" }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = wrapKimiStream(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toBe(finalMessage);
  });

  it("supports async stream functions", async () => {
    const finalMessage = createAssistantTextMessage(KIMI_TOOL_TEXT);
    const baseStreamFn: StreamFn = async (model, context, options) =>
      createResultStreamFn(finalMessage)(model, context, options);

    const wrapped = wrapKimiStream(baseStreamFn);
    const stream = await callKimiStream(wrapped);

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          ...createReadToolCall(),
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("parses multiple tagged tool calls in one section", async () => {
    const finalMessage = createAssistantTextMessage(KIMI_MULTI_TOOL_TEXT);
    const baseStreamFn = createResultStreamFn(finalMessage);

    const wrapped = wrapKimiStream(baseStreamFn);
    const stream = await callKimiStream(wrapped);

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          ...createReadToolCall(),
        },
        {
          type: "toolCall",
          id: "functions.write:1",
          name: "functions.write",
          arguments: { file_path: "./out.txt", content: "done" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("adapts provider stream context without changing wrapper behavior", async () => {
    const finalMessage = createAssistantTextMessage(KIMI_TOOL_TEXT);
    const baseStreamFn = createResultStreamFn(finalMessage);

    const wrapped = wrapKimiProviderStream({
      streamFn: baseStreamFn,
    } as never);
    const stream = await callKimiStream(wrapped);

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          ...createReadToolCall(),
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("forces Kimi thinking disabled and strips proxy reasoning fields", () => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream({
      reasoning: { effort: "high" },
      reasoning_effort: "high",
      reasoningEffort: "high",
    });

    const wrapped = wrapKimiStream(baseStreamFn);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "kimi",
        id: "kimi-code",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it.each(["k3", "k3[1m]"])("defaults %s to adaptive max thinking", (modelId) => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream({
      thinking: { type: "disabled", budget_tokens: 8192 },
      output_config: { effort: "low", format: { type: "json_schema" } },
      reasoning: { effort: "low" },
      reasoning_effort: "low",
      reasoningEffort: "low",
    });

    const wrapped = wrapKimiProviderStream({
      provider: "kimi",
      modelId,
      streamFn: baseStreamFn,
    } as never);

    void wrapped(
      {
        api: "anthropic-messages",
        provider: "kimi",
        id: modelId,
      } as Model<"anthropic-messages">,
      KIMI_CONTEXT,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max", format: { type: "json_schema" } },
    });
  });

  it.each([
    { modelId: "k3", extraParams: undefined, thinkingLevel: "off" },
    { modelId: "k3", extraParams: { thinking: "off" }, thinkingLevel: "max" },
    { modelId: "k3[1m]", extraParams: undefined, thinkingLevel: "off" },
    { modelId: "k3[1m]", extraParams: { thinking: "off" }, thinkingLevel: "max" },
  ] as const)("honors $modelId thinking off", ({ modelId, extraParams, thinkingLevel }) => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream({
      thinking: { type: "adaptive" },
      output_config: { effort: "max", format: { type: "json_schema" } },
      reasoning: { effort: "max" },
      reasoning_effort: "max",
      reasoningEffort: "max",
    });

    const wrapped = wrapKimiProviderStream({
      provider: "kimi",
      modelId,
      extraParams,
      thinkingLevel,
      streamFn: baseStreamFn,
    } as never);

    void wrapped(
      {
        api: "anthropic-messages",
        provider: "kimi",
        id: modelId,
      } as Model<"anthropic-messages">,
      KIMI_CONTEXT,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema" } },
    });
  });

  it.each(["k3", "k3[1m]"])(
    "lets explicit %s thinking enablement override session off",
    (modelId) => {
      const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream();
      const wrapped = wrapKimiProviderStream({
        provider: "kimi",
        modelId,
        extraParams: { thinking: "enabled" },
        thinkingLevel: "off",
        streamFn: baseStreamFn,
      } as never);

      void wrapped(
        {
          api: "anthropic-messages",
          provider: "kimi",
          id: modelId,
        } as Model<"anthropic-messages">,
        KIMI_CONTEXT,
        {},
      );

      expect(getCapturedPayload()).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "max" },
      });
    },
  );

  it("strips Anthropic cache_control markers before Kimi requests are sent", () => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream({
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: [
                {
                  type: "text",
                  text: "done",
                  cache_control: { type: "ephemeral" },
                },
              ],
              cache_control: { type: "ephemeral" },
            },
            {
              type: "tool_use",
              id: "tool_2",
              name: "persist",
              input: {
                cache_control: "tool argument",
                nested: { cache_control: "nested argument" },
              },
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: "bye" },
          ],
        },
      ],
    });

    const wrapped = wrapKimiStream(baseStreamFn, "enabled");
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "kimi",
        id: "kimi-code",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      max_tokens: 16000,
      system: [{ type: "text", text: "stable" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: [{ type: "text", text: "done" }],
            },
            {
              type: "tool_use",
              id: "tool_2",
              name: "persist",
              input: {
                cache_control: "tool argument",
                nested: { cache_control: "nested argument" },
              },
            },
            { type: "text", text: "bye" },
          ],
        },
      ],
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
  });

  it("lets explicit model params keep Kimi thinking disabled even when session thinking is on", () => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream();

    const wrapped = wrapKimiProviderStream({
      provider: "kimi",
      modelId: "kimi-code",
      extraParams: { thinking: "off" },
      thinkingLevel: "high",
      streamFn: baseStreamFn,
    } as never);

    void wrapped(
      {
        api: "anthropic-messages",
        provider: "kimi",
        id: "kimi-code",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it.each([
    {
      name: "uses session thinking when model params are absent",
      extraParams: undefined,
      thinkingLevel: "high",
      expected: {
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 8192 },
      },
    },
    {
      name: "lets explicit model params disable session thinking",
      extraParams: { thinking: "off" },
      thinkingLevel: "high",
      expected: { thinking: { type: "disabled" } },
    },
    {
      name: "lets explicit model params enable thinking when the session disables it",
      extraParams: { thinking: "enabled" },
      thinkingLevel: "off",
      expected: {
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 1024 },
      },
    },
  ])("$name", ({ extraParams, thinkingLevel, expected }) => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream();
    const wrapped = wrapKimiProviderStream({
      provider: "kimi",
      modelId: "kimi-code",
      extraParams,
      thinkingLevel,
      streamFn: baseStreamFn,
    } as never);

    void wrapped(KIMI_MODEL, KIMI_CONTEXT, {});

    expect(getCapturedPayload()).toEqual(expected);
  });

  it("backfills Kimi OpenAI-compatible tool-call reasoning_content when thinking is enabled", () => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream({
      messages: [
        { role: "user", content: "run pwd" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "exec", arguments: '{"command":"pwd"}' },
            },
          ],
        },
        {
          role: "assistant",
          content: "kept",
          reasoning_content: "native reasoning",
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
      ],
    });

    const wrapped = wrapKimiStream(baseStreamFn, "enabled");
    void wrapped(
      {
        api: "openai-completions",
        provider: "kimi",
        id: "kimi-for-coding",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      messages: [
        { role: "user", content: "run pwd" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "exec", arguments: '{"command":"pwd"}' },
            },
          ],
        },
        {
          role: "assistant",
          content: "kept",
          reasoning_content: "native reasoning",
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
      ],
      thinking: { type: "enabled" },
    });
  });

  it("strips Kimi OpenAI-compatible replay reasoning_content when thinking is disabled", () => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream({
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_content: "old reasoning",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "exec", arguments: '{"command":"pwd"}' },
            },
          ],
        },
      ],
    });

    const wrapped = wrapKimiStream(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "kimi",
        id: "kimi-for-coding",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "exec", arguments: '{"command":"pwd"}' },
            },
          ],
        },
      ],
      thinking: { type: "disabled" },
    });
  });

  it("enables Kimi Anthropic thinking with a high budget and enough output room", () => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream();

    const wrapped = wrapKimiProviderStream({
      provider: "kimi",
      modelId: "kimi-code",
      thinkingLevel: "high",
      streamFn: baseStreamFn,
    } as never);

    void wrapped(
      {
        api: "anthropic-messages",
        provider: "kimi",
        id: "kimi-code",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 8192 },
    });
  });

  it("adds the default Kimi Anthropic thinking budget for explicit enabled params", () => {
    const cases = ["enabled", true, { type: "enabled" }] as const;

    for (const configuredThinking of cases) {
      const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream();
      const wrapped = wrapKimiProviderStream({
        provider: "kimi",
        modelId: "kimi-code",
        extraParams: { thinking: configuredThinking },
        streamFn: baseStreamFn,
      } as never);

      void wrapped(
        {
          api: "anthropic-messages",
          provider: "kimi",
          id: "kimi-code",
        } as Model<"anthropic-messages">,
        { messages: [] } as Context,
        {},
      );

      expect(getCapturedPayload()).toEqual({
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 1024 },
      });
    }
  });

  it("uses the session Kimi Anthropic budget for explicit enabled params when available", () => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream();

    const wrapped = wrapKimiProviderStream({
      provider: "kimi",
      modelId: "kimi-code",
      extraParams: { thinking: "enabled" },
      thinkingLevel: "medium",
      streamFn: baseStreamFn,
    } as never);

    void wrapped(
      {
        api: "anthropic-messages",
        provider: "kimi",
        id: "kimi-code",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
  });

  it("preserves explicit Kimi Anthropic thinking budgets", () => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream();

    const wrapped = wrapKimiProviderStream({
      provider: "kimi",
      modelId: "kimi-code",
      extraParams: { thinking: { type: "enabled", budget_tokens: 4096 } },
      thinkingLevel: "high",
      streamFn: baseStreamFn,
    } as never);

    void wrapped(
      {
        api: "anthropic-messages",
        provider: "kimi",
        id: "kimi-code",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
  });

  it("preserves larger Kimi Anthropic max_tokens values", () => {
    const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream({
      max_tokens: 32768,
    });

    const wrapped = wrapKimiProviderStream({
      provider: "kimi",
      modelId: "kimi-code",
      thinkingLevel: "high",
      streamFn: baseStreamFn,
    } as never);

    void wrapped(
      {
        api: "anthropic-messages",
        provider: "kimi",
        id: "kimi-code",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(getCapturedPayload()).toEqual({
      max_tokens: 32768,
      thinking: { type: "enabled", budget_tokens: 8192 },
    });
  });

  it("bounds Kimi Anthropic thinking for session thinking levels", () => {
    const cases = [
      ["minimal", 1024],
      ["low", 1024],
      ["medium", 4096],
      ["high", 8192],
      ["adaptive", 8192],
      ["xhigh", 8192],
      ["max", 8192],
    ] as const;

    for (const [thinkingLevel, budgetTokens] of cases) {
      const { streamFn: baseStreamFn, getCapturedPayload } = createPayloadCapturingStream();
      const wrapped = wrapKimiProviderStream({
        provider: "kimi",
        modelId: "kimi-code",
        thinkingLevel,
        streamFn: baseStreamFn,
      } as never);

      void wrapped(
        {
          api: "anthropic-messages",
          provider: "kimi",
          id: "kimi-code",
        } as Model<"anthropic-messages">,
        { messages: [] } as Context,
        {},
      );

      expect(getCapturedPayload()).toEqual({
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: budgetTokens },
      });
    }
  });
});
