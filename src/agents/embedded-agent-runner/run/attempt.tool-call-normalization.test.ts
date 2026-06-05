// Coverage for normalizing tool calls before and during model replay.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  sanitizeOpenAIResponsesReplayForStream,
  sanitizeReplayToolCallIdsForStream,
  shouldApplyReplayToolCallIdSanitizer,
  wrapStreamFnPromoteStandaloneTextToolCalls,
} from "./attempt.tool-call-normalization.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
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

async function collectStreamEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  // Drain streams to inspect generated tool-call events after wrapper mutation.
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireAssistantMessage(message: AgentMessage | undefined): AssistantMessage {
  if (!message || message.role !== "assistant") {
    throw new Error(`expected assistant message, got ${message?.role ?? "missing"}`);
  }
  return message;
}

function requireToolResultMessage(message: AgentMessage | undefined): ToolResultMessage {
  if (!message || message.role !== "toolResult") {
    throw new Error(`expected toolResult message, got ${message?.role ?? "missing"}`);
  }
  return message;
}

function assistantToolUseSummaries(message: AgentMessage | undefined) {
  // Replay sanitizer assertions compare stable id/name summaries instead of
  // full provider-specific message payloads.
  const assistant = requireAssistantMessage(message);
  return assistant.content.map((content) => {
    const record = content as unknown as Record<string, unknown>;
    if (record.type !== "toolUse") {
      throw new Error(`expected toolUse content, got ${String(record.type)}`);
    }
    return {
      type: record.type,
      id: record.id,
      name: record.name,
    };
  });
}

function toolResultSummary(message: AgentMessage | undefined) {
  const toolResult = requireToolResultMessage(message);
  const record = toolResult as unknown as Record<string, unknown>;
  return {
    role: toolResult.role,
    toolCallId: toolResult.toolCallId,
    toolUseId: record.toolUseId,
    toolName: toolResult.toolName,
    isError: toolResult.isError,
  };
}

