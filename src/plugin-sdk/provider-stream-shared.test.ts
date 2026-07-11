/**
 * Tests provider stream shared helpers and stream hook capture.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createAnthropicThinkingPrefillPayloadWrapper,
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPayloadPatchStreamWrapper,
  createPlainTextToolCallCompatWrapper,
  defaultToolStreamExtraParams,
  isOpenAICompatibleThinkingEnabled,
  normalizeOpenAICompatibleReasoningPayload,
  setQwenChatTemplateThinking,
  stripTrailingAnthropicAssistantPrefillWhenThinking,
} from "./provider-stream-shared.js";

type StreamEvent = { type: string } & Record<string, unknown>;

const lmstudioBinaryModel = {
  api: "openai-completions",
  provider: "lmstudio",
  id: "google/gemma-4-26b-a4b-qat",
  baseUrl: "http://127.0.0.1:1234/v1",
  reasoning: true,
  compat: {
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
  },
} as unknown as Model<"openai-completions">;

const lmstudioBareModel = {
  api: "openai-completions",
  provider: "lmstudio",
  id: "qwen3-8b-instruct",
  baseUrl: "http://127.0.0.1:1234/v1",
  reasoning: true,
} as unknown as Model<"openai-completions">;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function createEventStream(events: unknown[]): ReturnType<StreamFn> {
  const output = createAssistantMessageEventStream();
  const stream = output as unknown as { push(event: unknown): void; end(): void };
  queueMicrotask(() => {
    for (const event of events) {
      stream.push(event);
    }
    stream.end();
  });
  return output as ReturnType<StreamFn>;
}

function createPayloadCapture(initialReasoningEffort?: string) {
  const payloads: Array<Record<string, unknown>> = [];
  const baseStreamFn: StreamFn = (model, _context, options) => {
    const payload: Record<string, unknown> = { model: model.id };
    if (initialReasoningEffort !== undefined) {
      payload.reasoning_effort = initialReasoningEffort;
    }
    options?.onPayload?.(payload, model);
    payloads.push(structuredClone(payload));
    return createAssistantMessageEventStream();
  };
  return { baseStreamFn, payloads };
}

function createControlledPlainTextToolCallCompatStream() {
  const source = createAssistantMessageEventStream();
  const baseStream: StreamFn = () => source as ReturnType<StreamFn>;
  const wrapped = createPlainTextToolCallCompatWrapper(baseStream);
  const stream = wrapped(
    { provider: "test", api: "openai-completions", id: "test-model" } as never,
    {
      messages: [],
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
    } as never,
    {},
  );
  return { source, stream };
}

function createByteOverCapZeroArgumentXmlCall(name: string): string {
  return `<function=${name}>${"\u00a0".repeat(128_001)}</function>`;
}

async function collectPlainTextToolCallCompatEvents(events: unknown[]): Promise<StreamEvent[]> {
  const baseStreamFn: StreamFn = () => createEventStream(events);
  const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
  const stream = await resolveStream(
    wrapped({} as never, { tools: [{ name: "read" }] } as never, {}),
  );
  const output: StreamEvent[] = [];
  for await (const event of stream as AsyncIterable<unknown>) {
    output.push(event as StreamEvent);
  }
  return output;
}

async function resolveStream(stream: ReturnType<StreamFn>) {
  return stream instanceof Promise ? await stream : stream;
}

async function nextEvent(iterator: AsyncIterator<unknown>, label: string): Promise<StreamEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<"timed out">((resolve) => {
      setTimeout(() => resolve("timed out"), 50);
    }),
  ]);
  if (result === "timed out") {
    throw new Error(`timed out waiting for ${label}`);
  }
  expect(result.done).toBe(false);
  return result.value as StreamEvent;
}

describe("defaultToolStreamExtraParams", () => {
  it("defaults tool_stream on when absent", () => {
    expect(defaultToolStreamExtraParams()).toEqual({ tool_stream: true });
    expect(defaultToolStreamExtraParams({ fastMode: true })).toEqual({
      fastMode: true,
      tool_stream: true,
    });
  });

  it("preserves explicit tool_stream values", () => {
    const enabled = { tool_stream: true, fastMode: true };
    const disabled = { tool_stream: false, fastMode: true };

    expect(defaultToolStreamExtraParams(enabled)).toBe(enabled);
    expect(defaultToolStreamExtraParams(disabled)).toBe(disabled);
  });
});

describe("isOpenAICompatibleThinkingEnabled", () => {
  it("uses explicit request reasoning before session thinking level", () => {
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "high",
        options: { reasoning: "none" } as never,
      }),
    ).toBe(false);
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "off",
        options: { reasoningEffort: "medium" } as never,
      }),
    ).toBe(true);
  });

  it("treats off and none as disabled", () => {
    expect(isOpenAICompatibleThinkingEnabled({ thinkingLevel: "off", options: {} })).toBe(false);
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "high",
        options: { reasoning: "none" } as never,
      }),
    ).toBe(false);
  });

  it("defaults to enabled for missing or non-string values", () => {
    expect(isOpenAICompatibleThinkingEnabled({ thinkingLevel: undefined, options: {} })).toBe(true);
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "off",
        options: { reasoning: { effort: "off" } } as never,
      }),
    ).toBe(true);
  });
});

describe("setQwenChatTemplateThinking", () => {
  it("preserves existing chat-template kwargs and enables thinking", () => {
    const payload = {
      chat_template_kwargs: {
        custom_flag: "keep",
        preserve_thinking: false,
      },
    };

    setQwenChatTemplateThinking(payload, true);

    expect(payload.chat_template_kwargs).toEqual({
      custom_flag: "keep",
      preserve_thinking: false,
      enable_thinking: true,
    });
  });

  it("creates the required chat-template kwargs when absent", () => {
    const payload: Record<string, unknown> = {};

    setQwenChatTemplateThinking(payload, false);

    expect(payload).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    });
  });
});

describe("normalizeOpenAICompatibleReasoningPayload", () => {
  it("removes the legacy field and adds the selected reasoning effort", () => {
    const payload: Record<string, unknown> = {
      reasoning_effort: "high",
    };

    normalizeOpenAICompatibleReasoningPayload(payload, "adaptive");

    expect(payload).toEqual({ reasoning: { effort: "medium" } });
  });

  it("preserves explicit reasoning controls", () => {
    const withMaxTokens: Record<string, unknown> = {
      reasoning_effort: "high",
      reasoning: { max_tokens: 256 },
    };
    const withEffort: Record<string, unknown> = {
      reasoning_effort: "high",
      reasoning: { effort: "low", summary: "auto" },
    };

    normalizeOpenAICompatibleReasoningPayload(withMaxTokens, "high");
    normalizeOpenAICompatibleReasoningPayload(withEffort, "high");

    expect(withMaxTokens).toEqual({ reasoning: { max_tokens: 256 } });
    expect(withEffort).toEqual({ reasoning: { effort: "low", summary: "auto" } });
  });

  it("removes only the legacy field when thinking is disabled", () => {
    const payload: Record<string, unknown> = {
      reasoning_effort: "high",
    };

    normalizeOpenAICompatibleReasoningPayload(payload, "off");

    expect(payload).toEqual({});
  });

  it("defensively normalizes logical Ultra for generic compatible payloads", () => {
    const payload: Record<string, unknown> = {};

    normalizeOpenAICompatibleReasoningPayload(payload, "ultra");

    expect(payload).toEqual({ reasoning: { effort: "xhigh" } });
  });
});

describe("createDeepSeekV4OpenAICompatibleThinkingWrapper", () => {
  it("backfills reasoning_content on every replayed assistant message when thinking is enabled", () => {
    const payload = {
      messages: [
        { role: "user", content: "read file" },
        { role: "assistant", tool_calls: [{ id: "call_1", name: "read" }] },
        { role: "tool", content: "ok" },
        { role: "assistant", content: "done" },
        { role: "assistant", content: "kept", reasoning_content: "native reasoning" },
      ],
    };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload as never, _model as never);
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn,
      thinkingLevel: "high",
      shouldPatchModel: () => true,
    });
    void wrapped?.({} as never, {} as never, {});

    expect(payload.messages[0]).not.toHaveProperty("reasoning_content");
    expect(payload.messages[1]).toHaveProperty("reasoning_content", "");
    expect(payload.messages[2]).not.toHaveProperty("reasoning_content");
    expect(payload.messages[3]).toHaveProperty("reasoning_content", "");
    expect(payload.messages[4]).toHaveProperty("reasoning_content", "native reasoning");
  });
});

describe("createPayloadPatchStreamWrapper", () => {
  it("passes stream call options to payload patches", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, options }) => {
      payload.reasoning = (options as { reasoning?: unknown } | undefined)?.reasoning;
    });
    void wrapped(
      { id: "model" } as never,
      { messages: [] } as never,
      {
        reasoning: "medium",
      } as never,
    );

    expect(captured).toEqual({ reasoning: "medium" });
  });

  it("calls the underlying stream directly when shouldPatch rejects the model", () => {
    let onPayloadWasInstalled = false;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      onPayloadWasInstalled = typeof options?.onPayload === "function";
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createPayloadPatchStreamWrapper(
      baseStreamFn,
      ({ payload }) => {
        payload.unexpected = true;
      },
      { shouldPatch: () => false },
    );
    void wrapped({ id: "model" } as never, { messages: [] } as never, {});

    expect(onPayloadWasInstalled).toBe(false);
  });
});

describe("createOpenAICompatibleCompletionsThinkingOffWrapper", () => {
  it("maps reasoning_effort to the model's disabled value when thinking is off", () => {
    const { baseStreamFn, payloads } = createPayloadCapture("high");
    const wrapped = createOpenAICompatibleCompletionsThinkingOffWrapper(baseStreamFn, "off");
    void wrapped(lmstudioBinaryModel, { messages: [] }, {});

    expect(payloads[0]?.reasoning_effort).toBe("none");
  });

  it("drops reasoning_effort when the model has no disabled effort", () => {
    const { baseStreamFn, payloads } = createPayloadCapture("high");
    const wrapped = createOpenAICompatibleCompletionsThinkingOffWrapper(baseStreamFn, "off");
    void wrapped(lmstudioBareModel, { messages: [] }, {});

    expect(payloads[0]).not.toHaveProperty("reasoning_effort");
  });

  it("does not add reasoning_effort when none was sent", () => {
    const { baseStreamFn, payloads } = createPayloadCapture();
    const wrapped = createOpenAICompatibleCompletionsThinkingOffWrapper(baseStreamFn, "off");
    void wrapped(lmstudioBinaryModel, { messages: [] }, {});

    expect(payloads[0]).not.toHaveProperty("reasoning_effort");
  });

  it("leaves enabled thinking levels unchanged", () => {
    const { baseStreamFn, payloads } = createPayloadCapture("high");
    const wrapped = createOpenAICompatibleCompletionsThinkingOffWrapper(baseStreamFn, "high");
    void wrapped(lmstudioBinaryModel, { messages: [] }, {});

    expect(payloads[0]?.reasoning_effort).toBe("high");
  });
});

describe("createPlainTextToolCallCompatWrapper", () => {
  it("promotes standalone text tool calls into tool-call stream events", async () => {
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_start", content: "" },
        { type: "text_delta", delta: '[tool:read] {"path":"/tmp/file.txt"}' },
        { type: "text_end" },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: '[tool:read] {"path":"/tmp/file.txt"}',
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.at(-1) as { message?: { content?: unknown; stopReason?: unknown } };
    expect(done.message?.stopReason).toBe("toolUse");
    expect(done.message?.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "read",
        arguments: { path: "/tmp/file.txt" },
      }),
    ]);
  });

  it("does not promote complete-looking text tool calls after a length stop", async () => {
    const rawToolText = '[tool:read] {"path":"/tmp/file.txt"}';
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "length",
          message: {
            role: "assistant",
            content: rawToolText,
            stopReason: "length",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual(["done"]);
    const done = events.at(-1) as {
      reason?: unknown;
      message?: { content?: unknown; stopReason?: unknown };
    };
    expect(done.reason).toBe("length");
    expect(done.message).toMatchObject({ content: rawToolText, stopReason: "length" });
  });

  it("passes through bracketed text when no configured tool names match", async () => {
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", delta: "[note] keep streaming" },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: "[note] keep streaming",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "done",
    ]);
  });

  it("converts standalone plain-text tool calls for result consumers", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const resultPromise = (await resolveStream(stream)).result();
    const rawToolText = '[tool:read] {"path":"src/index.ts"}';

    source.push({ type: "start", partial: { content: [] } } as never);
    source.push({
      type: "text_delta",
      contentIndex: 0,
      delta: rawToolText,
    } as never);
    source.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: rawToolText }],
        stopReason: "stop",
      },
    } as never);
    source.end();

    const message = requireRecord(await resultPromise, "result message");
    expect(message.stopReason).toBe("toolUse");
    expect(requireRecord((message.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "src/index.ts" },
    });
  });

  it("promotes serialized tool calls split across adjacent text blocks", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const resultPromise = (await resolveStream(stream)).result();
    const rawToolText = [
      "[tool:read]",
      "<parameter=path>",
      "src/index.ts",
      "</parameter>",
      "</function>",
    ].join("\n");

    source.push({ type: "start", partial: { content: [] } } as never);
    source.push({
      type: "text_delta",
      contentIndex: 0,
      delta: rawToolText,
    } as never);
    source.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "[tool:read]\n<parameter=path>" },
          { type: "text", text: "src/index.ts\n</parameter>\n</function>" },
        ],
        stopReason: "stop",
      },
    } as never);
    source.end();

    const message = requireRecord(await resultPromise, "result message");
    expect(message.stopReason).toBe("toolUse");
    expect(requireRecord((message.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "src/index.ts" },
    });
  });

  it("preserves exact text block adjacency inside promoted arguments", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const resultPromise = (await resolveStream(stream)).result();

    source.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "[tool:read]\n<parameter=path>\nsrc/ind" },
          { type: "text", text: "ex.ts\n</parameter>\n</function>" },
        ],
        stopReason: "stop",
      },
    } as never);
    source.end();

    const message = requireRecord(await resultPromise, "result message");
    expect(requireRecord((message.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "src/index.ts" },
    });
  });

  it("repairs bracketed tool-call block boundaries when providers split header text", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const resultPromise = (await resolveStream(stream)).result();

    source.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "[read]" },
          { type: "text", text: '{"path":"src/index.ts"}\n[END_TOOL_REQUEST]' },
        ],
        stopReason: "stop",
      },
    } as never);
    source.end();

    const message = requireRecord(await resultPromise, "result message");
    expect(requireRecord((message.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "src/index.ts" },
    });
  });

  it("keeps possible tool-call text buffered across interleaved non-text events", async () => {
    const rawToolText = [
      "[tool:read]",
      "<parameter=path>",
      "src/index.ts",
      "</parameter>",
      "</function>",
    ].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 1, delta: rawToolText },
        {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Need file contents.",
          partial: {
            content: [
              { type: "thinking", thinking: "Need file contents." },
              { type: "text", text: rawToolText },
            ],
          },
        },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Need file contents." },
              { type: "text", text: rawToolText },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const stream = await resolveStream(
      wrapped({} as never, { tools: [{ name: "read" }] } as never, {}),
    );
    const events: unknown[] = [];

    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "start",
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[1], "thinking event");
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "thinking", thinking: "Need file contents." },
      expect.objectContaining({ type: "toolCall", name: "read" }),
    ]);
    expect(JSON.stringify(events)).not.toContain(rawToolText);
  });

  it("preserves interleaved event content indexes when buffered text is scrubbed first", async () => {
    const rawToolText = [
      "[tool:read]",
      "<parameter=path>",
      "src/index.ts",
      "</parameter>",
      "</function>",
    ].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: rawToolText },
        {
          type: "thinking_delta",
          contentIndex: 1,
          delta: "Need file contents.",
          partial: {
            content: [
              { type: "text", text: rawToolText },
              { type: "thinking", thinking: "Need file contents." },
            ],
          },
        },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: rawToolText },
              { type: "thinking", thinking: "Need file contents." },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const stream = await resolveStream(
      wrapped({} as never, { tools: [{ name: "read" }] } as never, {}),
    );
    const events: unknown[] = [];

    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "thinking_delta",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[4], "thinking event");
    expect(thinkingEvent.contentIndex).toBe(1);
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      expect.objectContaining({ type: "toolCall", name: "read" }),
      { type: "thinking", thinking: "Need file contents." },
    ]);
    expect(JSON.stringify(events)).not.toContain(rawToolText);
  });

  it("flushes false-positive buffered prefixes around interleaved events in source order", async () => {
    const firstText = "[tool:re";
    const secondText = " not a call";
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: firstText },
        {
          type: "thinking_delta",
          contentIndex: 1,
          delta: "Need file contents.",
          partial: {
            content: [
              { type: "text", text: firstText },
              { type: "thinking", thinking: "Need file contents." },
            ],
          },
        },
        { type: "text_delta", contentIndex: 0, delta: secondText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: `${firstText}${secondText}` },
              { type: "thinking", thinking: "Need file contents." },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const stream = await resolveStream(
      wrapped({} as never, { tools: [{ name: "read" }] } as never, {}),
    );
    const events: unknown[] = [];

    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "thinking_delta",
      "text_delta",
      "done",
    ]);
    expect(requireRecord(events[0], "first text").delta).toBe(firstText);
    const thinkingEvent = requireRecord(events[1], "thinking event");
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "text", text: firstText },
      { type: "thinking", thinking: "Need file contents." },
    ]);
    expect(requireRecord(events[2], "second text").delta).toBe(secondText);
  });

  it("keeps CR-separated bracketed tool calls buffered for conversion", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const iterator = (await resolveStream(stream))[Symbol.asyncIterator]();

    try {
      source.push({ type: "start", partial: { content: [] } } as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta: '[read]\r{"path":"src/index.ts"}\r[END_TOOL_REQUEST]',
      } as never);
      source.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '[read]\r{"path":"src/index.ts"}\r[END_TOOL_REQUEST]' }],
          stopReason: "stop",
        },
      } as never);

      const event = await nextEvent(iterator, "converted CR tool call");
      expect(event.type).toBe("toolcall_start");
    } finally {
      source.end();
      await iterator.return?.();
    }
  });

  it("keeps bracketed XML parameter tool calls buffered for conversion", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const iterator = (await resolveStream(stream))[Symbol.asyncIterator]();
    const rawToolText = [
      "[tool:read]",
      "<parameter=path>",
      "src/index.ts",
      "</parameter>",
      "</function>",
    ].join("\n");

    try {
      source.push({ type: "start", partial: { content: [] } } as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta: rawToolText,
      } as never);
      source.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawToolText }],
          stopReason: "stop",
        },
      } as never);

      const event = await nextEvent(iterator, "converted bracketed XML tool call");
      expect(event.type).toBe("toolcall_start");
    } finally {
      source.end();
      await iterator.return?.();
    }
  });

  it.each([
    {
      byteOnly: false,
      label: "bracketed XML parameter text over the character cap",
      marker: "[tool:read]",
      rawToolText: [
        "[tool:read]",
        "<parameter=path>",
        "x".repeat(256_001),
        "</parameter>",
        "</function>",
      ].join("\n"),
    },
    {
      byteOnly: true,
      label: "zero-argument XML text over the byte cap",
      marker: "<function=read>",
      rawToolText: createByteOverCapZeroArgumentXmlCall("read"),
    },
    {
      byteOnly: true,
      label: "incomplete XML text over the byte cap",
      marker: "<function=read>",
      rawToolText: `<function=read>${"\u00a0".repeat(128_001)}`,
    },
    {
      byteOnly: true,
      label: "a later bracketed XML parameter over the byte cap",
      marker: "[tool:read]",
      rawToolText: [
        "[tool:read]",
        "<parameter=path>src/index.ts</parameter>",
        `<parameter=query>${"\u00a0".repeat(128_001)}</parameter>`,
        "</function>",
      ].join("\n"),
    },
  ])("suppresses $label instead of streaming it", async ({ byteOnly, marker, rawToolText }) => {
    if (byteOnly) {
      expect(rawToolText.length).toBeLessThan(256_000);
    }
    if (marker === "<function=read>") {
      const payloadEnd = rawToolText.endsWith("</function>") ? -"</function>".length : undefined;
      const payload = rawToolText.slice(marker.length, payloadEnd);
      expect(new TextEncoder().encode(payload).byteLength).toBe(256_002);
    }
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "start", partial: { content: [] } },
        { type: "text_start", contentIndex: 0, content: "" },
        { type: "text_delta", contentIndex: 0, delta: rawToolText },
        {
          type: "thinking_delta",
          contentIndex: 1,
          delta: "checking",
          partial: {
            content: [
              { type: "text", text: rawToolText },
              { type: "thinking", thinking: "checking" },
            ],
          },
        },
        { type: "text_end", contentIndex: 0, content: rawToolText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawToolText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "start",
      "thinking_delta",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[1], "thinking event");
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "text", text: "" },
      { type: "thinking", thinking: "checking" },
    ]);
    const doneEvent = requireRecord(events[2], "done event");
    expect(doneEvent.reason).toBe("stop");
    expect(doneEvent.message).toMatchObject({
      role: "assistant",
      content: [],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("preserves visible text after a byte-over-cap XML prefix below the character cap", async () => {
    const marker = "<function=read>";
    const visibleText = "Visible answer";
    const rawText = `${createByteOverCapZeroArgumentXmlCall("read")}\n${visibleText}`;
    expect(rawText.length).toBeLessThan(256_000);
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: rawText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(requireRecord(events[0], "text event")).toMatchObject({
      delta: visibleText,
      partial: { content: [{ type: "text", text: visibleText }] },
    });
    expect(requireRecord(events[1], "done event").message).toMatchObject({
      content: [{ type: "text", text: visibleText }],
    });
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("keeps a byte-over-cap visible suffix at its streamed content index in done messages", async () => {
    const marker = "<function=read>";
    const visibleText = "Visible answer";
    const firstChunk = `${marker}${"\u00a0".repeat(100_000)}`;
    const secondChunk = `${"\u00a0".repeat(28_001)}</function>\n${visibleText}`;
    const content = [
      { type: "text", text: firstChunk },
      { type: "thinking", thinking: "checking" },
      { type: "text", text: secondChunk },
    ];
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: firstChunk },
        {
          type: "text_delta",
          contentIndex: 2,
          delta: secondChunk,
          partial: { role: "assistant", content },
        },
        {
          type: "done",
          reason: "stop",
          message: { role: "assistant", content, stopReason: "stop" },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "text_delta",
      "done",
    ]);
    const expectedContent = [
      { type: "text", text: "" },
      { type: "thinking", thinking: "checking" },
      { type: "text", text: visibleText },
    ];
    expect(requireRecord(events[0], "text event")).toMatchObject({
      delta: visibleText,
      partial: { content: expectedContent },
    });
    expect(requireRecord(events[1], "done event").message).toMatchObject({
      content: expectedContent,
    });
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("scrubs earlier partial blocks when a later block completes a byte-over-cap XML prefix", async () => {
    const marker = "<function=read>";
    const visibleText = "Visible answer";
    const firstChunk = `${marker}${"\u00a0".repeat(100_000)}`;
    const secondChunk = `${"\u00a0".repeat(28_001)}</function>\n${visibleText}`;
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: firstChunk },
        {
          type: "text_delta",
          contentIndex: 1,
          delta: secondChunk,
          partial: {
            role: "assistant",
            content: [
              { type: "text", text: firstChunk },
              { type: "text", text: secondChunk },
            ],
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual(["text_delta"]);
    expect(requireRecord(events[0], "text event")).toMatchObject({
      delta: visibleText,
      partial: {
        content: [
          { type: "text", text: "" },
          { type: "text", text: visibleText },
        ],
      },
    });
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("keeps a byte-over-cap visible suffix at its streamed content index in done messages", async () => {
    const marker = "<function=read>";
    const visibleText = "Visible answer";
    const firstChunk = `${marker}${"\u00a0".repeat(100_000)}`;
    const secondChunk = `${"\u00a0".repeat(28_001)}</function>\n${visibleText}`;
    const content = [
      { type: "text", text: firstChunk },
      { type: "thinking", thinking: "checking" },
      { type: "text", text: secondChunk },
    ];
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: firstChunk },
        {
          type: "text_delta",
          contentIndex: 2,
          delta: secondChunk,
          partial: { role: "assistant", content },
        },
        {
          type: "done",
          reason: "stop",
          message: { role: "assistant", content, stopReason: "stop" },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "text_delta",
      "done",
    ]);
    const expectedContent = [
      { type: "text", text: "" },
      { type: "thinking", thinking: "checking" },
      { type: "text", text: visibleText },
    ];
    expect(requireRecord(events[0], "text event")).toMatchObject({
      delta: visibleText,
      partial: { content: expectedContent },
    });
    expect(requireRecord(events[1], "done event").message).toMatchObject({
      content: expectedContent,
    });
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("scrubs split byte-over-cap XML prefixes from terminal errors without visible text", async () => {
    const marker = "<function=read>";
    const firstChunk = `${marker}${"\u00a0".repeat(100_000)}`;
    const secondChunk = `${"\u00a0".repeat(28_001)}</function>`;
    const content = [
      { type: "text", text: firstChunk },
      { type: "text", text: secondChunk },
    ];
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: firstChunk },
        { type: "text_delta", contentIndex: 1, delta: secondChunk },
        {
          type: "error",
          partial: { role: "assistant", content },
          error: { content, errorMessage: "stream failed" },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual(["error"]);
    const errorEvent = requireRecord(events[0], "error event");
    expect(requireRecord(errorEvent.partial, "error partial").content).toEqual([
      { type: "text", text: "" },
      { type: "text", text: "" },
    ]);
    expect(requireRecord(errorEvent.error, "error body").content).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it.each([
    {
      label: "character-over-cap bracketed XML",
      marker: "[tool:read]",
      rawToolText: ["[tool:read]", "<parameter=path>", "x".repeat(256_001)].join("\n"),
    },
    {
      label: "byte-over-cap zero-argument XML",
      marker: "<function=read>",
      rawToolText: createByteOverCapZeroArgumentXmlCall("read"),
    },
  ])("scrubs $label from terminal error partials", async ({ marker, rawToolText }) => {
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: rawToolText },
        {
          type: "error",
          partial: {
            content: [
              { type: "text", text: rawToolText },
              { type: "thinking", thinking: "checking" },
            ],
          },
          error: {
            content: [{ type: "text", text: rawToolText }],
            errorMessage: "stream failed",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual(["error"]);
    const errorEvent = requireRecord(events[0], "error event");
    expect(requireRecord(errorEvent.partial, "error partial").content).toEqual([
      { type: "text", text: "" },
      { type: "thinking", thinking: "checking" },
    ]);
    expect(requireRecord(errorEvent.error, "error body").content).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("does not flush a byte-over-cap XML call when the stream ends without a terminal event", async () => {
    const rawToolText = createByteOverCapZeroArgumentXmlCall("read");
    const baseStreamFn: StreamFn = () =>
      createEventStream([{ type: "text_delta", contentIndex: 0, delta: rawToolText }]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });

  it.each(["EOF", "error"] as const)(
    "scrubs authoritative text_end byte-over-cap XML at %s",
    async (terminal) => {
      const rawToolText = createByteOverCapZeroArgumentXmlCall("read");
      const events = await collectPlainTextToolCallCompatEvents([
        { type: "text_delta", contentIndex: 0, delta: "<function=read>" },
        { type: "text_end", contentIndex: 0, content: rawToolText },
        ...(terminal === "error"
          ? [
              {
                type: "error",
                partial: {
                  role: "assistant",
                  content: [{ type: "text", text: rawToolText }],
                },
                error: {
                  role: "assistant",
                  content: [{ type: "text", text: rawToolText }],
                  errorMessage: "stream failed",
                },
              },
            ]
          : []),
      ]);

      if (terminal === "EOF") {
        expect(events).toEqual([]);
        return;
      }
      expect(events.map((event) => event.type)).toEqual(["error"]);
      const errorEvent = requireRecord(events[0], "error event");
      expect(requireRecord(errorEvent.partial, "error partial").content).toEqual([
        { type: "text", text: "" },
      ]);
      expect(requireRecord(errorEvent.error, "error body").content).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("<function=read>");
    },
  );

  it("scrubs byte-over-cap XML from error-only terminal snapshots", async () => {
    const rawToolText = createByteOverCapZeroArgumentXmlCall("read");
    const events = await collectPlainTextToolCallCompatEvents([
      {
        type: "error",
        partial: { role: "assistant", content: rawToolText },
        error: {
          role: "assistant",
          content: [{ type: "text", text: rawToolText }],
          errorMessage: "stream failed",
        },
      },
    ]);

    expect(events.map((event) => event.type)).toEqual(["error"]);
    const errorEvent = requireRecord(events[0], "error event");
    expect(requireRecord(errorEvent.partial, "error partial").content).toBe("");
    expect(requireRecord(errorEvent.error, "error body")).toMatchObject({
      content: [],
      errorMessage: "stream failed",
    });
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("scrubs terminal XML split inside its function markers", async () => {
    const body = "\u00a0".repeat(128_001);
    const parts = ["<func", `tion=read>${body}</func`, "tion>"];
    const events = await collectPlainTextToolCallCompatEvents([
      {
        type: "done",
        reason: "length",
        message: {
          role: "assistant",
          content: parts.map((text) => ({ type: "text", text })),
          stopReason: "length",
        },
      },
    ]);

    expect(requireRecord(events[0], "done event")).toMatchObject({
      type: "done",
      reason: "length",
      message: { role: "assistant", content: [], stopReason: "length" },
    });
    expect(JSON.stringify(events)).not.toContain("<func");
    expect(JSON.stringify(events)).not.toContain("tion>");
  });

  it("retains non-text blocks in order around an over-cap XML call suffix", async () => {
    const visibleText = "Visible suffix";
    const thinkingBefore = { type: "thinking", thinking: "Before image." };
    const image = { type: "image", data: "aW1n", mimeType: "image/png" };
    const thinkingAfter = { type: "thinking", thinking: "After suffix." };
    const events = await collectPlainTextToolCallCompatEvents([
      {
        type: "done",
        reason: "length",
        message: {
          role: "assistant",
          content: [
            thinkingBefore,
            { type: "text", text: `<function=read>${"\u00a0".repeat(128_001)}` },
            image,
            { type: "text", text: `</function>\n${visibleText}` },
            thinkingAfter,
          ],
          stopReason: "length",
        },
      },
    ]);

    const doneMessage = requireRecord(requireRecord(events[0], "done event").message, "message");
    expect(doneMessage.content).toEqual([
      thinkingBefore,
      image,
      { type: "text", text: visibleText },
      thinkingAfter,
    ]);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("strips consecutive byte-over-cap serialized XML calls", async () => {
    const visibleText = "Visible after both calls";
    const rawText = [
      createByteOverCapZeroArgumentXmlCall("read"),
      createByteOverCapZeroArgumentXmlCall("read"),
      visibleText,
    ].join("\n");
    const events = await collectPlainTextToolCallCompatEvents([
      {
        type: "done",
        reason: "length",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawText }],
          stopReason: "length",
        },
      },
    ]);

    expect(
      requireRecord(requireRecord(events[0], "done event").message, "message").content,
    ).toEqual([{ type: "text", text: visibleText }]);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("preserves the exact suffix after a compacted XML prefix and split terminator", async () => {
    const visibleText = "Visible after compacted XML";
    const chunks = ["<func", `tion=read>${" ".repeat(330_001)}</func`, `tion>\n${visibleText}`];
    const rawText = chunks.join("");
    const events = await collectPlainTextToolCallCompatEvents([
      ...chunks.map((delta) => ({ type: "text_delta", contentIndex: 0, delta })),
      {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawText }],
          stopReason: "stop",
        },
      },
    ]);

    expect(rawText.length).toBeGreaterThan(320_000);
    expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
    expect(events[0]).toMatchObject({ delta: visibleText });
    expect(
      requireRecord(requireRecord(events[1], "done event").message, "message").content,
    ).toEqual([{ type: "text", text: visibleText }]);
    expect(JSON.stringify(events)).not.toContain("<func");
  });

  it("scrubs compacted error partials when an emoji crosses the safe prefix boundary", async () => {
    const toolPrefix = "[tool:read]\n<parameter=path>\n";
    const emojiIndex = 255_999;
    const firstChunk = `${toolPrefix}${"x".repeat(emojiIndex - toolPrefix.length)}😀${"y".repeat(70_000)}`;
    const secondChunk = "z".repeat(70_000);
    const rawToolText = firstChunk + secondChunk;
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: firstChunk },
        { type: "text_delta", contentIndex: 0, delta: secondChunk },
        {
          type: "error",
          partial: { content: [{ type: "text", text: rawToolText }] },
          error: {
            content: [{ type: "text", text: rawToolText }],
            errorMessage: "stream failed",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual(["error"]);
    const errorEvent = requireRecord(events[0], "error event");
    expect(requireRecord(errorEvent.partial, "error partial").content).toEqual([
      { type: "text", text: "" },
    ]);
    expect(requireRecord(errorEvent.error, "error body").content).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("scrubs over-cap bracketed XML parameter text from done-message-only streams", async () => {
    const rawToolText = [
      "[tool:read]",
      "<parameter=path>",
      "x".repeat(256_001),
      "</parameter>",
      "</function>",
    ].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawToolText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual(["done"]);
    const doneEvent = requireRecord(events[0], "done event");
    expect(doneEvent.reason).toBe("stop");
    expect(doneEvent.message).toMatchObject({
      role: "assistant",
      content: [],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("scrubs over-cap bracketed XML parameter text from length terminal messages", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const output = await resolveStream(stream);
    const resultPromise = output.result();
    const eventsPromise = (async () => {
      const events: unknown[] = [];
      for await (const event of output as AsyncIterable<unknown>) {
        events.push(event);
      }
      return events;
    })();
    const rawToolText = [
      "[tool:read]",
      "<parameter=path>",
      "x".repeat(256_001),
      "</parameter>",
      "</function>",
    ].join("\n");

    source.push({
      type: "done",
      reason: "length",
      message: {
        role: "assistant",
        content: [{ type: "text", text: rawToolText }],
        stopReason: "length",
      },
    } as never);
    source.end();

    const events = await eventsPromise;
    const result = requireRecord(await resultPromise, "result message");

    expect(requireRecord(events[0], "done event")).toMatchObject({
      reason: "length",
      message: { role: "assistant", content: [], stopReason: "length" },
    });
    expect(result).toMatchObject({ role: "assistant", content: [], stopReason: "length" });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
    expect(JSON.stringify(result)).not.toContain("[tool:read]");
  });

  it("scrubs split over-cap bracketed XML parameter text from done messages", async () => {
    const rawToolTextParts = [
      "[tool:read]\n<parameter=path>",
      ["x".repeat(256_001), "</parameter>", "</function>"].join("\n"),
    ];
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: rawToolTextParts.map((text) => ({ type: "text", text })),
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    const doneEvent = requireRecord(events[0], "done event");
    expect(doneEvent.reason).toBe("stop");
    expect(doneEvent.message).toMatchObject({
      role: "assistant",
      content: [],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
    expect(JSON.stringify(events)).not.toContain("</parameter>");
  });

  it("scrubs split over-cap bracketed XML tails before later visible text", async () => {
    const rawToolTextParts = [
      "[tool:read]\n<parameter=path>",
      "x".repeat(256_001),
      ["</parameter>", "</function>"].join("\n"),
    ];
    const visibleText = "Visible text after the tool-looking blocks.";
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              ...rawToolTextParts.map((text) => ({ type: "text", text })),
              { type: "text", text: visibleText },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: visibleText }],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
    expect(JSON.stringify(events)).not.toContain("</parameter>");
  });

  it("scrubs split over-cap bracketed XML around non-text blocks", async () => {
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "[tool:read]\n<parameter=path>" },
              { type: "thinking", thinking: "Checking path." },
              {
                type: "text",
                text: ["x".repeat(256_001), "</parameter>", "</function>"].join("\n"),
              },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [{ type: "thinking", thinking: "Checking path." }],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
    expect(JSON.stringify(events)).not.toContain("</parameter>");
  });

  it("scrubs closing tails after a single over-cap bracketed XML block", async () => {
    const rawToolTextParts = [
      ["[tool:read]", "<parameter=path>", "x".repeat(256_001)].join("\n"),
      ["</parameter>", "</function>"].join("\n"),
    ];
    const visibleText = "Visible text after the tool-looking blocks.";
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              ...rawToolTextParts.map((text) => ({ type: "text", text })),
              { type: "text", text: visibleText },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: visibleText }],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
    expect(JSON.stringify(events)).not.toContain("</parameter>");
  });

  it("scrubs closing tails after a single over-cap bracketed XML block without visible text", async () => {
    const rawToolTextParts = [
      ["[tool:read]", "<parameter=path>", "x".repeat(256_001)].join("\n"),
      ["</parameter>", "</function>"].join("\n"),
    ];
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: rawToolTextParts.map((text) => ({ type: "text", text })),
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
    expect(JSON.stringify(events)).not.toContain("</parameter>");
  });

  it("scrubs over-cap buffers even when later text blocks contain complete tool calls", async () => {
    const incompleteOverCapTool = ["[tool:read]", "<parameter=path>", "x".repeat(256_001)].join(
      "\n",
    );
    const completeTool = '[tool:read] {"path":"src/index.ts"}';
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: incompleteOverCapTool },
              { type: "text", text: completeTool },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
    expect(JSON.stringify(events)).not.toContain("src/index.ts");
  });

  it("scrubs multiple incomplete over-cap tool blocks from done messages", async () => {
    const firstOverCapTool = ["[tool:read]", "<parameter=path>", "x".repeat(256_001)].join("\n");
    const secondOverCapTool = ["[tool:read]", "<parameter=path>", "y".repeat(256_001)].join("\n");
    const visibleText = "Visible text after the tool-looking blocks.";
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: firstOverCapTool },
              { type: "text", text: secondOverCapTool },
              { type: "text", text: visibleText },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
    expect(JSON.stringify(events)).not.toContain("x".repeat(256_001));
    expect(JSON.stringify(events)).not.toContain("y".repeat(256_001));
  });

  it("scrubs done-message over-cap blocks after visible text", async () => {
    const intro = "Visible intro.";
    const incompleteOverCapTool = ["[tool:read]", "<parameter=path>", "x".repeat(256_001)].join(
      "\n",
    );
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: intro },
              { type: "text", text: incompleteOverCapTool },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: intro }],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("scrubs split done-message over-cap blocks after visible text", async () => {
    const intro = "Visible intro.";
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: intro },
              { type: "text", text: "[tool:read]\n<parameter=path>" },
              { type: "text", text: "x".repeat(256_001) },
              { type: "text", text: ["</parameter>", "</function>"].join("\n") },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: intro }],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
    expect(JSON.stringify(events)).not.toContain("</parameter>");
  });

  it("scrubs small complete tool calls after over-cap visible text", async () => {
    const visibleText = `Visible intro ${"x".repeat(256_001)}`;
    const toolText = '[tool:read] {"path":"src/index.ts"}';
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: visibleText },
              { type: "text", text: toolText },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual(["done"]);
    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: visibleText }],
      stopReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain(toolText);
  });

  it("does not leak over-cap buffers when stripped later tool blocks are followed by text", async () => {
    const incompleteOverCapTool = ["[tool:read]", "<parameter=path>", "x".repeat(256_001)].join(
      "\n",
    );
    const completeTool = '[tool:read] {"path":"src/index.ts"}';
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: incompleteOverCapTool },
              { type: "text", text: completeTool },
              { type: "text", text: "Visible text after the tool-looking blocks." },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(JSON.stringify(events)).not.toContain("[tool:read]");
    expect(JSON.stringify(events)).not.toContain("src/index.ts");
    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Visible text after the tool-looking blocks." }],
      stopReason: "stop",
    });
  });

  it("preserves unallowed tool-looking text while scrubbing an over-cap allowed tool block", async () => {
    const allowedOverCapTool = [
      "[tool:read]",
      "<parameter=path>",
      "x".repeat(256_001),
      "</parameter>",
      "</function>",
    ].join("\n");
    const unallowedToolText = '[tool:write] {"path":"keep-visible"}';
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: allowedOverCapTool },
              { type: "text", text: unallowedToolText },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(JSON.stringify(events)).toContain("[tool:write]");
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("flushes over-cap text for closed tool names that only prefix-match configured tools", async () => {
    const rawToolText = [
      "[tool:read]",
      "<parameter=path>",
      "x".repeat(256_001),
      "</parameter>",
      "</function>",
    ].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: rawToolText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawToolText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read_file" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(String(requireRecord(events[0], "text event").delta)).toContain("[tool:read]");
  });

  it("flushes long mixed text after a complete serialized tool-call prefix", async () => {
    const rawText = ['[tool:read] {"path":"src/index.ts"}', "A".repeat(256_001)].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: rawText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(String(requireRecord(events[0], "text event").delta)).toContain("AAAA");
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("scrubs mixed under-cap calls from multi-block done messages and results", async () => {
    const rawCall = "<function=read></function>";
    const visibleText = "Visible answer after the leaked call.";
    const rawText = `${rawCall}\n${visibleText}`;
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: rawText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: rawCall },
              { type: "text", text: visibleText },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const output = await resolveStream(
      wrapped({} as never, { tools: [{ name: "read" }] } as never, {}),
    );
    const resultPromise = output.result();
    const events: unknown[] = [];

    for await (const event of output as AsyncIterable<unknown>) {
      events.push(event);
    }
    const result = requireRecord(await resultPromise, "result message");
    const expectedContent = [{ type: "text", text: visibleText }];

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(requireRecord(events[0], "text event").delta).toBe(visibleText);
    expect(
      requireRecord(requireRecord(events[1], "done event").message, "done message").content,
    ).toEqual(expectedContent);
    expect(result.content).toEqual(expectedContent);
    expect(JSON.stringify({ events, result })).not.toContain("<function=read>");
  });

  it("scrubs mixed under-cap calls from multi-block errors without partials", async () => {
    const rawCall = "<function=read></function>";
    const visibleText = "Visible answer before the stream error.";
    const rawText = `${rawCall}\n${visibleText}`;
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: rawText },
        {
          type: "error",
          error: {
            role: "assistant",
            content: [
              { type: "text", text: rawCall },
              { type: "text", text: visibleText },
            ],
            message: "stream failed",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "text_delta",
      "error",
    ]);
    expect(requireRecord(events[0], "text event").delta).toBe(visibleText);
    expect(requireRecord(requireRecord(events[1], "error event").error, "error").content).toEqual([
      { type: "text", text: visibleText },
    ]);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("preserves visible suffix text after an over-cap JSON tool payload", async () => {
    const visibleSuffix = "Visible answer after oversized JSON.";
    const rawText = [`[tool:read] {"path":"${"x".repeat(256_001)}"}`, visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: rawText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "done",
    ]);
    const textEvent = requireRecord(events[0], "text event");
    expect(String(textEvent.delta)).toBe(visibleSuffix);
    expect(requireRecord(textEvent.partial, "text partial").content).toEqual([
      { type: "text", text: visibleSuffix },
    ]);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("reclassifies split over-cap mixed text and streams the visible suffix", async () => {
    const toolPrefix = ["[tool:read]", "<parameter=path>", "x".repeat(256_001)].join("\n");
    const visibleSuffix = "Visible answer after the tool-looking prefix.";
    const rawText = [toolPrefix, "</parameter>", "</function>", visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: toolPrefix },
        {
          type: "text_delta",
          contentIndex: 0,
          delta: ["</parameter>", "</function>", visibleSuffix].join("\n"),
        },
        { type: "text_end", contentIndex: 0, content: rawText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(String(requireRecord(events[0], "text event").delta)).toBe(visibleSuffix);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("preserves XML visible suffix after Unicode payload text", async () => {
    const toolPrefix = ["[tool:read]", "<parameter=path>", `${"x".repeat(256_001)}İ`].join("\n");
    const visibleSuffix = "Visible suffix after Unicode payload.";
    const rawText = [toolPrefix, "</parameter>", "</function>", visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: toolPrefix },
        {
          type: "text_delta",
          contentIndex: 0,
          delta: ["</parameter>", "</function>", visibleSuffix].join("\n"),
        },
        { type: "text_end", contentIndex: 0, content: rawText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(String(requireRecord(events[0], "text event").delta)).toBe(visibleSuffix);
    expect(JSON.stringify(events)).not.toContain("</parameter>");
    expect(JSON.stringify(events)).not.toContain("</function>");
  });

  it("scrubs reclassified mixed text from terminal error partials", async () => {
    const toolPrefix = ["[tool:read]", "<parameter=path>", "x".repeat(256_001)].join("\n");
    const visibleSuffix = "Visible answer before the stream error.";
    const rawText = [toolPrefix, "</parameter>", "</function>", visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: toolPrefix },
        {
          type: "text_delta",
          contentIndex: 0,
          delta: ["</parameter>", "</function>", visibleSuffix].join("\n"),
        },
        {
          type: "error",
          partial: { content: [{ type: "text", text: rawText }] },
          error: {
            content: [{ type: "text", text: rawText }],
            message: "stream failed",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "error",
    ]);
    expect(String(requireRecord(events[0], "text event").delta)).toBe(visibleSuffix);
    expect(
      requireRecord(requireRecord(events[1], "error event").partial, "error partial").content,
    ).toEqual([{ type: "text", text: visibleSuffix }]);
    expect(
      requireRecord(requireRecord(events[1], "error event").error, "error record").content,
    ).toEqual([{ type: "text", text: visibleSuffix }]);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("preserves visible suffix text when the tool terminator arrives after the scan cap", async () => {
    const toolPrefix = ["[tool:read]", "<parameter=path>", "x".repeat(400_000)].join("\n");
    const visibleSuffix = "Visible answer after a very large tool-looking prefix.";
    const rawText = [toolPrefix, "</parameter>", "</function>", visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: toolPrefix },
        {
          type: "text_delta",
          contentIndex: 0,
          delta: ["</parameter>", "</function>", visibleSuffix].join("\n"),
        },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(String(requireRecord(events[0], "text event").delta)).toBe(visibleSuffix);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("preserves a visible suffix after a named over-cap parameter without a function close", async () => {
    const toolPrefix = ["[read]", "<parameter=path>", "x".repeat(256_001)].join("\n");
    const visibleSuffix = "Visible answer after the incomplete tool-looking block.";
    const tail = ["</parameter>", visibleSuffix].join("\n");
    const rawText = [toolPrefix, tail].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: toolPrefix },
        { type: "text_delta", contentIndex: 0, delta: tail },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(requireRecord(events[0], "text event").delta).toBe(visibleSuffix);
    expect(
      requireRecord(requireRecord(events[1], "done event").message, "done message").content,
    ).toEqual([{ type: "text", text: visibleSuffix }]);
    expect(JSON.stringify(events)).not.toContain("[read]");
    expect(JSON.stringify(events)).not.toContain("</parameter>");
  });

  it("preserves visible suffix text when the over-cap terminator is split across chunks", async () => {
    const toolPrefix = ["[tool:read]", "<parameter=path>", "x".repeat(400_000)].join("\n");
    const visibleSuffix = "Visible answer after a split terminator.";
    const rawText = [toolPrefix, "</parameter>", "</function>", visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: toolPrefix },
        { type: "text_delta", contentIndex: 0, delta: "</par" },
        {
          type: "text_delta",
          contentIndex: 0,
          delta: ["ameter>", "</function>", visibleSuffix].join("\n"),
        },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(String(requireRecord(events[0], "text event").delta)).toBe(visibleSuffix);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("preserves long visible suffix text after an over-cap terminator", async () => {
    const toolPrefix = ["[tool:read]", "<parameter=path>", "x".repeat(400_000)].join("\n");
    const visibleSuffix = `Visible answer ${"y".repeat(70_000)}`;
    const rawText = [toolPrefix, "</parameter>", "</function>", visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: toolPrefix },
        {
          type: "text_delta",
          contentIndex: 0,
          delta: ["</parameter>", "</function>", visibleSuffix].join("\n"),
        },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(String(requireRecord(events[0], "text event").delta)).toBe(visibleSuffix);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it.each([
    ["both events omit contentIndex", {}, {}],
    ["only the delta omits contentIndex", {}, { contentIndex: 0 }],
    ["only text_end omits contentIndex", { contentIndex: 0 }, {}],
  ])("does not duplicate visible suffix text when %s", async (_name, deltaIndex, endIndex) => {
    const visibleSuffix = "Visible answer from a mixed-index stream.";
    const rawText = [`[tool:read] {"path":"${"x".repeat(256_001)}"}`, visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", ...deltaIndex, delta: rawText },
        { type: "text_end", ...endIndex, content: rawText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(String(requireRecord(events[0], "text event").delta)).toBe(visibleSuffix);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("deduplicates cumulative text_end across multiple stripped calls", async () => {
    const call = `<function=read>${"\u00a0".repeat(128_001)}</function>\n`;
    const first = `${call}ONE\n`;
    const second = `TWO\n${call}THREE`;
    const rawText = first + second;
    const events = await collectPlainTextToolCallCompatEvents([
      { type: "text_delta", contentIndex: 0, delta: first },
      { type: "text_delta", contentIndex: 0, delta: second },
      { type: "text_end", contentIndex: 0, content: rawText },
      {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawText }],
          stopReason: "stop",
        },
      },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "text_delta",
      "text_delta",
      "done",
    ]);
    expect(events.slice(0, 3).map((event) => event.delta)).toEqual(["ONE\n", "TWO\n", "THREE"]);
    expect(
      requireRecord(requireRecord(events.at(-1), "done event").message, "done message").content,
    ).toEqual([{ type: "text", text: "ONE\nTWO\nTHREE" }]);
  });

  it("keeps partial snapshots current for multi-delta visible suffix text", async () => {
    const firstVisible = "Visible answer ";
    const secondVisible = "continues.";
    const rawPrefix = `[tool:read] {"path":"${"x".repeat(256_001)}"}`;
    const firstChunk = [rawPrefix, firstVisible].join("\n");
    const rawText = `${firstChunk}${secondVisible}`;
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: firstChunk },
        {
          type: "text_delta",
          contentIndex: 0,
          delta: secondVisible,
          partial: { content: [{ type: "text", text: rawText }] },
        },
        { type: "text_end", contentIndex: 0, content: rawText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: rawText }],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    const secondEvent = requireRecord(events[1], "second text event");
    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "text_delta",
      "text_delta",
      "done",
    ]);
    expect(secondEvent.delta).toBe(secondVisible);
    expect(requireRecord(secondEvent.partial, "second partial").content).toEqual([
      { type: "text", text: `${firstVisible}${secondVisible}` },
    ]);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("preserves unrelated done-message text blocks when replacing a reclassified suffix", async () => {
    const introText = "Intro text before the reclassified block.";
    const visibleSuffix = "Visible suffix from the reclassified block.";
    const rawToolText = [`[tool:read] {"path":"${"x".repeat(256_001)}"}`, visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", contentIndex: 0, delta: introText },
        { type: "text_delta", contentIndex: 1, delta: rawToolText },
        { type: "text_end", contentIndex: 1, content: rawToolText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: introText },
              { type: "text", text: rawToolText },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    const doneMessage = requireRecord(
      requireRecord(events.at(-1), "done event").message,
      "done message",
    );
    expect(doneMessage.content).toEqual([
      { type: "text", text: introText },
      { type: "text", text: visibleSuffix },
    ]);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("preserves later done-message text blocks when replacing an indexless reclassified suffix", async () => {
    const visibleSuffix = "Visible suffix from the reclassified block.";
    const laterText = "Additional visible answer text.";
    const rawToolText = [`[tool:read] {"path":"${"x".repeat(256_001)}"}`, visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", delta: rawToolText },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: rawToolText },
              { type: "text", text: laterText },
            ],
            stopReason: "stop",
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [{ name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    const doneMessage = requireRecord(
      requireRecord(events.at(-1), "done event").message,
      "done message",
    );
    expect(doneMessage.content).toEqual([
      { type: "text", text: visibleSuffix },
      { type: "text", text: laterText },
    ]);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("keeps legacy bracketed XML parameter tool calls buffered for conversion", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const iterator = (await resolveStream(stream))[Symbol.asyncIterator]();
    const rawToolText = [
      "[read]",
      "<parameter=path>",
      "src/index.ts",
      "</parameter>",
      "</function>",
    ].join("\n");

    try {
      source.push({ type: "start", partial: { content: [] } } as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta: rawToolText,
      } as never);
      source.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawToolText }],
          stopReason: "stop",
        },
      } as never);

      const event = await nextEvent(iterator, "converted legacy bracketed XML tool call");
      expect(event.type).toBe("toolcall_start");
    } finally {
      source.end();
      await iterator.return?.();
    }
  });

  it("keeps CRLF legacy bracketed XML parameter tool calls buffered for conversion", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const iterator = (await resolveStream(stream))[Symbol.asyncIterator]();
    const rawToolText = [
      "[read]",
      "<parameter=path>",
      "src/index.ts",
      "</parameter>",
      "</function>",
    ].join("\r\n");

    try {
      source.push({ type: "start", partial: { content: [] } } as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta: rawToolText,
      } as never);
      source.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawToolText }],
          stopReason: "stop",
        },
      } as never);

      const event = await nextEvent(iterator, "converted CRLF legacy XML tool call");
      expect(event.type).toBe("toolcall_start");
    } finally {
      source.end();
      await iterator.return?.();
    }
  });

  it("promotes split zero-argument XML function calls without leaking partials", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const iterator = (await resolveStream(stream))[Symbol.asyncIterator]();
    const rawToolText = ["<function=read>", "</function>"].join("\n");

    try {
      source.push({ type: "start", partial: { content: [] } } as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      let streamedText = "";
      for (const delta of ["<", "function=read>\n</func", "tion>"]) {
        streamedText += delta;
        source.push({
          type: "text_delta",
          contentIndex: 0,
          delta,
          partial: {
            role: "assistant",
            content: [{ type: "text", text: streamedText }],
          },
        } as never);
      }
      source.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawToolText }],
          stopReason: "stop",
        },
      } as never);

      const events = [
        await nextEvent(iterator, "zero-argument tool-call start"),
        await nextEvent(iterator, "zero-argument tool-call arguments"),
        await nextEvent(iterator, "zero-argument tool-call end"),
        await nextEvent(iterator, "zero-argument done event"),
      ];
      expect(events.map((event) => event.type)).toEqual([
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ]);
      expect(events[1]).toMatchObject({ delta: "{}" });
      expect(events[3]).toMatchObject({
        reason: "toolUse",
        message: {
          content: [{ type: "toolCall", name: "read", arguments: {} }],
          stopReason: "toolUse",
        },
      });
      expect(JSON.stringify(events)).not.toContain("<function");
      expect(JSON.stringify(events)).not.toContain("</function>");
    } finally {
      source.end();
      await iterator.return?.();
    }
  });

  it("does not buffer normal final prose until done", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const iterator = (await resolveStream(stream))[Symbol.asyncIterator]();

    try {
      source.push({ type: "start", partial: { content: [] } } as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "final answer starts here",
      } as never);

      const event = await nextEvent(iterator, "normal final prose");
      expect(event).toMatchObject({ type: "text_delta", delta: "final answer starts here" });
    } finally {
      source.push({ type: "done", reason: "stop", message: {} } as never);
      source.end();
      await iterator.return?.();
    }
  });
});

describe("stripTrailingAnthropicAssistantPrefillWhenThinking", () => {
  it("removes trailing assistant text turns when Anthropic thinking is enabled", () => {
    const payload = {
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
        { role: "assistant", content: '"status"' },
      ],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(payload)).toBe(2);
    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });

  it("preserves assistant tool-use turns across Anthropic and OpenAI-shaped payloads", () => {
    const anthropicPayload = {
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Read a file." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read" }] },
      ],
    };
    const openAiPayload = {
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Read a file." },
        { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "Read" }] },
      ],
    };
    const toolCallsPayload = {
      thinking: { type: "adaptive" },
      messages: [{ role: "assistant", tool_calls: [{ id: "call_1", name: "Read" }] }],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(anthropicPayload)).toBe(0);
    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(openAiPayload)).toBe(0);
    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(toolCallsPayload)).toBe(0);
  });

  it("keeps assistant prefill when Anthropic thinking is disabled", () => {
    const payload = {
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(payload)).toBe(0);
    expect(payload.messages).toHaveLength(2);
  });
});

describe("createAnthropicThinkingPrefillPayloadWrapper", () => {
  it("reports stripped assistant prefill count", () => {
    const payload = {
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };
    let strippedCount = 0;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload as never, _model as never);
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createAnthropicThinkingPrefillPayloadWrapper(
      baseStreamFn,
      (stripped) => {
        strippedCount = stripped;
      },
      { shouldPatch: ({ model }) => model.api === "anthropic-messages" },
    );
    void wrapped({ api: "anthropic-messages" } as never, {} as never, {});

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
    expect(strippedCount).toBe(1);
  });
});
