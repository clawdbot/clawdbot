// Deferred reply regressions exercise the real subscription and delivery callbacks.
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { AssistantMessage } from "../llm/types.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function hasAssistantEvent(calls: Array<unknown[]>): boolean {
  // The gate buffers assistant stream events; tests use this helper to assert
  // nothing leaks before the terminal decision resolves.
  return calls.some((call) => {
    const event = call[0] as { stream?: string } | undefined;
    return event?.stream === "assistant";
  });
}

function hasLifecycleEndEvent(calls: Array<unknown[]>): boolean {
  return calls.some((call) => {
    const event = call[0] as { stream?: string; data?: { phase?: string } } | undefined;
    return event?.stream === "lifecycle" && event.data?.phase === "end";
  });
}

function emitAssistantMessage(
  emit: (event: unknown) => void,
  message: AssistantMessage,
  stream = true,
) {
  emit({ type: "message_start", message });
  if (stream) {
    for (const [contentIndex, block] of message.content.entries()) {
      if (block.type !== "text") {
        continue;
      }
      const partial = { ...message, content: message.content.slice(0, contentIndex + 1) };
      for (const update of [
        { type: "text_delta", delta: block.text },
        { type: "text_end", content: block.text },
      ]) {
        emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: { ...update, contentIndex, partial },
        });
      }
    }
  }
  emit({ type: "message_end", message });
}