describe("wrapStreamFnPromoteStandaloneTextToolCalls", () => {
  it("promotes standalone serialized parameter XML text to structured tool calls", async () => {
    // Some providers emit tool calls as text blocks; promote only allowed tool
    // names into structured toolCall content.
    const rawToolText = [
      "[tool:exec]",
      "<parameter=command>",
      "cat /proc/mounts 2>/dev/null | head -20",
      "</parameter>",
      "</function>",
      "",
      "<function=exec>",
      "<parameter=command>",
      "find / -maxdepth 4 -type d 2>/dev/null | head -20",
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to audit the mount." },
        { type: "text", text: rawToolText },
      ],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "start", partial: { content: [] } },
          {
            type: "text_start",
            contentIndex: 1,
            partial: { content: [{ type: "text", text: "" }] },
          },
          { type: "text_delta", contentIndex: 1, delta: rawToolText },
          { type: "text_end", contentIndex: 1, content: rawToolText },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);
    const result = requireRecord(await stream.result(), "result message");

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    expect(requireRecord(events.at(-1), "done").reason).toBe("toolUse");
    expect(result.stopReason).toBe("toolUse");
    const content = result.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "thinking", thinking: "Need to audit the mount." });
    expect(content[1]).toMatchObject({
      type: "toolCall",
      name: "exec",
      arguments: { command: "cat /proc/mounts 2>/dev/null | head -20" },
      partialArgs: '{"command":"cat /proc/mounts 2>/dev/null | head -20"}',
    });
    expect(String(content[1].id)).toMatch(/^call_[a-f0-9]{24}$/);
    expect(content[2]).toMatchObject({
      type: "toolCall",
      name: "exec",
      arguments: { command: "find / -maxdepth 4 -type d 2>/dev/null | head -20" },
    });
  });

  it("preserves content indexes when promoting text before thinking", async () => {
    const rawToolText = [
      "[tool:exec]",
      "<parameter=command>",
      "pwd",
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [
        { type: "text", text: rawToolText },
        { type: "thinking", thinking: "Need the current directory." },
      ],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: rawToolText },
          {
            type: "thinking_delta",
            contentIndex: 1,
            delta: "Need the current directory.",
            partial: {
              content: [
                { type: "text", text: rawToolText },
                { type: "thinking", thinking: "Need the current directory." },
              ],
            },
          },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);
    const result = requireRecord(await stream.result(), "result message");

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    expect(requireRecord(events[0], "thinking event").contentIndex).toBe(1);
    expect(requireRecord(events[1], "toolcall start").contentIndex).toBe(0);
    expect((result.content as Array<Record<string, unknown>>).map((block) => block.type)).toEqual([
      "toolCall",
      "thinking",
    ]);
  });

  it("preserves intervening thinking when promoting multiple text blocks", async () => {
    const firstRawToolText = [
      "[tool:exec]",
      "<parameter=command>",
      "pwd",
      "</parameter>",
      "</function>",
    ].join("\n");
    const secondRawToolText = [
      "[tool:exec]",
      "<parameter=command>",
      "whoami",
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [
        { type: "text", text: firstRawToolText },
        { type: "thinking", thinking: "Need one more check." },
        { type: "text", text: secondRawToolText },
      ],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: firstRawToolText },
          {
            type: "thinking_delta",
            contentIndex: 1,
            delta: "Need one more check.",
            partial: {
              content: [
                { type: "text", text: firstRawToolText },
                { type: "thinking", thinking: "Need one more check." },
                { type: "text", text: secondRawToolText },
              ],
            },
          },
          { type: "text_delta", contentIndex: 2, delta: secondRawToolText },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);
    const result = requireRecord(await stream.result(), "result message");

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    expect(requireRecord(events[0], "thinking event").contentIndex).toBe(1);
    expect(requireRecord(events[1], "first toolcall start").contentIndex).toBe(0);
    expect(requireRecord(events[3], "second toolcall start").contentIndex).toBe(2);
    expect((result.content as Array<Record<string, unknown>>).map((block) => block.type)).toEqual([
      "toolCall",
      "thinking",
      "toolCall",
    ]);
    expect(requireRecord((result.content as unknown[])[0], "first tool call")).toMatchObject({
      name: "exec",
      arguments: { command: "pwd" },
    });
    expect(requireRecord((result.content as unknown[])[2], "second tool call")).toMatchObject({
      name: "exec",
      arguments: { command: "whoami" },
    });
  });

  it("promotes serialized tool calls split across adjacent text blocks", async () => {
    const resultMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "[tool:exec]\n<parameter=command>\n" },
        { type: "text", text: "pwd\n</parameter>\n</function>" },
        { type: "thinking", thinking: "Checking location." },
      ],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: "[tool:exec]\n<parameter=command>\n" },
          { type: "text_delta", contentIndex: 1, delta: "pwd\n</parameter>\n</function>" },
          {
            type: "thinking_delta",
            contentIndex: 2,
            delta: "Checking location.",
            partial: { content: resultMessage.content },
          },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);
    const result = requireRecord(await stream.result(), "result message");

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    expect(requireRecord(events[0], "thinking event").contentIndex).toBe(2);
    expect(requireRecord(events[1], "toolcall start").contentIndex).toBe(0);
    expect((result.content as Array<Record<string, unknown>>).map((block) => block.type)).toEqual([
      "toolCall",
      "thinking",
    ]);
    expect(requireRecord((result.content as unknown[])[0], "tool call")).toMatchObject({
      name: "exec",
      arguments: { command: "pwd" },
    });
  });

  it("buffers case-insensitive tool-name prefixes until final promotion", async () => {
    const rawToolText = [
      "[tool:read]",
      "<parameter=path>",
      "src/index.ts",
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: "[tool:rea" },
          { type: "text_delta", contentIndex: 0, delta: rawToolText.slice("[tool:rea".length) },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["Read"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);
    const result = requireRecord(await stream.result(), "result message");

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    expect(result.stopReason).toBe("toolUse");
    expect(requireRecord((result.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "Read",
      arguments: { path: "src/index.ts" },
    });
  });

  it("buffers normalized alias tool-name prefixes until final promotion", async () => {
    const rawToolText = [
      "[tool:bash]",
      "<parameter=command>",
      "pwd",
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: "[tool:ba" },
          { type: "text_delta", contentIndex: 0, delta: rawToolText.slice("[tool:ba".length) },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);
    const result = requireRecord(await stream.result(), "result message");

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    expect(requireRecord((result.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "exec",
      arguments: { command: "pwd" },
    });
  });

  it("keeps possible tool-call text buffered across interleaved non-text events", async () => {
    const rawToolText = [
      "[tool:exec]",
      "<parameter=command>",
      "pwd",
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need shell state." },
        { type: "text", text: rawToolText },
      ],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 1, delta: rawToolText },
          {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Need shell state.",
            partial: {
              content: [
                { type: "thinking", thinking: "Need shell state." },
                { type: "text", text: rawToolText },
              ],
            },
          },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[0], "thinking event");
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "thinking", thinking: "Need shell state." },
    ]);
    expect(JSON.stringify(events)).not.toContain(rawToolText);
  });

  it("preserves interleaved event content indexes when buffered text is scrubbed first", async () => {
    const rawToolText = [
      "[tool:exec]",
      "<parameter=command>",
      "pwd",
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [
        { type: "text", text: rawToolText },
        { type: "thinking", thinking: "Need shell state." },
      ],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: rawToolText },
          {
            type: "thinking_delta",
            contentIndex: 1,
            delta: "Need shell state.",
            partial: {
              content: [
                { type: "text", text: rawToolText },
                { type: "thinking", thinking: "Need shell state." },
              ],
            },
          },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[0], "thinking event");
    expect(thinkingEvent.contentIndex).toBe(1);
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "text", text: "" },
      { type: "thinking", thinking: "Need shell state." },
    ]);
    expect(JSON.stringify(events)).not.toContain(rawToolText);
  });

  it("closes the underlying stream iterator when consumers stop early", async () => {
    const returnIterator = vi.fn(async () => ({ done: true, value: undefined }));
    const nextIterator = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: { type: "start", partial: { content: [] } } })
      .mockResolvedValue({ done: true, value: undefined });
    const baseFn = vi.fn(() => ({
      async result() {
        return { role: "assistant", content: [], stopReason: "stop" };
      },
      [Symbol.asyncIterator]() {
        return {
          next: nextIterator,
          return: returnIterator,
        };
      },
    }));
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;
    const iterator = stream[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "start", partial: { content: [] } },
    });
    await iterator.return?.();

    expect(returnIterator).toHaveBeenCalledTimes(1);
  });

  it("flushes buffered text before terminal error events", async () => {
    const rawToolText = "[tool:exec]";
    const errorEvent = { type: "error", error: new Error("stream failed") };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [{ type: "text_delta", contentIndex: 0, delta: rawToolText }, errorEvent],
        resultMessage: { role: "assistant", content: [], stopReason: "stop" },
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);

    expect(events).toEqual([
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      errorEvent,
    ]);
  });

  it("buffers split XML function markers until final promotion", async () => {
    const rawToolText = [
      "<function=exec>",
      "<parameter=command>",
      "pwd",
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: "<" },
          { type: "text_delta", contentIndex: 0, delta: rawToolText.slice(1) },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
  });

  it("suppresses over-cap serialized XMLish text instead of flushing it", async () => {
    const rawToolText = [
      "[tool:exec]",
      "<parameter=command>",
      "x".repeat(256_001),
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "start", partial: { content: [] } },
          {
            type: "text_start",
            contentIndex: 0,
            partial: { content: [{ type: "text", text: "" }] },
          },
          { type: "text_delta", contentIndex: 0, delta: rawToolText },
          {
            type: "thinking_delta",
            contentIndex: 1,
            delta: "still thinking",
            partial: {
              content: [
                { type: "text", text: rawToolText },
                { type: "thinking", thinking: "still thinking" },
              ],
            },
          },
          { type: "text_end", contentIndex: 0, content: rawToolText },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);
    const result = requireRecord(await stream.result(), "result message");

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "start",
      "thinking_delta",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[1], "thinking event");
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "text", text: "" },
      { type: "thinking", thinking: "still thinking" },
    ]);
    const doneEvent = requireRecord(events[2], "done event");
    expect(doneEvent.reason).toBe("stop");
    expect(doneEvent.message).toMatchObject({
      role: "assistant",
      content: [],
      stopReason: "stop",
    });
    expect(result).toMatchObject({ role: "assistant", content: [], stopReason: "stop" });
    expect(JSON.stringify(events)).not.toContain("[tool:exec]");
    expect(JSON.stringify(result)).not.toContain("[tool:exec]");
  });

  it("scrubs split over-cap serialized XMLish text blocks from done messages", async () => {
    const rawToolTextParts = [
      "[tool:exec]\n<parameter=command>",
      ["x".repeat(256_001), "</parameter>", "</function>"].join("\n"),
    ];
    const resultMessage = {
      role: "assistant",
      content: rawToolTextParts.map((text) => ({ type: "text", text })),
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [{ type: "done", reason: "stop", message: resultMessage }],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);
    const result = requireRecord(await stream.result(), "result message");

    expect(requireRecord(events[0], "done event").message).toMatchObject({
      role: "assistant",
      content: [],
      stopReason: "stop",
    });
    expect(result).toMatchObject({ role: "assistant", content: [], stopReason: "stop" });
    expect(JSON.stringify(events)).not.toContain("[tool:exec]");
    expect(JSON.stringify(result)).not.toContain("</parameter>");
  });

  it("preserves visible suffix text after an over-cap JSON tool payload", async () => {
    const visibleSuffix = "Visible answer after oversized JSON.";
    const rawText = [`[tool:exec] {"command":"${"x".repeat(256_001)}"}`, visibleSuffix].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [{ type: "text", text: rawText }],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: rawText },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);

    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "text_delta",
      "done",
    ]);
    const textEvent = requireRecord(events[0], "text event");
    expect(String(textEvent.delta)).toBe(visibleSuffix);
    expect(requireRecord(textEvent.partial, "text partial").content).toEqual([
      { type: "text", text: visibleSuffix },
    ]);
    expect(JSON.stringify(events)).not.toContain("[tool:exec]");
  });

  it("does not buffer normal prose that starts like a final answer", async () => {
    const resultMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Finally, the audit is done." }],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: "Finally, the audit is done." },
          { type: "done", reason: "stop", message: resultMessage },
        ],
        resultMessage,
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = await collectStreamEvents(stream);

    expect(events).toEqual([
      { type: "text_delta", contentIndex: 0, delta: "Finally, the audit is done." },
      { type: "done", reason: "stop", message: resultMessage },
    ]);
  });
});

