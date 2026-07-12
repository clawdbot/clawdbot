// Coverage for normalizing tool calls before and during model replay.

import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  sanitizeOpenAIResponsesReplayForStream,
  sanitizeReplayToolCallIdsForStream,
  shouldApplyReplayToolCallIdSanitizer,
  wrapStreamFnPromoteStandaloneTextToolCalls,
  wrapStreamFnSanitizeMalformedToolCalls,
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
      "toolcall_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
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
    expect(String(expectDefined(content[1], "content[1] test invariant").id)).toMatch(
      /^call_[a-f0-9]{24}$/,
    );
    expect(content[2]).toMatchObject({
      type: "toolCall",
      name: "exec",
      arguments: { command: "find / -maxdepth 4 -type d 2>/dev/null | head -20" },
    });
  });

  it("reuses promoted ids across cloned result and done messages", async () => {
    const rawToolText = "<function=exec></function>";
    const createMessage = () => ({
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    });
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: rawToolText },
          { type: "done", reason: "stop", message: createMessage() },
        ],
        resultMessage: createMessage(),
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const result = requireRecord(await stream.result(), "result message");
    const events = await collectStreamEvents(stream);
    const resultToolCall = requireRecord((result.content as unknown[])[0], "result tool call");
    const done = requireRecord(events.at(-1), "done event");
    const doneMessage = requireRecord(done.message, "done message");
    const doneToolCall = requireRecord((doneMessage.content as unknown[])[0], "done tool call");
    const lifecycle = events
      .map((event) => requireRecord(event, "event"))
      .filter((event) => String(event.type).startsWith("toolcall_"));

    expect(doneToolCall.id).toBe(resultToolCall.id);
    expect(lifecycle).toHaveLength(3);
    for (const event of lifecycle) {
      const partial = requireRecord(event.partial, "tool-call partial");
      expect(requireRecord((partial.content as unknown[])[0], "partial tool call").id).toBe(
        resultToolCall.id,
      );
    }
  });

  it("scrubs aggregate-over-cap call sequences before result promotion", async () => {
    const rawToolText = "<function=exec></function>\n".repeat(9_500);
    const createMessage = () => ({
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    });
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [{ type: "done", reason: "stop", message: createMessage() }],
        resultMessage: createMessage(),
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const result = requireRecord(await stream.result(), "result message");
    const events = await collectStreamEvents(stream);

    expect(new TextEncoder().encode(rawToolText).byteLength).toBeGreaterThan(256_000);
    expect(result.content).toEqual([]);
    expect(requireRecord(requireRecord(events[0], "done").message, "done message").content).toEqual(
      [],
    );
    expect(JSON.stringify({ events, result })).not.toContain("<function=exec>");
  });

  it("promotes deferred directory tool names from the live callable set", async () => {
    const rawToolText = [
      "[tool:hidden_catalog_tool]",
      "<parameter=value>",
      "deferred",
      "</parameter>",
      "</function>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage }));
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(
      baseFn as never,
      new Set(["tool_search", "tool_describe", "tool_call", "hidden_catalog_tool"]),
    );
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const result = requireRecord(await stream.result(), "result message");

    expect(requireRecord((result.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "hidden_catalog_tool",
      arguments: { value: "deferred" },
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
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "thinking_delta",
      "done",
    ]);
    expect(requireRecord(events[4], "thinking event").contentIndex).toBe(1);
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
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(requireRecord(events[4], "thinking event").contentIndex).toBe(1);
    expect(requireRecord(events[1], "first toolcall start").contentIndex).toBe(0);
    expect(requireRecord(events[5], "second toolcall start").contentIndex).toBe(2);
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
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "thinking_delta",
      "done",
    ]);
    expect(requireRecord(events[4], "thinking event").contentIndex).toBe(1);
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
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
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
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(requireRecord((result.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "exec",
      arguments: { command: "pwd" },
    });
  });

  it.each([
    {
      label: "case-insensitive name",
      allowedToolName: "Read",
      emittedToolName: "READ",
      expectedToolName: "Read",
      parameterName: "path",
      parameterValue: "src/index.ts",
    },
    {
      label: "normalized alias",
      allowedToolName: "exec",
      emittedToolName: "bash",
      expectedToolName: "exec",
      parameterName: "command",
      parameterValue: "pwd",
    },
  ])(
    "promotes $label XML consistently when the terminal reason is toolUse",
    async ({
      allowedToolName,
      emittedToolName,
      expectedToolName,
      parameterName,
      parameterValue,
    }) => {
      const rawToolText = [
        `<function=${emittedToolName}>`,
        `<parameter=${parameterName}>`,
        parameterValue,
        "</parameter>",
        "</function>",
      ].join("\n");
      const resultMessage = {
        role: "assistant",
        content: [{ type: "text", text: rawToolText }],
        stopReason: "toolUse",
      };
      const baseFn = vi.fn(() =>
        createFakeStream({
          events: [
            { type: "text_delta", contentIndex: 0, delta: rawToolText },
            { type: "done", reason: "toolUse", message: resultMessage },
          ],
          resultMessage,
        }),
      );
      const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(
        baseFn as never,
        new Set([allowedToolName]),
      );
      const stream = (await Promise.resolve(
        wrapped({} as never, {} as never, {} as never),
      )) as FakeWrappedStream;

      const events = await collectStreamEvents(stream);
      const result = requireRecord(await stream.result(), "result message");
      const expectedArguments = { [parameterName]: parameterValue };
      const expectedContent = [
        {
          type: "toolCall",
          id: expect.stringMatching(/^call_[a-f0-9]{24}$/),
          name: expectedToolName,
          arguments: expectedArguments,
          partialArgs: JSON.stringify(expectedArguments),
        },
      ];

      expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
        "start",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ]);
      expect(requireRecord(events[2], "toolcall delta").delta).toBe(
        JSON.stringify(expectedArguments),
      );
      const doneEvent = requireRecord(events[4], "done event");
      expect(doneEvent.reason).toBe("toolUse");
      expect(requireRecord(doneEvent.message, "done message").content).toEqual(expectedContent);
      expect(result).toMatchObject({ role: "assistant", stopReason: "toolUse" });
      expect(result.content).toEqual(expectedContent);
    },
  );

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
      "start",
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[1], "thinking event");
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "thinking", thinking: "Need shell state." },
      expect.objectContaining({
        type: "toolCall",
        name: "exec",
        arguments: { command: "pwd" },
      }),
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
      expect.objectContaining({
        type: "toolCall",
        name: "exec",
        arguments: { command: "pwd" },
      }),
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

  it("fails closed on buffered known-tool text before terminal errors", async () => {
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

    expect(events).toEqual([errorEvent]);
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
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
  });

  it.each([
    {
      label: "bracketed XML text over the character cap",
      marker: "[tool:exec]",
      rawToolText: [
        "[tool:exec]",
        "<parameter=command>",
        "x".repeat(256_001),
        "</parameter>",
        "</function>",
      ].join("\n"),
    },
    {
      label: "zero-argument XML text over the byte cap",
      marker: "<function=exec>",
      rawToolText: `<function=exec>${"\u00a0".repeat(128_001)}</function>`,
    },
    {
      label: "incomplete XML text over the byte cap",
      marker: "<function=exec>",
      rawToolText: `<function=exec>${"\u00a0".repeat(128_001)}`,
    },
  ])("suppresses $label instead of flushing it", async ({ marker, rawToolText }) => {
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
    expect(JSON.stringify(events)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(marker);
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

  it("scrubs an over-cap whitespace-only XML body split into its own text block", async () => {
    const resultMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "<function=exec>" },
        { type: "text", text: "\u00a0".repeat(128_001) },
        { type: "text", text: "</function>" },
      ],
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
    const expectedMessage = { role: "assistant", content: [], stopReason: "stop" };

    expect(events).toHaveLength(1);
    const doneEvent = requireRecord(events[0], "done event");
    expect(doneEvent.type).toBe("done");
    expect(doneEvent.reason).toBe("stop");
    expect(doneEvent.message).toEqual(expectedMessage);
    expect(result).toEqual(expectedMessage);
  });

  it.each(["error", "aborted"])(
    "scrubs over-cap XML from stream.result() when stopReason is %s",
    async (stopReason) => {
      const rawToolText = `<function=exec>${"\u00a0".repeat(128_001)}</function>`;
      const resultMessage = {
        role: "assistant",
        content: [{ type: "text", text: rawToolText }],
        stopReason,
      };
      const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage }));
      const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(
        baseFn as never,
        new Set(["exec"]),
      );
      const stream = (await Promise.resolve(
        wrapped({} as never, {} as never, {} as never),
      )) as FakeWrappedStream;

      const result = requireRecord(await stream.result(), "result message");

      expect(result).toEqual({ role: "assistant", content: [], stopReason });
      expect(JSON.stringify(result)).not.toContain("<function=exec>");
    },
  );

  it("scrubs an incomplete named call from stream.result()", async () => {
    const rawToolText = "<function=exec><parameter=command>SECRET";
    const resultMessage = {
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage }));
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const result = requireRecord(await stream.result(), "result message");

    expect(result).toEqual({ role: "assistant", content: [], stopReason: "stop" });
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

  it("scrubs mixed under-cap calls from pre-iteration results and multi-block done events", async () => {
    const rawCall = "<function=exec></function>";
    const visibleText = "Visible answer after the leaked call.";
    const rawText = `${rawCall}\n${visibleText}`;
    const createMessage = () => ({
      role: "assistant",
      content: [
        { type: "text", text: rawCall },
        { type: "text", text: visibleText },
      ],
      stopReason: "stop",
    });
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: rawText },
          { type: "done", reason: "stop", message: createMessage() },
        ],
        resultMessage: createMessage(),
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["exec"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const result = requireRecord(await stream.result(), "result message");
    const events = await collectStreamEvents(stream);
    const expectedContent = [{ type: "text", text: visibleText }];

    expect(result.content).toEqual(expectedContent);
    expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
      "text_delta",
      "done",
    ]);
    expect(requireRecord(events[0], "text event").delta).toBe(visibleText);
    expect(
      requireRecord(requireRecord(events[1], "done event").message, "done message").content,
    ).toEqual(expectedContent);
    expect(JSON.stringify({ events, result })).not.toContain("<function=exec>");
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

