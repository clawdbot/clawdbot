// Coverage for promoting standalone text tool calls into structured events.

import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt-tool-call-text-promotion.js";

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

const requireRecord = createRequireRecord("object", "expected-label");

describe("wrapStreamFnPromoteStandaloneTextToolCalls", () => {
  it("preserves a fenced allowed-tool example in live and terminal output", async () => {
    const parts = ["`", "``json\n", "[re", 'ad]\n{"path":"example.txt"}\n[/read]\n', "```"];
    const rawText = parts.join("");
    const createMessage = () => ({
      role: "assistant",
      content: [{ type: "text", text: rawText }],
      stopReason: "stop",
    });
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          ...parts.map((delta) => ({ type: "text_delta", contentIndex: 0, delta })),
          { type: "text_end", contentIndex: 0, content: rawText },
          { type: "done", reason: "stop", message: createMessage() },
        ],
        resultMessage: createMessage(),
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["read"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = (await collectStreamEvents(stream)).map((event) =>
      requireRecord(event, "event"),
    );
    const result = requireRecord(await stream.result(), "result message");

    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe(rawText);
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
    expect(requireRecord(events.at(-1)?.message, "done message").content).toEqual([
      { type: "text", text: rawText },
    ]);
    expect(result.content).toEqual([{ type: "text", text: rawText }]);
  });

  it("preserves a fenced example split across adjacent text blocks", async () => {
    const textParts = [
      "```json\n",
      ["[read]", '{"path":"example.txt"}', "[/read]", "\n"].join("\n"),
      "```",
    ];
    const content = textParts.map((text) => ({ type: "text", text }));
    const createMessage = () => ({
      role: "assistant",
      content,
      stopReason: "stop",
    });
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          ...textParts.flatMap((text, contentIndex) => [
            { type: "text_delta", contentIndex, delta: text },
            { type: "text_end", contentIndex, content: text },
          ]),
          { type: "done", reason: "stop", message: createMessage() },
        ],
        resultMessage: createMessage(),
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["read"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = (await collectStreamEvents(stream)).map((event) =>
      requireRecord(event, "event"),
    );
    const result = requireRecord(await stream.result(), "result message");

    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe(textParts.join(""));
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
    expect(requireRecord(events.at(-1)?.message, "done message").content).toEqual(content);
    expect(result.content).toEqual(content);
  });

  it("does not promote an indented code example from terminal output", async () => {
    const rawText = ["    [read]", '    {"path":"example.txt"}', "    [/read]"].join("\n");
    const createMessage = () => ({
      role: "assistant",
      content: [{ type: "text", text: rawText }],
      stopReason: "stop",
    });
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [{ type: "done", reason: "stop", message: createMessage() }],
        resultMessage: createMessage(),
      }),
    );
    const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set(["read"]));
    const stream = (await Promise.resolve(
      wrapped({} as never, {} as never, {} as never),
    )) as FakeWrappedStream;

    const events = (await collectStreamEvents(stream)).map((event) =>
      requireRecord(event, "event"),
    );
    const result = requireRecord(await stream.result(), "result message");

    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
    expect(requireRecord(events.at(-1)?.message, "done message").content).toEqual([
      { type: "text", text: rawText },
    ]);
    expect(result.content).toEqual([{ type: "text", text: rawText }]);
  });

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
});