describe("sanitizeReplayToolCallIdsForStream", () => {
  it("skips strict stream id sanitization when provider policy opts out", () => {
    expect(
      shouldApplyReplayToolCallIdSanitizer({
        sanitizeToolCallIds: false,
        isOpenAIResponsesApi: false,
      }),
    ).toBe(false);
    expect(
      shouldApplyReplayToolCallIdSanitizer({
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        isOpenAIResponsesApi: false,
      }),
    ).toBe(true);
    expect(
      shouldApplyReplayToolCallIdSanitizer({
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        isOpenAIResponsesApi: true,
      }),
    ).toBe(false);
  });

  it("drops orphaned tool results after strict id sanitization", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_function_av7cbkigmk7x1",
        toolUseId: "call_function_av7cbkigmk7x1",
        toolName: "read",
        content: [{ type: "text", text: "stale" }],
        isError: false,
      } as never,
    ];

    expect(
      sanitizeReplayToolCallIdsForStream({
        messages,
        mode: "strict",
        repairToolUseResultPairing: true,
      }),
    ).toStrictEqual([]);
  });

  it("keeps matched assistant and tool-result ids aligned", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: rawId, name: "read", input: { path: "." } }],
      } as never,
      {
        role: "toolResult",
        toolCallId: rawId,
        toolUseId: rawId,
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
    ];

    const out = sanitizeReplayToolCallIdsForStream({
      messages,
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(assistantToolUseSummaries(out[0])).toEqual([
      { type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" },
    ]);
    expect(toolResultSummary(out[1])).toEqual({
      role: "toolResult",
      toolCallId: "callfunctionav7cbkigmk7x1",
      toolUseId: "callfunctionav7cbkigmk7x1",
      toolName: "read",
      isError: false,
    });
  });

  it("preserves signed-thinking replay ids when requested by provider policy", () => {
    const rawId = "call_1";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
            { type: "toolUse", id: rawId, name: "read", input: { path: "." } },
          ],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        } as never,
      ],
      mode: "strict",
      preserveReplaySafeThinkingToolCallIds: true,
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(requireAssistantMessage(out[0]).content[1]).toMatchObject({
      type: "toolUse",
      id: "call_1",
      name: "read",
    });
    expect(toolResultSummary(out[1])).toEqual({
      role: "toolResult",
      toolCallId: "call_1",
      toolUseId: "call_1",
      toolName: "read",
      isError: false,
    });
  });

  it("synthesizes missing tool results after strict id sanitization", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolUse", id: rawId, name: "read", input: { path: "." } },
            { type: "toolUse", id: "call_missing", name: "exec", input: { cmd: "true" } },
          ],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult", "toolResult"]);
    expect(assistantToolUseSummaries(out[0])).toEqual([
      { type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" },
      { type: "toolUse", id: "callmissing", name: "exec" },
    ]);
    expect(toolResultSummary(out[1])).toEqual({
      role: "toolResult",
      toolCallId: "callfunctionav7cbkigmk7x1",
      toolUseId: "callfunctionav7cbkigmk7x1",
      toolName: "read",
      isError: false,
    });
    expect(toolResultSummary(out[2])).toEqual({
      role: "toolResult",
      toolCallId: "callmissing",
      toolUseId: undefined,
      toolName: "exec",
      isError: true,
    });
  });

  it("synthesizes missing tool results when repair is enabled", () => {
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "call_missing", name: "exec", input: { cmd: "true" } }],
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(toolResultSummary(out[1])).toEqual({
      role: "toolResult",
      toolCallId: "callmissing",
      toolUseId: undefined,
      toolName: "exec",
      isError: true,
    });
  });

  it("keeps real tool results for aborted assistant spans", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "toolUse", id: rawId, name: "read", input: { path: "." } }],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "read",
          content: [{ type: "text", text: "partial" }],
          isError: false,
        } as never,
        {
          role: "user",
          content: [{ type: "text", text: "retry" }],
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
    expect(requireAssistantMessage(out[0]).stopReason).toBe("aborted");
    expect(assistantToolUseSummaries(out[0])).toEqual([
      { type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" },
    ]);
    expect(toolResultSummary(out[1])).toEqual({
      role: "toolResult",
      toolCallId: "callfunctionav7cbkigmk7x1",
      toolUseId: "callfunctionav7cbkigmk7x1",
      toolName: "read",
      isError: false,
    });
  });
});