describe("subscribeEmbeddedAgentSession deferred reply supersession", () => {
  it.each([
    { terminalText: "Completed answer.", priorStopReason: "toolUse" },
    { terminalText: "NO_REPLY", priorStopReason: "toolUse" },
    { terminalText: "Completed answer.", priorStopReason: "stop" },
    { terminalText: "NO_REPLY", priorStopReason: "stop" },
  ] as const)(
    "supersedes deferred $priorStopReason tool-turn answers with terminal $terminalText",
    async ({ terminalText, priorStopReason }) => {
      const onBlockReply = vi.fn();
      const onPartialReply = vi.fn();
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-before-terminal-supersession",
        onBlockReply,
        onPartialReply,
        onAgentEvent,
        onBeforeTerminalDelivery: async () => undefined,
        blockReplyBreak: "message_end",
      });
      const messages = [
        "Obsolete preflight answer.",
        "Obsolete follow-up answer.",
        terminalText,
      ].map((text, index) =>
        makeAgentAssistantMessage({
          content: [
            {
              type: "text",
              text,
              textSignature: JSON.stringify({ v: 1, id: `answer-${index}`, phase: "final_answer" }),
            },
            ...(index < 2
              ? [
                  {
                    type: "toolCall" as const,
                    id: `read-${index}`,
                    name: "read",
                    arguments: {},
                    async: true as const,
                  },
                ]
              : []),
          ],
          stopReason: index < 2 ? priorStopReason : "stop",
        }),
      );
      for (const [index, message] of messages.entries()) {
        emitAssistantMessage(emit, message);
        if (index < 2) {
          emit({
            type: "tool_execution_start",
            toolName: "read",
            toolCallId: `read-${index}`,
            args: {},
          });
          emit({
            type: "tool_execution_end",
            toolName: "read",
            toolCallId: `read-${index}`,
            isError: false,
            result: { content: [{ type: "text", text: "Successful result." }] },
          });
          emit({
            type: "turn_end",
            message,
            toolResults: [
              {
                role: "toolResult",
                toolCallId: `read-${index}`,
                toolName: "read",
                content: [{ type: "text", text: "Successful result." }],
                isError: false,
                timestamp: 0,
              },
            ],
          });
        }
        await subscription.waitForPendingEvents();
      }
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(onPartialReply).not.toHaveBeenCalled();
      expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);

      emit({ type: "agent_end", messages, willRetry: false });
      await subscription.waitForPendingEvents();

      const expected = terminalText === "NO_REPLY" ? [] : [terminalText];
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text).filter(Boolean)).toEqual(
        expected,
      );
      expect(onPartialReply.mock.calls.map(([payload]) => payload.text).filter(Boolean)).toEqual(
        expected,
      );
      expect(
        onAgentEvent.mock.calls
          .filter(([event]) => event.stream === "assistant")
          .map(([event]) => event.data.text)
          .filter(Boolean),
      ).toEqual(expected);
      expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(true);
      subscription.unsubscribe();
    },
  );

  it("retains completed answers to earlier user inputs in the same run", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-followups",
      onBlockReply,
      onBeforeTerminalDelivery: async () => undefined,
      blockReplyBreak: "message_end",
    });
    const messages = ["First completed answer.", "Second completed answer."].map((text) =>
      makeAgentAssistantMessage({ content: [{ type: "text", text }] }),
    );
    for (const message of messages) {
      emit({
        type: "message_start",
        message: { role: "user", content: "Next question", timestamp: 0 },
      });
      emitAssistantMessage(emit, message);
      emit({ type: "turn_end", message, toolResults: [] });
    }
    emit({ type: "agent_end", messages, willRetry: false });
    await subscription.waitForPendingEvents();
    expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
      "First completed answer.",
      "Second completed answer.",
    ]);
    subscription.unsubscribe();
  });

  it.each(["Completed answer.", "NO_REPLY"])(
    "preserves deferred media and reasoning, but not obsolete captions, before %j",
    async (terminalText) => {
      const onBlockReply = vi.fn();
      const onAgentEvent = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-before-terminal-media-supersession",
        onBlockReply,
        onAgentEvent,
        onBeforeTerminalDelivery: async () => undefined,
        blockReplyBreak: "text_end",
        reasoningMode: "on",
        internalEvents: [
          {
            type: "task_completion",
            source: "music_generation",
            childSessionKey: "music_generate:generated-track",
            announceType: "music generation task",
            taskLabel: "generated track",
            status: "ok",
            statusLabel: "completed successfully",
            result: "Generated a track.",
            mediaUrls: ["/tmp/generated.opus"],
            attachments: [
              { path: "/tmp/generated.opus", mimeType: "audio/ogg", name: "generated.opus" },
            ],
            replyInstruction: "Reply normally.",
          },
        ],
      });
      const mediaMessage = makeAgentAssistantMessage({
        content: [
          {
            type: "text",
            text: "Obsolete caption.\nMEDIA:/tmp/generated.opus",
            textSignature: JSON.stringify({ v: 1, id: "media", phase: "final_answer" }),
          },
        ],
        stopReason: "toolUse",
      });
      const commentary = makeAgentAssistantMessage({
        content: [
          { type: "thinking", thinking: "Checking the generated track." },
          {
            type: "text",
            text: "Checking current state.",
            textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
          },
        ],
        stopReason: "toolUse",
      });
      const final = makeAgentAssistantMessage({
        content: (terminalText === "NO_REPLY"
          ? [terminalText]
          : [terminalText, "Second answer block."]
        ).map((text, index) => ({
          type: "text",
          text,
          textSignature: JSON.stringify({ v: 1, id: `final-${index}`, phase: "final_answer" }),
        })),
      });
      for (const message of [mediaMessage, commentary, final]) {
        emitAssistantMessage(emit, message);
        await subscription.waitForPendingEvents();
      }
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);
      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: "item",
        data: expect.objectContaining({
          kind: "preamble",
          progressText: "Checking current state.",
        }),
      });
      emit({ type: "agent_end", messages: [mediaMessage, commentary, final], willRetry: false });
      await subscription.waitForPendingEvents();

      const payloads = onBlockReply.mock.calls.map(([payload]) => payload);
      const mediaPayloads = payloads.filter((payload) => payload.mediaUrls?.length);
      expect(mediaPayloads).toHaveLength(1);
      expect(mediaPayloads[0]).toMatchObject({
        mediaUrls: ["/tmp/generated.opus"],
        trustedLocalMedia: true,
        attachments: [
          {
            path: "/tmp/generated.opus",
            mimeType: "audio/ogg",
            name: "generated.opus",
            trustedLocalMedia: true,
          },
        ],
      });
      expect(mediaPayloads[0].text ?? "").toBe("");
      expect(getReplyPayloadMetadata(mediaPayloads[0])).toMatchObject({
        assistantTranscriptMediaUrls: ["/tmp/generated.opus"],
      });
      expect(
        payloads.filter((payload) => payload.isReasoning).map((payload) => payload.text),
      ).toEqual(["Checking the generated track."]);
      expect(
        payloads
          .filter((payload) => !payload.isReasoning)
          .map((payload) => payload.text)
          .filter(Boolean),
      ).toEqual(terminalText === "NO_REPLY" ? [] : [terminalText, "Second answer block."]);
      const assistantEvents = onAgentEvent.mock.calls.filter(
        ([event]) => event.stream === "assistant",
      );
      expect(assistantEvents.some(([event]) => event.data.text.includes("Obsolete"))).toBe(false);
      expect(
        assistantEvents
          .filter(([event]) => event.data.mediaUrls?.length)
          .map(([event]) => event.data),
      ).toEqual([expect.objectContaining({ text: "", mediaUrls: ["/tmp/generated.opus"] })]);
      expect(subscription.hasToolMediaBlockReply()).toBe(true);
      expect(subscription.getPendingToolMediaReply()).toBeNull();
      subscription.unsubscribe();
    },
  );

  it.each([false, true])(
    "retains the complete final prefix when earlier text was deferred (stream: %s)",
    async (stream) => {
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-before-terminal-prefix",
        onBlockReply,
        onBeforeTerminalDelivery: async () => undefined,
        blockReplyBreak: "text_end",
      });
      const first = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Result:" }],
        stopReason: "toolUse",
      });
      emitAssistantMessage(emit, first, stream);
      emit({ type: "tool_execution_start", toolName: "read", toolCallId: "read-prefix", args: {} });
      emit({
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "read-prefix",
        isError: false,
        result: { content: [{ type: "text", text: "OK" }] },
      });
      const final = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Result:complete" }],
      });
      emitAssistantMessage(emit, final, stream);
      emit({ type: "agent_end", messages: [first, final], willRetry: false });
      await subscription.waitForPendingEvents();
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual(["Result:complete"]);
      subscription.unsubscribe();
    },
  );
});
