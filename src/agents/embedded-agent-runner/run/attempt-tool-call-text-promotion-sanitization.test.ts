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