describe("wrapStreamFnSanitizeMalformedToolCalls", () => {
  it("keeps valid non-Responses replay inputs pass-through", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "image_generate",
            arguments: { prompt: "QA lighthouse" },
          },
        ],
      } as never,
    ];
    const baseFn = vi.fn((_model: unknown, _context: unknown, _options: unknown) =>
      createFakeStream({
        events: [],
        resultMessage: { role: "assistant", content: "ok" },
      }),
    );
    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["image_generate"]),
      undefined,
      "openai",
    );

    void wrapped({ api: "openai" } as never, { messages } as never, {} as never);

    const forwardedContext = baseFn.mock.calls[0]?.[1] as {
      messages?: AgentMessage[];
    };
    expect(forwardedContext.messages).toBe(messages);
  });

  it("repairs OpenAI Responses pairing even when replay inputs do not change", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_mock_image_generate_2",
            name: "image_generate",
            arguments: { prompt: "QA lighthouse" },
          },
        ],
      } as never,
      {
        role: "assistant",
        stopReason: "stop",
        content: "Worked: the QA lighthouse image completed.",
      } as never,
    ];
    const baseFn = vi.fn((_model: unknown, _context: unknown, _options: unknown) =>
      createFakeStream({
        events: [],
        resultMessage: { role: "assistant", content: "ok" },
      }),
    );
    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["image_generate"]),
      undefined,
      "openai",
    );

    void wrapped({ api: "openai-responses" } as never, { messages } as never, {} as never);

    const forwardedContext = baseFn.mock.calls[0]?.[1] as {
      messages?: AgentMessage[];
    };
    expect(forwardedContext.messages?.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(forwardedContext.messages?.[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_mock_image_generate_2",
      toolName: "image_generate",
      isError: true,
      content: [{ type: "text", text: "aborted" }],
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

  it("repairs dangling OpenAI Responses tool calls from async resume replay", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Image generation check. Generate an image of a QA lighthouse.",
      } as never,
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_mock_image_generate_1",
            name: "image_generate",
            arguments: { prompt: "QA lighthouse" },
          },
        ],
      } as never,
      {
        role: "toolResult",
        toolCallId: "call_mock_image_generate_1",
        toolName: "image_generate",
        content: [{ type: "text", text: "Background task started for image generation." }],
        isError: false,
      } as never,
      {
        role: "custom",
        content: "Image generation started; wait for completion.",
      } as never,
      {
        role: "user",
        content: "The image is ready for the original chat.",
      } as never,
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_mock_image_generate_2",
            name: "image_generate",
            arguments: { prompt: "QA lighthouse" },
          },
        ],
      } as never,
      {
        role: "assistant",
        stopReason: "stop",
        content: "Worked: the QA lighthouse image completed.",
      } as never,
    ];

    const out = sanitizeOpenAIResponsesReplayForStream(messages);
    const danglingAssistant = out[5] as AssistantMessage;
    const danglingToolCall = danglingAssistant.content.find(
      (block) =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "toolCall",
    ) as { id?: string } | undefined;
    const danglingResult = out[6] as Extract<AgentMessage, { role: "toolResult" }>;

    expect(out.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "custom",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(danglingResult.toolCallId).toBe(danglingToolCall?.id);
    expect(danglingResult.toolName).toBe("image_generate");
    expect(danglingResult.isError).toBe(true);
    expect(danglingResult.content).toEqual([{ type: "text", text: "aborted" }]);
  });
});
