import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
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
