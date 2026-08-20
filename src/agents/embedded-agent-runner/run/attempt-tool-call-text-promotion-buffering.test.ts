// Coverage for promoting standalone text tool calls into structured events.

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
});
