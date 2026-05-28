import { describe, expect, it } from "vitest";
import {
  installModelPromptTransform,
  insertRuntimeContextMessageForPrompt,
  normalizeMessagesForLlmBoundary,
} from "./attempt.llm-boundary.js";

describe("normalizeMessagesForLlmBoundary", () => {
  it("strips inbound metadata from historical user turns before model replay", () => {
    const historicalEnvelope =
      'Conversation info (untrusted metadata):\n```json\n{"channel":"telegram","chatType":"dm"}\n```\n\nSender (untrusted metadata):\n```json\n{"id":"user-1"}\n```\n\nActual historical ask';
    const currentEnvelope =
      'Conversation info (untrusted metadata):\n```json\n{"channel":"discord","has_reply_context":true}\n```\n\nReply target of current user message (untrusted, for context):\n```json\n{"body":"quoted status body"}\n```\n\nCurrent ask';
    const input = [
      {
        role: "user",
        content: [{ type: "text", text: historicalEnvelope }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Historical answer" }],
        timestamp: 2,
      },
      {
        role: "user",
        content: [{ type: "text", text: currentEnvelope }],
        timestamp: 3,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<{ content?: Array<{ text?: string }> }>;

    expect(output[0]?.content?.[0]?.text).toBe("Actual historical ask");
    expect(output[2]?.content?.[0]?.text).toContain(
      "Reply target of current user message (untrusted, for context):",
    );
    expect(JSON.stringify(input)).toContain("Conversation info");
  });

  it("strips inbound metadata from string historical user turns", () => {
    const input = [
      {
        role: "user",
        content:
          'Conversation info (untrusted metadata):\n```json\n{"channel":"telegram"}\n```\n\nPlain historical ask',
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Historical answer" }],
        timestamp: 2,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<{ content?: string }>;

    expect(output[0]?.content).toBe("Plain historical ask");
  });

  it("preserves inbound metadata on the current user turn", () => {
    const historicalEnvelope =
      'Conversation info (untrusted metadata):\n```json\n{"channel":"discord"}\n```\n\nOld ask';
    const currentEnvelope =
      'Conversation info (untrusted metadata):\n```json\n{"channel":"discord","has_reply_context":true}\n```\n\nReply target of current user message (untrusted, for context):\n```json\n{"body":"quoted status body"}\n```\n\nCurrent ask';
    const input = [
      {
        role: "user",
        content: [{ type: "text", text: historicalEnvelope }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Historical answer" }],
        timestamp: 2,
      },
      {
        role: "user",
        content: [{ type: "text", text: currentEnvelope }],
        timestamp: 3,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<{ content?: Array<{ text?: string }> }>;

    expect(output[0]?.content?.[0]?.text).toBe("Old ask");
    expect(output[2]?.content?.[0]?.text).toContain(
      "Reply target of current user message (untrusted, for context):",
    );
    expect(output[2]?.content?.[0]?.text).toContain("quoted status body");
  });

  it("preserves current user inbound metadata through tool-result continuation", () => {
    const currentEnvelope =
      'Conversation info (untrusted metadata):\n```json\n{"channel":"discord","has_reply_context":true}\n```\n\nReply target of current user message (untrusted, for context):\n```json\n{"body":"quoted status body"}\n```\n\nCurrent ask';
    const input = [
      {
        role: "user",
        content: [{ type: "text", text: currentEnvelope }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "tool output" }],
        timestamp: 3,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<{ content?: Array<{ text?: string }> }>;

    expect(output[0]?.content?.[0]?.text).toContain(
      "Reply target of current user message (untrusted, for context):",
    );
    expect(output[0]?.content?.[0]?.text).toContain("quoted status body");
  });

  it("strips tool result details before provider conversion", () => {
    const input = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "visible output" }],
        details: { aggregated: "hidden diagnostics" },
        isError: false,
        timestamp: 1,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<Record<string, unknown>>;

    expect(output[0]).not.toHaveProperty("details");
    expect(output[0]?.content).toEqual([{ type: "text", text: "visible output" }]);
    expect(input[0]).toHaveProperty("details");
  });

  it("keeps only pre-user current-turn runtime context at the LLM boundary", () => {
    const input = [
      {
        role: "user",
        content: [{ type: "text", text: "old ask" }],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
        timestamp: 1,
      },
      {
        role: "custom",
        customType: "openclaw.runtime-context",
        content: "current secret runtime context",
        display: false,
        timestamp: 2,
      },
      {
        role: "user",
        content: [{ type: "text", text: "visible ask" }],
        timestamp: 3,
      },
      {
        role: "custom",
        customType: "openclaw.runtime-context",
        content: "post-user stale runtime context",
        display: false,
        timestamp: 4,
      },
      {
        role: "custom",
        customType: "other-extension-context",
        content: "normal custom context",
        display: false,
        timestamp: 5,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<Record<string, unknown>>;

    expect(output).toHaveLength(5);
    expect(output.some((item) => item.content === "current secret runtime context")).toBe(true);
    expect(output.some((item) => item.content === "post-user stale runtime context")).toBe(false);
    expect(output.some((item) => item.customType === "other-extension-context")).toBe(true);
  });

  it("keeps overflow retry runtime context immediately before the active user", () => {
    const rebuiltAfterOverflow = [
      {
        role: "user",
        content: [{ type: "text", text: "old ask" }],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
        timestamp: 1,
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry ask" }],
        timestamp: 2,
      },
    ];
    const runtimeContext = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "retry runtime context",
      display: false,
      timestamp: 3,
    };

    const retryMessages = insertRuntimeContextMessageForPrompt({
      message: runtimeContext as Parameters<
        typeof insertRuntimeContextMessageForPrompt
      >[0]["message"],
      messages: rebuiltAfterOverflow as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    });
    const retryInput = normalizeMessagesForLlmBoundary(retryMessages) as unknown as Array<
      Record<string, unknown>
    >;

    expect(retryInput.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "custom",
      "user",
    ]);
    expect(retryInput[2]).toMatchObject({
      customType: "openclaw.runtime-context",
      content: "retry runtime context",
    });
    expect(retryInput[3]?.content).toEqual([{ type: "text", text: "retry ask" }]);
  });

  it("keeps prompt-local runtime context before the active user in existing sessions", () => {
    const promptInput = [
      {
        role: "user",
        content: [{ type: "text", text: "old ask" }],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
        timestamp: 1,
      },
      {
        role: "custom",
        customType: "openclaw.runtime-context",
        content: "current runtime context",
        display: false,
        timestamp: 2,
      },
      {
        role: "user",
        content: [{ type: "text", text: "visible ask" }],
        timestamp: 3,
      },
    ];

    const modelInput = normalizeMessagesForLlmBoundary(
      promptInput as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<Record<string, unknown>>;

    expect(modelInput.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "custom",
      "user",
    ]);
    expect(modelInput[2]).toMatchObject({
      customType: "openclaw.runtime-context",
      content: "current runtime context",
    });
    expect(modelInput[3]?.content).toEqual([{ type: "text", text: "visible ask" }]);
  });

  it("keeps only safe blocked metadata at the LLM boundary", () => {
    const input = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
          },
        ],
        timestamp: 1,
        __openclaw: {
          beforeAgentRunBlocked: {
            blockedBy: "policy-plugin",
            blockedAt: 1,
            reason: "matched secret prompt",
            prompt: "secret prompt",
          },
        },
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<Record<string, unknown>>;

    expect(output[0]?.content).toEqual([
      {
        type: "text",
        text: "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
      },
    ]);
    expect(output[0]).toHaveProperty("__openclaw.beforeAgentRunBlocked");
    expect(output[0]).not.toHaveProperty("__openclaw.beforeAgentRunBlocked.reason");
    expect(JSON.stringify(output)).not.toContain("secret prompt");
    expect(JSON.stringify(output)).not.toContain("matched secret prompt");
    expect(input[0]).toHaveProperty("__openclaw");
  });

  it("replaces only the armed prompt with model prompt context", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "visible transcript prompt" }],
        timestamp: 1,
      },
    ] as Parameters<typeof normalizeMessagesForLlmBoundary>[0];
    const captured: (typeof messages)[] = [];
    const session = {
      agent: {
        transformContext: async (nextMessages: typeof messages) => {
          captured.push(nextMessages);
          return nextMessages;
        },
      },
    };
    let armed = false;
    const cleanup = installModelPromptTransform({
      session,
      transcriptPrompt: "visible transcript prompt",
      modelPrompt: "private model prompt",
      prependContext: "before",
      appendContext: "after",
      shouldCapturePrompt: () => armed,
    });

    const unarmed = await session.agent.transformContext(messages);
    armed = true;
    const armedResult = await session.agent.transformContext(messages);
    cleanup();
    const unarmedRecords = unarmed as Array<{ content?: unknown }>;
    const armedRecords = armedResult as Array<{ content?: unknown }>;

    expect(unarmedRecords[0]?.content).toEqual([
      { type: "text", text: "visible transcript prompt" },
    ]);
    expect(armedRecords[0]?.content).toEqual([{ type: "text", text: "private model prompt" }]);
    expect(armedResult[0]).toHaveProperty(
      "__openclawTranscriptPromptText",
      "visible transcript prompt",
    );
    expect(captured).toHaveLength(2);
    expect(session.agent.transformContext).not.toBeUndefined();
  });

  it("restores the original model prompt transform on cleanup", async () => {
    const originalTransform = async (
      messages: Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) => messages;
    const session = {
      agent: {
        transformContext: originalTransform,
      },
    };
    const cleanup = installModelPromptTransform({
      session,
      transcriptPrompt: "visible transcript prompt",
      prependContext: "before",
      shouldCapturePrompt: () => true,
    });

    expect(session.agent.transformContext).not.toBe(originalTransform);
    cleanup();

    expect(session.agent.transformContext).toBe(originalTransform);
  });
});
