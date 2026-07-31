// Thinking sanitization tests cover reasoning-block retention, stripping, and
// recovery behavior for provider transcripts and active assistant turns.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { castAgentMessage, castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import {
  assessLastAssistantMessage,
  dropReasoningFromHistory,
  dropThinkingBlocks,
  stripInvalidThinkingSignatures,
  stripStaleThinkingSignaturesForCompactionReplay,
  wrapAnthropicStreamWithRecovery,
} from "./thinking.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function dropSingleAssistantContent(content: Array<Record<string, unknown>>) {
  // Single-assistant fixture exercises the "latest assistant turn" path where
  // reasoning blocks should remain available for continuation.
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

const noThinkingReferenceCases = [
  { name: "dropThinkingBlocks", drop: dropThinkingBlocks },
  { name: "dropReasoningFromHistory", drop: dropReasoningFromHistory },
];

function createNoThinkingMessages(): AgentMessage[] {
  // No-thinking fixtures should keep reference identity to avoid unnecessary
  // transcript rewrites in the common path.
  return [
    castAgentMessage({ role: "user", content: "hello" }),
    castAgentMessage({ role: "assistant", content: [{ type: "text", text: "world" }] }),
  ];
}

describe("thinking-free history contract", () => {
  it.each(noThinkingReferenceCases)(
    "$name returns the original reference when no thinking blocks are present",
    ({ drop }) => {
      const messages = createNoThinkingMessages();

      const result = drop(messages);
      expect(result).toBe(messages);
    },
  );
});

describe("dropThinkingBlocks", () => {
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

describe("dropReasoningFromHistory", () => {
  it("strips assistant reasoning from prior completed turns", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "first" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "visible" },
        ],
      }),
      castAgentMessage({ role: "user", content: "second" }),
    ];

    const result = dropReasoningFromHistory(messages);
    const assistant = result[1] as AssistantMessage;

    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([{ type: "text", text: "visible" }]);
  });

  it("uses omitted-reasoning text when a completed assistant turn is reasoning-only", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "first" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "private" }],
      }),
      castAgentMessage({ role: "user", content: "second" }),
    ];

    const result = dropReasoningFromHistory(messages);
    const assistant = result[1] as AssistantMessage;

    expect(assistant.content).toEqual([{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }]);
  });

  it("preserves reasoning for the active tool-call continuation after the latest user turn", () => {
    // Active tool-call turns may need reasoning signatures for provider
    // continuation, so only completed prior turns are stripped.
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "look up the answer" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "call the tool" },
          { type: "toolCall", id: "call123456", name: "lookup", arguments: {} },
        ],
      }),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call123456",
        toolName: "lookup",
        content: "42",
      }),
    ];

    const result = dropReasoningFromHistory(messages);

    expect(result).toBe(messages);
  });

  it("strips reasoning from old tool-call turns once a later user turn starts", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "look up the answer" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "call the tool" },
          { type: "toolCall", id: "call123456", name: "lookup", arguments: {} },
        ],
      }),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call123456",
        toolName: "lookup",
        content: "42",
      }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "42" }] }),
      castAgentMessage({ role: "user", content: "thanks" }),
    ];

    const result = dropReasoningFromHistory(messages);
    const assistant = result[1] as AssistantMessage;

    expect(assistant.content).toEqual([
      { type: "toolCall", id: "call123456", name: "lookup", arguments: {} },
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

  it("preserves invalid thinking signatures on the latest assistant message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
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
    const assistant = result[1] as Extract<AgentMessage, { role: "assistant" }>;

    expect(result).toBe(messages);
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "missing" },
      { type: "thinking", thinking: "empty", thinkingSignature: "" },
      { type: "thinking", thinking: "blank", thinkingSignature: "   " },
      { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
      { type: "text", text: "answer" },
    ]);
  });

  it("can strip invalid thinking signatures from the latest assistant message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "missing" },
          { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripInvalidThinkingSignatures(messages, { preserveLatestAssistant: false });
    const assistant = result[1] as Extract<AgentMessage, { role: "assistant" }>;

    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
      { type: "text", text: "answer" },
    ]);
  });

  it("strips thinking blocks with missing, empty, or blank signatures from older assistant messages", () => {
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
      castAgentMessage({ role: "user", content: "follow up" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "latest" }] }),
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
      castAgentMessage({ role: "user", content: "follow up" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "latest" }] }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;

    expect(assistant.content).toEqual([{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }]);
  });

  it("strips redacted thinking blocks with invalid opaque signatures from older assistant messages", () => {
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
      castAgentMessage({ role: "user", content: "follow up" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "latest" }] }),
    ];

    const result = stripInvalidThinkingSignatures(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;

    expect(assistant.content).toEqual([
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "answer" },
    ]);
  });
});

