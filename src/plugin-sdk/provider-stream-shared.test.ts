import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  buildCopilotDynamicHeaders,
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createHtmlEntityToolCallArgumentDecodingWrapper,
  createAnthropicThinkingPrefillPayloadWrapper,
  createPayloadPatchStreamWrapper,
  defaultToolStreamExtraParams,
  decodeHtmlEntitiesInObject,
  hasCopilotVisionInput,
  isOpenAICompatibleThinkingEnabled,
  stripTrailingAnthropicAssistantPrefillWhenThinking,
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

describe("isOpenAICompatibleThinkingEnabled", () => {
  it("uses explicit request reasoning before session thinking level", () => {
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "high",
        options: { reasoning: "none" } as never,
      }),
    ).toBe(false);
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "off",
        options: { reasoningEffort: "medium" } as never,
      }),
    ).toBe(true);
  });

  it("treats off and none as disabled", () => {
    expect(isOpenAICompatibleThinkingEnabled({ thinkingLevel: "off", options: {} })).toBe(false);
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "high",
        options: { reasoning: "none" } as never,
      }),
    ).toBe(false);
  });

  it("defaults to enabled for missing or non-string values", () => {
    expect(isOpenAICompatibleThinkingEnabled({ thinkingLevel: undefined, options: {} })).toBe(true);
    expect(
      isOpenAICompatibleThinkingEnabled({
        thinkingLevel: "off",
        options: { reasoning: { effort: "off" } } as never,
      }),
    ).toBe(true);
  });
});

describe("createDeepSeekV4OpenAICompatibleThinkingWrapper", () => {
  it("backfills reasoning_content on every replayed assistant message when thinking is enabled", () => {
    const payload = {
      messages: [
        { role: "user", content: "read file" },
        { role: "assistant", tool_calls: [{ id: "call_1", name: "read" }] },
        { role: "tool", content: "ok" },
        { role: "assistant", content: "done" },
        { role: "assistant", content: "kept", reasoning_content: "native reasoning" },
      ],
    };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload as never, _model as never);
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn,
      thinkingLevel: "high",
      shouldPatchModel: () => true,
    });
    void wrapped?.({} as never, {} as never, {});

    expect(payload.messages[0]).not.toHaveProperty("reasoning_content");
    expect(payload.messages[1]).toHaveProperty("reasoning_content", "");
    expect(payload.messages[2]).not.toHaveProperty("reasoning_content");
    expect(payload.messages[3]).toHaveProperty("reasoning_content", "");
    expect(payload.messages[4]).toHaveProperty("reasoning_content", "native reasoning");
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

describe("createPayloadPatchStreamWrapper", () => {
  it("passes stream call options to payload patches", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, options }) => {
      payload.reasoning = (options as { reasoning?: unknown } | undefined)?.reasoning;
    });
    void wrapped(
      { id: "model" } as never,
      { messages: [] } as never,
      {
        reasoning: "medium",
      } as never,
    );

    expect(captured).toEqual({ reasoning: "medium" });
  });

  it("calls the underlying stream directly when shouldPatch rejects the model", () => {
    let onPayloadWasInstalled = false;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      onPayloadWasInstalled = typeof options?.onPayload === "function";
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createPayloadPatchStreamWrapper(
      baseStreamFn,
      ({ payload }) => {
        payload.unexpected = true;
      },
      { shouldPatch: () => false },
    );
    void wrapped({ id: "model" } as never, { messages: [] } as never, {});

    expect(onPayloadWasInstalled).toBe(false);
  });
});

describe("stripTrailingAnthropicAssistantPrefillWhenThinking", () => {
  it("removes trailing assistant text turns when Anthropic thinking is enabled", () => {
    const payload = {
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
        { role: "assistant", content: '"status"' },
      ],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(payload)).toBe(2);
    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });

  it("preserves assistant tool-use turns across Anthropic and OpenAI-shaped payloads", () => {
    const anthropicPayload = {
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Read a file." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read" }] },
      ],
    };
    const openAiPayload = {
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Read a file." },
        { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "Read" }] },
      ],
    };
    const toolCallsPayload = {
      thinking: { type: "adaptive" },
      messages: [{ role: "assistant", tool_calls: [{ id: "call_1", name: "Read" }] }],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(anthropicPayload)).toBe(0);
    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(openAiPayload)).toBe(0);
    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(toolCallsPayload)).toBe(0);
  });

  it("keeps assistant prefill when Anthropic thinking is disabled", () => {
    const payload = {
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(payload)).toBe(0);
    expect(payload.messages).toHaveLength(2);
  });
});

describe("createAnthropicThinkingPrefillPayloadWrapper", () => {
  it("reports stripped assistant prefill count", () => {
    const payload = {
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };
    let strippedCount = 0;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload as never, _model as never);
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createAnthropicThinkingPrefillPayloadWrapper(
      baseStreamFn,
      (stripped) => {
        strippedCount = stripped;
      },
      { shouldPatch: ({ model }) => model.api === "anthropic-messages" },
    );
    void wrapped({ api: "anthropic-messages" } as never, {} as never, {});

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
    expect(strippedCount).toBe(1);
  });
});
