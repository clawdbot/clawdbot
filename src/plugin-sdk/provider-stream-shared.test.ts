import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createAnthropicThinkingPrefillPayloadWrapper,
  createPayloadPatchStreamWrapper,
  createPlainTextToolCallCompatWrapper,
  defaultToolStreamExtraParams,
  isOpenAICompatibleThinkingEnabled,
  stripTrailingAnthropicAssistantPrefillWhenThinking,
} from "./provider-stream-shared.js";

type StreamEvent = { type: string } & Record<string, unknown>;

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

async function resolveStream(stream: ReturnType<StreamFn>) {
  return stream instanceof Promise ? await stream : stream;
}

async function nextEvent(iterator: AsyncIterator<unknown>, label: string): Promise<StreamEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 50)),
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
      "toolcall_start",
      "toolcall_delta",
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

  it("promotes complete under-cap text tool calls for non-stop terminal reasons", async () => {
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

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    const done = events.at(-1) as { reason?: unknown; message?: { stopReason?: unknown } };
    expect(done.reason).toBe("toolUse");
    expect(done.message?.stopReason).toBe("toolUse");
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
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[0], "thinking event");
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "thinking", thinking: "Need file contents." },
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
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[0], "thinking event");
    expect(thinkingEvent.contentIndex).toBe(1);
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "text", text: "" },
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

  it("suppresses over-cap bracketed XML parameter text instead of streaming it", async () => {
    const oversizedPath = "x".repeat(256_001);
    const rawToolText = [
      "[tool:read]",
      "<parameter=path>",
      oversizedPath,
      "</parameter>",
      "</function>",
    ].join("\n");
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
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("scrubs over-cap bracketed XML parameter text from terminal error partials", async () => {
    const rawToolText = ["[tool:read]", "<parameter=path>", "x".repeat(256_001)].join("\n");
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
      content: [{ type: "text", text: visibleText }],
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

  it("preserves small complete tool calls after over-cap visible text", async () => {
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
      content: [
        { type: "text", text: visibleText },
        { type: "text", text: toolText },
      ],
      stopReason: "stop",
    });
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

  it("does not duplicate visible suffix text when mixed over-cap events omit contentIndex", async () => {
    const visibleSuffix = "Visible answer from an index-less stream.";
    const rawText = [`[tool:read] {"path":"${"x".repeat(256_001)}"}`, visibleSuffix].join("\n");
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        { type: "text_delta", delta: rawText },
        { type: "text_end", content: rawText },
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

  it("keeps split XML function tool-call markers buffered for conversion", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const iterator = (await resolveStream(stream))[Symbol.asyncIterator]();
    const rawToolText = [
      "<function=read>",
      "<parameter=path>",
      "src/index.ts",
      "</parameter>",
      "</function>",
    ].join("\n");

    try {
      source.push({ type: "start", partial: { content: [] } } as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      source.push({ type: "text_delta", contentIndex: 0, delta: "<" } as never);
      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta: rawToolText.slice(1),
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

      const event = await nextEvent(iterator, "converted split XML tool call");
      expect(event.type).toBe("toolcall_start");
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
