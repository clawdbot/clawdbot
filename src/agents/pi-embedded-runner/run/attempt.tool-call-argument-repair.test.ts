import { describe, expect, it } from "vitest";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";

type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

type FakeStreamFn = (
  model: never,
  context: never,
  options: never,
) => FakeWrappedStream | Promise<FakeWrappedStream>;

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

async function invokeProviderStream(params: {
  provider: string;
  modelApi: string;
  baseFn: FakeStreamFn;
}): Promise<FakeWrappedStream> {
  const streamFn = shouldRepairMalformedToolCallArguments({
    provider: params.provider,
    modelApi: params.modelApi,
  })
    ? (wrapStreamFnRepairMalformedToolCallArguments(params.baseFn as never) as FakeStreamFn)
    : params.baseFn;
  return await Promise.resolve(streamFn({} as never, {} as never, {} as never));
}

describe("shouldRepairMalformedToolCallArguments", () => {
  it("keeps the repair enabled for kimi providers on anthropic-messages", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "kimi-coding",
        modelApi: "anthropic-messages",
      }),
    ).toBe(true);
  });

  it("enables the repair for openai-completions even when the provider is not kimi", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai-compatible",
        modelApi: "openai-completions",
      }),
    ).toBe(true);
  });

  it("does not enable the repair for unrelated non-kimi transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai-compatible",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("keeps kimi providers off on non-anthropic non-openai-completions transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "kimi-coding",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("does not enable the repair for direct OpenAI responses", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("enables the repair for Codex and Azure Responses transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai-codex",
        modelApi: "openai-codex-responses",
      }),
    ).toBe(true);
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "azure-openai-responses",
        modelApi: "azure-openai-responses",
      }),
    ).toBe(true);
  });
});

describe("openai-completions malformed tool-call argument repair", () => {
  it.each([
    ["openai-completions", "sglang"],
    ["openai-codex-responses", "openai-codex"],
    ["azure-openai-responses", "azure-openai-responses"],
  ])(
    "repairs fragmented %s function-call args before tool execution",
    async (modelApi, provider) => {
      const partialToolCall = { type: "functionCall", name: "read", arguments: {} };
      const streamedToolCall = { type: "functionCall", name: "read", arguments: {} };
      const endMessageToolCall = { type: "functionCall", name: "read", arguments: {} };
      const finalToolCall = { type: "functionCall", name: "read", arguments: {} };
      const partialMessage = { role: "assistant", content: [partialToolCall] };
      const endMessage = { role: "assistant", content: [endMessageToolCall] };
      const finalMessage = { role: "assistant", content: [finalToolCall] };

      const stream = await invokeProviderStream({
        provider,
        modelApi,
        baseFn: () =>
          createFakeStream({
            events: [
              {
                type: "toolcall_delta",
                contentIndex: 0,
                delta: ".functions.read:0 ",
                partial: partialMessage,
              },
              {
                type: "toolcall_delta",
                contentIndex: 0,
                delta: '{"path":"/tmp/report.txt"',
                partial: partialMessage,
              },
              {
                type: "toolcall_delta",
                contentIndex: 0,
                delta: "}x",
                partial: partialMessage,
              },
              {
                type: "toolcall_end",
                contentIndex: 0,
                toolCall: streamedToolCall,
                partial: partialMessage,
                message: endMessage,
              },
            ],
            resultMessage: finalMessage,
          }),
      });

      for await (const _item of stream) {
        // drain
      }
      const result = await stream.result();

      expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(result).toBe(finalMessage);
    },
  );
});
