import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createKimiToolCallMarkupWrapper, wrapKimiProviderStream } from "./stream.js";

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

describe("kimi tool-call markup wrapper", () => {
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
              type: "toolCall",
              id: "functions.read:0",
              name: "functions.read",
              arguments: { file_path: "./package.json" },
            },
          ],
          stopReason: "toolUse",
        },
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "functions.read:0",
              name: "functions.read",
              arguments: { file_path: "./package.json" },
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
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
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
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = async () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = (await wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    )) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("parses multiple tagged tool calls in one section", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_MULTI_TOOL_TEXT }],
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

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
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
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = wrapKimiProviderStream({
      streamFn: baseStreamFn,
    } as never);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
        },
      ],
      stopReason: "toolUse",
    });
  });
});