describe("sanitizeOpenAIResponsesReplayForStream", () => {
  it("normalizes live responses continuations before pi-ai splits ids", () => {
    const longCallId = `call_${"x".repeat(120)}`;
    const longItemId = `notfc_${"y".repeat(120)}`;
    const rawToolCallId = `${longCallId}|${longItemId}`;
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: rawToolCallId, name: "noop", arguments: {} }],
      } as never,
      {
        role: "toolResult",
        toolCallId: rawToolCallId,
        toolName: "noop",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
    ];

    const out = sanitizeOpenAIResponsesReplayForStream(messages);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content.find(
      (block) =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "toolCall" &&
        typeof (block as { id?: unknown }).id === "string",
    ) as { id: string } | undefined;

    expect(toolCall?.id).toMatch(/^call_[A-Za-z0-9_-]{1,59}$/);
    expect(toolCall?.id).not.toBe(rawToolCallId);
    expect(toolCall?.id).not.toContain("|");
    expect((out[1] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe(toolCall?.id);
  });

  it("preserves canonical same-model reasoning pairs", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "internal",
            thinkingSignature: JSON.stringify({ id: "rs_123", type: "reasoning" }),
          },
          { type: "toolCall", id: "call_123|fc_123", name: "noop", arguments: {} },
        ],
      } as never,
      {
        role: "toolResult",
        toolCallId: "call_123|fc_123",
        toolName: "noop",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
    ];

    expect(sanitizeOpenAIResponsesReplayForStream(messages)).toBe(messages);
  });
});
