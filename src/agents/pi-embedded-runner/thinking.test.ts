import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { castAgentMessage, castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import {
  OMITTED_ASSISTANT_REASONING_TEXT,
  assessLastAssistantMessage,
  dropThinkingBlocks,
  isAssistantMessageWithContent,
  sanitizeThinkingForRecovery,
  stripInvalidThinkingSignatures,
  wrapAnthropicStreamWithRecovery,
} from "./thinking.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function dropSingleAssistantContent(content: Array<Record<string, unknown>>) {
  const messages: AgentMessage[] = [
    castAgentMessage({
      role: "assistant",
      content,
    }),
  ];

  const result = dropThinkingBlocks(messages);
  return {
    assistant: result[0] as Extract<AgentMessage, { role: "assistant" }>,
    messages,
    result,
  };
}

describe("isAssistantMessageWithContent", () => {
  it("accepts assistant messages with array content and rejects others", () => {
    const assistant = castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    const user = castAgentMessage({ role: "user", content: "hi" });
    const malformed = castAgentMessage({ role: "assistant", content: "not-array" });

    expect(isAssistantMessageWithContent(assistant)).toBe(true);
    expect(isAssistantMessageWithContent(user)).toBe(false);
    expect(isAssistantMessageWithContent(malformed)).toBe(false);
  });
});

describe("dropThinkingBlocks", () => {
  it("returns the original reference when no thinking blocks are present", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "world" }] }),
    ];

    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("preserves thinking blocks when the assistant message is the latest assistant turn", () => {
    const { assistant, messages, result } = dropSingleAssistantContent([
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "final" },
    ]);
    expect(result).toBe(messages);
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "final" },
    ]);
  });

  it("preserves a latest assistant turn even when all content blocks are thinking", () => {
    const { assistant } = dropSingleAssistantContent([
      { type: "thinking", thinking: "internal-only" },
    ]);
    expect(assistant.content).toEqual([{ type: "thinking", thinking: "internal-only" }]);
  });

  it("preserves thinking blocks in the latest assistant message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "first" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old" },
          { type: "text", text: "old text" },
        ],
      }),
      castAgentMessage({ role: "user", content: "second" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
          { type: "text", text: "latest text" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const firstAssistant = result[1] as Extract<AgentMessage, { role: "assistant" }>;
    const latestAssistant = result[3] as Extract<AgentMessage, { role: "assistant" }>;

    expect(firstAssistant.content).toEqual([{ type: "text", text: "old text" }]);
    expect(latestAssistant.content).toEqual([
      { type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
      { type: "text", text: "latest text" },
    ]);
  });

  it("uses non-empty omitted-reasoning text when an older assistant turn is thinking-only", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "first" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "old", thinkingSignature: "sig_old" }],
      }),
      castAgentMessage({ role: "user", content: "second" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
          { type: "text", text: "latest text" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const oldAssistant = result[1] as Extract<AgentMessage, { role: "assistant" }>;
    const latestAssistant = result[3] as Extract<AgentMessage, { role: "assistant" }>;
    const originalLatestAssistant = messages[3] as Extract<AgentMessage, { role: "assistant" }>;

    expect(oldAssistant.content).toEqual([
      { type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT },
    ]);
    expect(latestAssistant.content).toEqual(originalLatestAssistant.content);
  });

  it("uses non-empty omitted-reasoning text when an older assistant turn is redacted-thinking-only", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "first" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "opaque" }],
      }),
      castAgentMessage({ role: "user", content: "second" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "latest text" }],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const oldAssistant = result[1] as Extract<AgentMessage, { role: "assistant" }>;

    expect(oldAssistant.content).toEqual([
      { type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT },
    ]);
  });
});

describe("stripInvalidThinkingSignatures", () => {
  it("returns the original reference when no invalid thinking signatures are present", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thinkingSignature: "sig" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);

    expect(result).toBe(messages);
  });

  it("strips thinking blocks with missing, empty, or blank signatures", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "missing" },
          { type: "thinking", thinking: "empty", thinkingSignature: "" },
          { type: "thinking", thinking: "blank", thinkingSignature: "   " },
          { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;

    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
      { type: "text", text: "answer" },
    ]);
  });

  it("uses non-empty omitted-reasoning text when all thinking signatures are invalid", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "" }],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;

    expect(assistant.content).toEqual([{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }]);
  });

  it("strips redacted thinking blocks with invalid opaque signatures", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "" },
          { type: "redacted_thinking", signature: "   " },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;

    expect(assistant.content).toEqual([
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "answer" },
    ]);
  });
});

