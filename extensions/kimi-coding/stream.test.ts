import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createKimiThinkingWrapper,
  createKimiToolCallMarkupWrapper,
  resolveKimiThinkingType,
  wrapKimiProviderStream,
} from "./stream.js";

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

describe("kimi tool-call markup wrapper", () => {
  it("defaults Kimi thinking to disabled unless explicitly enabled", () => {
    expect(resolveKimiThinkingType({ configuredThinking: undefined })).toBe("disabled");
    expect(resolveKimiThinkingType({ configuredThinking: undefined, thinkingLevel: "high" })).toBe(
      "enabled",
    );
    expect(resolveKimiThinkingType({ configuredThinking: "off", thinkingLevel: "high" })).toBe(
      "disabled",
    );
    expect(resolveKimiThinkingType({ configuredThinking: "enabled", thinkingLevel: "off" })).toBe(
      "enabled",
    );
  });

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

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
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

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
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

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
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

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
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

    const wrapped = createKimiThinkingWrapper(baseStreamFn, "disabled");
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
