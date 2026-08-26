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
});