describe("assessLastAssistantMessage", () => {
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
  const genericizedProviderError =
    "LLM request failed: provider rejected the request schema or tool payload.";
  const terminalThinkingSignatureError =
    "ValidationException: invalid signature on thinking block in message history";

  function createTestAssistantMessage(
    overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "content" | "stopReason">,
  ): AssistantMessage {
    return castAgentMessage({
      role: "assistant",
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
      timestamp: 0,
      ...overrides,
    }) as AssistantMessage;
  }

  function createTestStreamErrorMessage(errorMessage: string): AssistantMessage {
    return createTestAssistantMessage({
      content: [{ type: "text", text: "stream failed" }],
      stopReason: "error",
      errorMessage,
    });
  }

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
    const retryMessage = contexts[1]?.messages?.[0];
    if (!retryMessage || retryMessage.role !== "assistant") {
      throw new Error("Expected Anthropic recovery retry to start with an assistant message");
    }
    expect(retryMessage.content).toEqual([
      { type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT },
    ]);
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

    const retryMessage = contexts[1]?.messages?.[0];
    if (!retryMessage || retryMessage.role !== "assistant") {
      throw new Error("Expected Anthropic recovery retry to start with an assistant message");
    }
    expect(retryMessage.content).toEqual([{ type: "text", text: "visible answer" }]);
  });

  it("notifies recovery only after a rejected request retry succeeds", async () => {
    let callCount = 0;
    const recovered = vi.fn();
    const finalMessage = createTestAssistantMessage({
      content: [{ type: "text", text: "recovered" }],
      stopReason: "stop",
    });
    const originalMessages = castAgentMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret", thinkingSignature: "sig" },
          { type: "text", text: "visible answer" },
        ],
      },
    ]);
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.reject(anthropicThinkingError);
        }
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "done", reason: "stop", message: finalMessage });
          stream.end();
        });
        return stream;
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session", onRecoveredAnthropicThinking: recovered },
    );

    const response = (await wrapped(
      {} as never,
      {
        messages: originalMessages,
      } as never,
      {} as never,
    )) as { result: () => Promise<unknown> } & AsyncIterable<unknown>;
    for await (const event of response) {
      void event;
      // Drain the retry stream before reading result().
    }

    await expect(response.result()).resolves.toEqual(finalMessage);
    expect(callCount).toBe(2);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveBeenCalledWith({
      originalMessages,
      cleanedMessages: [
        {
          ...originalMessages[0],
          content: [{ type: "text", text: "visible answer" }],
        },
      ],
    });
  });

  it("does not notify recovery when the stripped-thinking retry also fails", async () => {
    const recovered = vi.fn();
    let callCount = 0;
    const retryError = new Error("retry failed");
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return Promise.reject(callCount === 1 ? anthropicThinkingError : retryError);
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session", onRecoveredAnthropicThinking: recovered },
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
    ).rejects.toBe(retryError);
    expect(recovered).not.toHaveBeenCalled();
  });

  it("does not notify recovery when the stripped-thinking retry resolves to a stream error", async () => {
    const recovered = vi.fn();
    let callCount = 0;
    const errorMessage = createTestStreamErrorMessage("retry stream failed");
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.reject(anthropicThinkingError);
        }
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({
            type: "error",
            reason: "error",
            error: errorMessage,
          });
          stream.end();
        });
        return stream;
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session", onRecoveredAnthropicThinking: recovered },
    );

    const response = (await wrapped(
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
    )) as { result: () => Promise<unknown> } & AsyncIterable<unknown>;
    for await (const event of response) {
      void event;
      // Drain the retry stream before reading result().
    }

    await expect(response.result()).resolves.toEqual(errorMessage);
    expect(callCount).toBe(2);
    expect(recovered).not.toHaveBeenCalled();
  });

  it("retries Bedrock-style invalid thinking signature errors", async () => {
    let callCount = 0;
    const bedrockThinkingError = new Error(
      "ValidationException: invalid signature on thinking block in message history",
    );
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return Promise.reject(bedrockThinkingError);
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
              content: [{ type: "thinking", thinking: "secret", thinkingSignature: "" }],
            },
          ]),
        } as never,
        {} as never,
      ),
    ).rejects.toBe(bedrockThinkingError);
    expect(callCount).toBe(2);
  });

  it.each([
    {
      name: "failover rawError",
      createError: () =>
        Object.assign(new Error(genericizedProviderError), {
          rawError: terminalThinkingSignatureError,
        }),
    },
    {
      name: "Anthropic SDK error body",
      createError: () =>
        Object.assign(new Error(genericizedProviderError), {
          error: { error: { message: terminalThinkingSignatureError } },
        }),
    },
    {
      name: "direct errorMessage",
      createError: () =>
        Object.assign(new Error(genericizedProviderError), {
          errorMessage: terminalThinkingSignatureError,
        }),
    },
    {
      name: "ProviderHttpError errorBody",
      createError: () =>
        Object.assign(new Error(genericizedProviderError), {
          errorBody: JSON.stringify({
            error: {
              message: terminalThinkingSignatureError,
              type: "invalid_request_error",
            },
          }),
        }),
    },
    {
      name: "cyclic cause graph",
      createError: () => {
        const root = new Error(genericizedProviderError) as Error & { cause?: unknown };
        const nested = { cause: root, message: terminalThinkingSignatureError };
        root.cause = nested;
        return root;
      },
    },
  ])(
    "retries genericized request errors carrying provider detail in $name",
    async ({ createError }) => {
      const providerError = createError();
      let callCount = 0;
      const wrapped = wrapAnthropicStreamWithRecovery(
        (() => {
          callCount += 1;
          return Promise.reject(providerError);
        }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
        { id: "test-session" },
      );

      await expect(wrapped({} as never, { messages: [] } as never, {} as never)).rejects.toBe(
        providerError,
      );
      expect(callCount).toBe(2);
    },
  );

  it("retries pre-content terminal stream-error events with omitted-reasoning text", async () => {
    let callCount = 0;
    const contexts: Array<{ messages?: AgentMessage[] }> = [];
    const finalMessage = createTestAssistantMessage({
      content: [{ type: "text", text: "recovered" }],
      stopReason: "stop",
    });
    const wrapped = wrapAnthropicStreamWithRecovery(
      ((_model, context) => {
        callCount += 1;
        const attempt = callCount;
        contexts.push(context as { messages?: AgentMessage[] });
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (attempt === 1) {
            stream.push({
              type: "error",
              reason: "error",
              error: createTestStreamErrorMessage(terminalThinkingSignatureError),
            });
          } else {
            stream.push({ type: "done", reason: "stop", message: finalMessage });
          }
          stream.end();
        });
        return stream;
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );

    const response = wrapped(
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
    ) as { result: () => Promise<unknown> } & AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const event of response) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "done", reason: "stop", message: finalMessage }]);
    await expect(response.result()).resolves.toEqual(finalMessage);
    expect(callCount).toBe(2);
    const retryMessage = contexts[1]?.messages?.[0];
    if (!retryMessage || retryMessage.role !== "assistant") {
      throw new Error("Expected Anthropic recovery retry to start with an assistant message");
    }
    expect(retryMessage.content).toEqual([
      { type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT },
    ]);
  });

  it("does not retry non-thinking terminal stream-error events", async () => {
    let callCount = 0;
    const errorMessage = createTestAssistantMessage({
      content: [{ type: "text", text: terminalThinkingSignatureError }],
      stopReason: "error",
      errorMessage: "rate limit exceeded",
    });
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "error", reason: "error", error: errorMessage });
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

    expect(events).toEqual([{ type: "error", reason: "error", error: errorMessage }]);
    await expect(response.result()).resolves.toEqual(errorMessage);
    expect(callCount).toBe(1);
  });

  it("does not retry terminal stream-error events after output was yielded", async () => {
    let callCount = 0;
    const partialMessage = createTestAssistantMessage({
      content: [{ type: "text", text: "" }],
      stopReason: "stop",
    });
    const errorMessage = createTestStreamErrorMessage(terminalThinkingSignatureError);
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: partialMessage });
          stream.push({ type: "error", reason: "error", error: errorMessage });
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

    expect(events).toEqual([
      { type: "start", partial: partialMessage },
      { type: "error", reason: "error", error: errorMessage },
    ]);
    await expect(response.result()).resolves.toEqual(errorMessage);
    expect(callCount).toBe(1);
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

  it("allows each provider call to recover once", async () => {
    let callCount = 0;
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        callCount += 1;
        return Promise.reject(anthropicThinkingError);
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session" },
    );
    const context = {
      messages: castAgentMessages([
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "secret", thinkingSignature: "sig" }],
        },
      ]),
    };

    await expect(wrapped({} as never, context as never, {} as never)).rejects.toBe(
      anthropicThinkingError,
    );
    await expect(wrapped({} as never, context as never, {} as never)).rejects.toBe(
      anthropicThinkingError,
    );

    expect(callCount).toBe(4);
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

  it("recovers an error event from a Promise-resolved stream without changing Promise timing", async () => {
    const recovered = vi.fn();
    let callCount = 0;
    let resolveFirstStream!: (stream: ReturnType<typeof createAssistantMessageEventStream>) => void;
    const firstStreamPromise = new Promise<ReturnType<typeof createAssistantMessageEventStream>>(
      (resolve) => {
        resolveFirstStream = resolve;
      },
    );
    const finalMessage = createTestAssistantMessage({
      content: [{ type: "text", text: "recovered answer" }],
      stopReason: "stop",
    });
    const wrapped = wrapAnthropicStreamWithRecovery(
      (() => {
        const attempt = ++callCount;
        if (attempt === 1) {
          return firstStreamPromise;
        }
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "done", reason: "stop", message: finalMessage });
          stream.end();
        });
        return stream;
      }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
      { id: "test-session", onRecoveredAnthropicThinking: recovered },
    );

    const responsePromise = wrapped({} as never, { messages: [] } as never, {} as never);
    expect(responsePromise).toBeInstanceOf(Promise);
    let resolved = false;
    void Promise.resolve(responsePromise).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    const firstStream = createAssistantMessageEventStream();
    resolveFirstStream(firstStream);
    const response = await responsePromise;
    queueMicrotask(() => {
      firstStream.push({
        type: "error",
        reason: "error",
        error: createTestStreamErrorMessage(terminalThinkingSignatureError),
      });
      firstStream.end();
    });
    for await (const event of response) {
      void event;
    }

    await expect(response.result()).resolves.toEqual(finalMessage);
    expect(callCount).toBe(2);
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});

