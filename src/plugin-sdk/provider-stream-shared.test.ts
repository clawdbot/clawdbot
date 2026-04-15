import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  createHtmlEntityToolCallArgumentDecodingWrapper,
  defaultToolStreamExtraParams,
  decodeHtmlEntitiesInObject,
} from "./provider-stream-shared.js";

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

describe("decodeHtmlEntitiesInObject", () => {
  it("recursively decodes string values", () => {
    expect(
      decodeHtmlEntitiesInObject({
        command: "cd ~/dev &amp;&amp; echo &quot;ok&quot;",
        args: ["&lt;input&gt;", "&#x27;quoted&#x27;"],
      }),
    ).toEqual({
      command: 'cd ~/dev && echo "ok"',
      args: ["<input>", "'quoted'"],
    });
  });
});

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

describe("createHtmlEntityToolCallArgumentDecodingWrapper", () => {
  it("decodes tool call arguments in final and streaming messages", async () => {
    const resultMessage = {
      content: [
        {
          type: "toolCall",
          arguments: { command: "echo &quot;result&quot; &amp;&amp; true" },
        },
      ],
    };
    const streamEvent = {
      partial: {
        content: [
          {
            type: "toolCall",
            arguments: { path: "&lt;stream&gt;", nested: { quote: "&#39;x&#39;" } },
          },
        ],
      },
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({ events: [streamEvent], resultMessage }) as never;

    const stream = createHtmlEntityToolCallArgumentDecodingWrapper(baseStreamFn)(
      {} as never,
      {} as never,
      {},
    ) as FakeWrappedStream;

    await expect(stream.result()).resolves.toEqual({
      content: [
        {
          type: "toolCall",
          arguments: { command: 'echo "result" && true' },
        },
      ],
    });

    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        partial: {
          content: [
            {
              type: "toolCall",
              arguments: { path: "<stream>", nested: { quote: "'x'" } },
            },
          ],
        },
      },
    });
  });
});
