// Coverage for sanitizing replay messages at the LLM boundary.
import { describe, expect, it } from "vitest";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import {
  installModelPromptTransform,
  insertRuntimeContextMessageForPrompt,
  normalizeCurrentPromptTextForLlmBoundary,
  normalizeMessagesForLlmBoundary,
} from "./attempt.llm-boundary.js";

describe("normalizeMessagesForLlmBoundary", () => {
  it("strips inbound metadata from historical user turns before model replay", () => {
    // Historical envelopes contain untrusted routing metadata that should not be
    // replayed as user instructions.
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
    ) as unknown as Array<{ content?: unknown }>;

    // Historical single-text-block messages are form-canonicalized to a plain
    // string after metadata stripping (cache-bust fix — issue #3658).
    expect(output[0]?.content).toBe("Actual historical ask");
    // Current turn: single-text-block array collapsed to plain string; metadata
    // blocks preserved for the LLM.
    const currentContent = output[2]?.content;
    expect(typeof currentContent).toBe("string");
    expect(currentContent).toContain(
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

  it("stamps every user message from its OWN timestamp when a timezone is supplied (single-source cache-bust fix)", () => {
    // Single-source design (issue #3658): storage is BARE. The boundary is the
    // ONLY stamping site and derives the prefix from each message's own
    // `timestamp` using the supplied timezone — so the same message is
    // byte-identical whether sent current or replayed historical.
    const historicalBareWithMeta =
      'Conversation info (untrusted metadata):\n```json\n{"channel":"telegram"}\n```\n\nOld ask';
    const input = [
      {
        role: "user",
        content: historicalBareWithMeta,
        timestamp: 1717570800000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Historical answer" }],
        timestamp: 2,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Current ask" }],
        timestamp: 1717570860000,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
      { timezone: "UTC" },
    ) as unknown as Array<{ content?: string }>;

    // Historical: inbound metadata stripped, then stamped from its OWN timestamp.
    const expectedHistoricalPrefix = buildTimestampPrefix(new Date(1717570800000), {
      timezone: "UTC",
    });
    expect(output[0]?.content).toBe(`${expectedHistoricalPrefix}Old ask`);
    // Current: stamped from its own (different) timestamp.
    const expectedCurrentPrefix = buildTimestampPrefix(new Date(1717570860000), {
      timezone: "UTC",
    });
    expect(output[2]?.content).toBe(`${expectedCurrentPrefix}Current ask`);
  });

  it("stamps the current turn from the prepared persisted timestamp when supplied", () => {
    const preparedTimestamp = 1717570800000;
    const runtimeTimestamp = 1717574460000;
    const input = [
      {
        role: "user",
        content: [{ type: "text", text: "Current ask" }],
        timestamp: runtimeTimestamp,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
      {
        timezone: "UTC",
        currentUserTimestampOverride: {
          timestamp: preparedTimestamp,
          text: "Current ask",
        },
      },
    ) as unknown as Array<{ content?: string }>;

    const expectedPrefix = buildTimestampPrefix(new Date(preparedTimestamp), {
      timezone: "UTC",
    });
    expect(output[0]?.content).toBe(`${expectedPrefix}Current ask`);
  });

  it("normalizes current prompt text for pre-prompt token pressure", () => {
    const preparedTimestamp = 1717570800000;
    const output = normalizeCurrentPromptTextForLlmBoundary({
      prompt: "Current ask",
      timezone: "UTC",
      currentUserTimestamp: preparedTimestamp,
    });
    const expectedPrefix = buildTimestampPrefix(new Date(preparedTimestamp), {
      timezone: "UTC",
    });
    expect(output).toBe(`${expectedPrefix}Current ask`);
  });

  it("does not apply the prepared timestamp override to later queued turns", () => {
    const preparedTimestamp = 1717570800000;
    const queuedTimestamp = 1717574460000;
    const input = [
      {
        role: "user",
        content: [{ type: "text", text: "queued ask" }],
        timestamp: queuedTimestamp,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
      {
        timezone: "UTC",
        currentUserTimestampOverride: {
          timestamp: preparedTimestamp,
          text: "initial ask",
        },
      },
    ) as unknown as Array<{ content?: string }>;

    const expectedPrefix = buildTimestampPrefix(new Date(queuedTimestamp), {
      timezone: "UTC",
    });
    expect(output[0]?.content).toBe(`${expectedPrefix}queued ask`);
  });

  it("does not apply the prepared timestamp override to repeated queued text", () => {
    const preparedTimestamp = 1717570800000;
    const firstRuntimeTimestamp = 1717570805000;
    const queuedTimestamp = 1717574460000;
    const options = {
      timezone: "UTC",
      currentUserTimestampOverride: {
        timestamp: preparedTimestamp,
        text: "same ask",
      },
    };
    const firstOutput = normalizeMessagesForLlmBoundary(
      [
        {
          role: "user",
          content: [{ type: "text", text: "same ask" }],
          timestamp: firstRuntimeTimestamp,
        },
      ] as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
      options,
    ) as unknown as Array<{ content?: string }>;
    const queuedOutput = normalizeMessagesForLlmBoundary(
      [
        {
          role: "user",
          content: [{ type: "text", text: "same ask" }],
          timestamp: queuedTimestamp,
        },
      ] as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
      options,
    ) as unknown as Array<{ content?: string }>;

    const preparedPrefix = buildTimestampPrefix(new Date(preparedTimestamp), {
      timezone: "UTC",
    });
    const queuedPrefix = buildTimestampPrefix(new Date(queuedTimestamp), {
      timezone: "UTC",
    });
    expect(firstOutput[0]?.content).toBe(`${preparedPrefix}same ask`);
    expect(queuedOutput[0]?.content).toBe(`${queuedPrefix}same ask`);
  });

  it("does not stamp when no timezone is supplied (form/metadata normalization only)", () => {
    const input = [
      {
        role: "user",
        content: [{ type: "text", text: "bare ask" }],
        timestamp: 1717570800000,
      },
    ];
    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<{ content?: string }>;
    expect(output[0]?.content).toBe("bare ask");
  });

  it("keeps inter-session provenance headers before timestamp context", () => {
    const input = [
      {
        role: "user",
        content: "[Inter-session message] sourceTool=sessions_send isUser=false\nforwarded ask",
        timestamp: 1717570800000,
      },
    ];
    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
      { timezone: "UTC" },
    ) as unknown as Array<{ content?: string }>;

    expect(output[0]?.content).toBe(
      "[Inter-session message] sourceTool=sessions_send isUser=false\nforwarded ask",
    );
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
    ) as unknown as Array<{ content?: unknown }>;

    // Historical: form-canonicalized to plain string after metadata strip.
    expect(output[0]?.content).toBe("Old ask");
    // Current: form-canonicalized to plain string; metadata blocks preserved.
    const currentContent = output[2]?.content;
    expect(typeof currentContent).toBe("string");
    expect(currentContent).toContain(
      "Reply target of current user message (untrusted, for context):",
    );
    expect(currentContent).toContain("quoted status body");
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
    ) as unknown as Array<{ content?: unknown }>;

    // Current turn (only user message): form-canonicalized to plain string;
    // metadata blocks preserved for the LLM.
    const currentContent = output[0]?.content;
    expect(typeof currentContent).toBe("string");
    expect(currentContent).toContain(
      "Reply target of current user message (untrusted, for context):",
    );
    expect(currentContent).toContain("quoted status body");
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

  it("collapses single-text-block user content arrays to plain strings", () => {
    // Both current and historical single-text-block user messages must
    // serialize identically — this is the form-canonicalization half of the
    // cache-bust fix (issue #3658).
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
        role: "user",
        content: [{ type: "text", text: "current ask" }],
        timestamp: 2,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<{ content?: unknown }>;

    expect(output[0]?.content).toBe("old ask");
    expect(output[2]?.content).toBe("current ask");
  });

  it("preserves multi-block (attachment) user content as arrays", () => {
    // Turns with image or document blocks must NOT be collapsed to a string.
    const input = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } },
        ],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "nice" }],
        timestamp: 1,
      },
      {
        role: "user",
        content: [{ type: "text", text: "current ask" }],
        timestamp: 2,
      },
    ];

    const output = normalizeMessagesForLlmBoundary(
      input as Parameters<typeof normalizeMessagesForLlmBoundary>[0],
    ) as unknown as Array<{ content?: unknown }>;

    // Multi-block historical stays as array.
    expect(Array.isArray(output[0]?.content)).toBe(true);
    // Single-block current collapses to string.
    expect(output[2]?.content).toBe("current ask");
  });

  it("keeps only pre-user current-turn runtime context at the LLM boundary", () => {
    // Runtime context belongs immediately before the active user turn; stale
    // context after that turn should not leak into provider replay.
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
    // User messages (both historical and current) are form-canonicalized.
    expect(output.some((item) => item.role === "user" && item.content === "old ask")).toBe(true);
    expect(output.some((item) => item.role === "user" && item.content === "visible ask")).toBe(
      true,
    );
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
    // User messages are form-canonicalized from array to plain string.
    expect(retryInput[0]?.content).toBe("old ask");
    expect(retryInput[3]?.content).toBe("retry ask");
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
    // User messages are form-canonicalized from array to plain string.
    expect(modelInput[0]?.content).toBe("old ask");
    expect(modelInput[3]?.content).toBe("visible ask");
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

    // Single-text-block user message is form-canonicalized to a plain string.
    expect(output[0]?.content).toBe(
      "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
    );
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