describe("stripStaleThinkingSignaturesForCompactionReplay", () => {
  it("returns the original reference when no compaction summary is present", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "think", thinkingSignature: "sig" }],
        timestamp: 1000,
      }),
    ];
    expect(stripStaleThinkingSignaturesForCompactionReplay(messages)).toBe(messages);
  });

  it("strips thinking signatures from assistant messages at or before the compaction timestamp", () => {
    const compactionSummary = castAgentMessage({
      role: "compactionSummary",
      summary: "summary",
      tokensBefore: 100,
      timestamp: 2000,
    });
    const preCompaction = castAgentMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "old think", thinkingSignature: "stale_sig" },
        { type: "text", text: "old answer" },
      ],
      timestamp: 1000,
    });
    const postCompaction = castAgentMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "new think", thinkingSignature: "fresh_sig" },
        { type: "text", text: "new answer" },
      ],
      timestamp: 3000,
    });
    const messages: AgentMessage[] = [
      compactionSummary,
      preCompaction,
      castAgentMessage({ role: "user", content: "q" }),
      postCompaction,
    ];

    const result = stripStaleThinkingSignaturesForCompactionReplay(messages);
    expect(result).not.toBe(messages);

    const pre = result[1] as AssistantMessage;
    expect(pre.content).toEqual([
      { type: "thinking", thinking: "old think" },
      { type: "text", text: "old answer" },
    ]);

    const post = result[3] as AssistantMessage;
    expect(post.content).toEqual([
      { type: "thinking", thinking: "new think", thinkingSignature: "fresh_sig" },
      { type: "text", text: "new answer" },
    ]);
  });

  it("strips thinkingSignature from a thinking-only pre-compaction message, leaving text for downstream handling", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "compactionSummary",
        summary: "s",
        tokensBefore: 0,
        timestamp: 2000,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "hidden", thinkingSignature: "sig" }],
        timestamp: 1000,
      }),
    ];
    const result = stripStaleThinkingSignaturesForCompactionReplay(messages);
    const assistant = result[1] as AssistantMessage;
    // Signature is stripped; thinking text is preserved. Downstream stripInvalidThinkingSignatures
    // converts this unsigned thinking-only message to [assistant reasoning omitted].
    expect(assistant.content).toEqual([{ type: "thinking", thinking: "hidden" }]);
  });

  it("strips redacted_thinking data from pre-compaction messages", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "compactionSummary",
        summary: "s",
        tokensBefore: 0,
        timestamp: 2000,
      }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "opaque_sig" },
          { type: "text", text: "visible" },
        ],
        timestamp: 1500,
      }),
    ];
    const result = stripStaleThinkingSignaturesForCompactionReplay(messages);
    const assistant = result[1] as AssistantMessage;
    expect(assistant.content).toEqual([
      { type: "redacted_thinking" },
      { type: "text", text: "visible" },
    ]);
  });

  it("skips assistant messages with no parseable timestamp", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "compactionSummary",
        summary: "s",
        tokensBefore: 0,
        timestamp: 2000,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "think", thinkingSignature: "sig" }],
      }),
    ];
    const result = stripStaleThinkingSignaturesForCompactionReplay(messages);
    expect(result).toBe(messages);
  });

  it("uses the latest compaction summary timestamp when multiple summaries are present", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "compactionSummary",
        summary: "first",
        tokensBefore: 0,
        timestamp: 1000,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "mid", thinkingSignature: "sig_mid" }],
        timestamp: 1500,
      }),
      castAgentMessage({
        role: "compactionSummary",
        summary: "second",
        tokensBefore: 0,
        timestamp: 2000,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "after", thinkingSignature: "sig_after" }],
        timestamp: 3000,
      }),
    ];
    const result = stripStaleThinkingSignaturesForCompactionReplay(messages);
    // mid (timestamp 1500 < 2000): signature stripped
    const mid = result[1] as AssistantMessage;
    expect(mid.content).toEqual([{ type: "thinking", thinking: "mid" }]);
    // after (timestamp 3000 > 2000): signature kept
    const after = result[3] as AssistantMessage;
    expect((after.content[0] as unknown as Record<string, unknown>).thinkingSignature).toBe(
      "sig_after",
    );
  });

  it("uses max compaction timestamp when summaries appear out of chronological order", () => {
    // Two compaction summaries: ts=1500 appears first, ts=2000 appears later.
    // latestCompactionTimestamp must be max(1500, 2000) = 2000, not 1500.
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "compactionSummary",
        summary: "earlier-in-array lower-timestamp",
        tokensBefore: 0,
        timestamp: 1500,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "t1", thinkingSignature: "sig1" }],
        timestamp: 1200,
      }),
      castAgentMessage({
        role: "compactionSummary",
        summary: "later-in-array higher-timestamp",
        tokensBefore: 0,
        timestamp: 2000,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "t2", thinkingSignature: "sig2" }],
        timestamp: 1800,
      }),
    ];
    const result = stripStaleThinkingSignaturesForCompactionReplay(messages);
    // Both messages have ts < 2000 so both should be stripped
    const a1 = result[1] as AssistantMessage;
    const a2 = result[3] as AssistantMessage;
    expect((a1.content[0] as unknown as Record<string, unknown>).thinkingSignature).toBeUndefined();
    expect((a2.content[0] as unknown as Record<string, unknown>).thinkingSignature).toBeUndefined();
  });

  it("preserves signatures on assistant messages at exactly the compaction timestamp", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "compactionSummary",
        summary: "s",
        tokensBefore: 0,
        timestamp: 2000,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "exact", thinkingSignature: "exact_sig" }],
        timestamp: 2000,
      }),
    ];
    const result = stripStaleThinkingSignaturesForCompactionReplay(messages);
    // Same millisecond as compaction: treated as post-compaction; signature preserved
    expect(result).toBe(messages);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