describe("sanitizeThinkingForRecovery", () => {
  it("drops the latest assistant message when the thinking block is unsigned", () => {
    const messages = castAgentMessages([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "partial" }],
      },
    ]);

    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual([messages[0]]);
    expect(result.prefill).toBe(false);
  });

  it("preserves later turns when dropping an incomplete assistant message", () => {
    const messages = castAgentMessages([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "partial" }],
      },
      { role: "user", content: "follow up" },
    ]);

    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toEqual([messages[0], messages[2]]);
    expect(result.prefill).toBe(false);
  });

  it("marks signed thinking without text as a prefill recovery case", () => {
    const messages = castAgentMessages([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "complete", thinkingSignature: "sig" }],
      },
    ]);

    const result = sanitizeThinkingForRecovery(messages);
    expect(result.messages).toBe(messages);
    expect(result.prefill).toBe(true);
  });

  it("marks signed thinking with an empty text block as incomplete text", () => {
    const message = castAgentMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "complete", thinkingSignature: "sig" },
        { type: "text", text: "" },
      ],
    });

    expect(assessLastAssistantMessage(message)).toBe("incomplete-text");
  });

  it("treats partial text after signed thinking as valid", () => {
    const message = castAgentMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "complete", thinkingSignature: "sig" },
        { type: "text", text: "Here is my answ" },
      ],
    });

    expect(assessLastAssistantMessage(message)).toBe("valid");
  });

  it("treats non-string text blocks as incomplete text when thinking is signed", () => {
    const message = castAgentMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "complete", thinkingSignature: "sig" },
        { type: "text", text: { bad: true } },
      ],
    });

    expect(assessLastAssistantMessage(message)).toBe("incomplete-text");
  });
});

describe("wrapAnthropicStreamWithRecovery", () => {
  const anthropicThinkingError = new Error(
    "thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
  );

  it("retries once with omitted-reasoning text when the request is rejected before streaming", async () => {
    let callCount = 0;
    const contexts: Array<{ messages?: AgentMessage[] }> = [];
    const wrapped = wrapAnthropicStreamWithRecovery(
      ((_model, context) => {
        callCount += 1;
        contexts.push(context as { messages?: AgentMessage[] });
        return Promise.reject(anthropicThinkingError);
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    await expect(
      wrapped(
        {} as never,
        {
          messages: castAgentMessages([
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: "secret", thinkingSignature: "sig" }],
            },
          ]),
        } as never,
        {} as never,
      ),
    ).rejects.toBe(anthropicThinkingError);
    expect(callCount).toBe(2);
    expect(contexts[1]?.messages?.[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }],
    });
  });

  it("retries with visible assistant text when stripping thinking leaves content", async () => {
    const contexts: Array<{ messages?: AgentMessage[] }> = [];
    const wrapped = wrapAnthropicStreamWithRecovery(
      ((_model, context) => {
        contexts.push(context as { messages?: AgentMessage[] });
        return Promise.reject(anthropicThinkingError);
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    await expect(
      wrapped(
        {} as never,
        {
          messages: castAgentMessages([
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "secret", thinkingSignature: "sig" },
                { type: "text", text: "visible answer" },
              ],
            },
          ]),
        } as never,
        {} as never,
      ),
    ).rejects.toBe(anthropicThinkingError);

    expect(contexts[1]?.messages?.[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
    });
  });

  it("does not retry when the stream fails after yielding a chunk", async () => {
    let callCount = 0;
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return (async function* failingStream() {
          yield "chunk";
          throw anthropicThinkingError;
        })();
      }) as unknown as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    const chunks: unknown[] = [];
    const response = wrapped({} as never, { messages: [] } as never, {} as never) as {
      result: () => Promise<unknown>;
    } & AsyncIterable<unknown>;
    for await (const chunk of response) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["chunk"]);
    await expect(response.result()).rejects.toBe(anthropicThinkingError);
    expect(callCount).toBe(1);
  });

  it("does not retry non-Anthropic-thinking errors", async () => {
    const rateLimitError = new Error("rate limit exceeded");
    let callCount = 0;
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return Promise.reject(rateLimitError);
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    await expect(wrapped({} as never, { messages: [] } as never, {} as never)).rejects.toBe(
      rateLimitError,
    );
    expect(callCount).toBe(1);
  });

  it("preserves result() for synchronous event streams", async () => {
    const finalMessage = castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    }) as AssistantMessage;

    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: finalMessage });
          stream.push({ type: "done", reason: "stop", message: finalMessage });
          stream.end();
        });
        return stream;
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    const response = wrapped({} as never, { messages: [] } as never, {} as never) as {
      result: () => Promise<unknown>;
    } & AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const event of response) {
      events.push(event);
    }

    await expect(response.result()).resolves.toEqual(finalMessage);
    expect(events).toHaveLength(2);
  });
});
