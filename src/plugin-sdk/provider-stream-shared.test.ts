import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  buildCopilotDynamicHeaders,
  createHtmlEntityToolCallArgumentDecodingWrapper,
  defaultToolStreamExtraParams,
  decodeHtmlEntitiesInObject,
  hasCopilotVisionInput,
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

describe("buildCopilotDynamicHeaders", () => {
  it("matches Copilot IDE-style request headers without the legacy Openai-Intent", () => {
    expect(
      buildCopilotDynamicHeaders({
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        hasImages: false,
      }),
    ).toMatchObject({
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Plugin-Version": "copilot-chat/0.35.0",
      "Openai-Organization": "github-copilot",
      "x-initiator": "user",
    });
    expect(
      buildCopilotDynamicHeaders({
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        hasImages: false,
      }),
    ).not.toHaveProperty("Openai-Intent");
  });

  it("marks tool-result follow-up turns as agent initiated and vision-capable", () => {
    expect(
      buildCopilotDynamicHeaders({
        messages: [
          { role: "user", content: "hi", timestamp: 1 },
          {
            role: "toolResult",
            content: [{ type: "image", data: "abc", mimeType: "image/png" }],
            timestamp: 2,
            toolCallId: "call_1",
            toolName: "view_image",
            isError: false,
          },
        ],
        hasImages: true,
      }),
    ).toMatchObject({
      "Copilot-Vision-Request": "true",
      "x-initiator": "agent",
    });
  });

  it("detects nested tool-result image blocks in user-shaped provider payloads", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "image", source: { data: "abc", media_type: "image/png" } }],
          },
        ],
        timestamp: 1,
      },
    ] as unknown as Parameters<typeof buildCopilotDynamicHeaders>[0]["messages"];

    expect(hasCopilotVisionInput(messages)).toBe(true);
    expect(buildCopilotDynamicHeaders({ messages, hasImages: true })).toMatchObject({
      "Copilot-Vision-Request": "true",
      "x-initiator": "agent",
    });
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
