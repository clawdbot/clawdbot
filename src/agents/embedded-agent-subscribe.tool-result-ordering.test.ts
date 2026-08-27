import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDeltaAndEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

describe("subscribeEmbeddedAgentSession tool result ordering", () => {
  it.each([
    { delivery: "resolve", flush: false },
    { delivery: "reject", flush: false },
    { delivery: "resolve", flush: true },
    { delivery: "reject", flush: true },
  ] as const)(
    "preserves recovery behind an unavailable notice ($delivery, block flush: $flush)",
    async ({ delivery, flush }) => {
      const entered = createDeferred();
      const notice = createDeferred();
      const order: string[] = [];
      const answer = "I recovered the answer using another tool.";
      const onToolResult = vi.fn(async () => {
        order.push("notice entered");
        entered.resolve();
        try {
          await notice.promise;
        } finally {
          order.push("notice settled");
        }
      });
      const onPartialReply = vi.fn(() => {
        order.push("partial");
      });
      const onBlockReply = vi.fn(() => {
        order.push("block");
      });
      const onBlockReplyFlush = vi.fn(async () => {});
      const onAgentEvent = vi.fn<NonNullable<SubscribeEmbeddedAgentSessionParams["onAgentEvent"]>>(
        ({ stream, data }) => {
          if (stream === "lifecycle" && data.phase === "end") {
            order.push("terminal");
          }
        },
      );
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `run-unavailable-${delivery}-${flush}`,
        onToolResult,
        onPartialReply,
        onBlockReply,
        onBlockReplyFlush: flush ? onBlockReplyFlush : undefined,
        onAssistantMessageStart: () => {
          order.push("assistant start");
        },
        onAgentEvent,
        blockReplyBreak: "message_end",
      });

      try {
        emit({ type: "tool_execution_start", toolName: "exec", toolCallId: "notice", args: {} });
        emit({
          type: "tool_execution_end",
          toolName: "exec",
          toolCallId: "notice",
          isError: false,
          result: {
            details: { status: "approval-unavailable", reason: "no-approval-route" },
          },
        });
        await entered.promise;
        expect(onToolResult).toHaveBeenCalledOnce();
        expect(onToolResult).toHaveBeenCalledWith(
          expect.objectContaining({
            channelData: { execApprovalUnavailable: { reason: "no-approval-route" } },
          }),
        );
        onBlockReplyFlush.mockClear();

        emit({ type: "message_start", message: { role: "assistant", content: [] } });
        emitAssistantTextDeltaAndEnd({ emit, text: answer });
        emit({ type: "agent_end", messages: [], willRetry: false });
        const drain = subscription.waitForPendingEvents().then(() => {
          order.push("drained");
        });

        // Let already-runnable handlers finish; the notice remains explicitly unresolved.
        await setImmediate();
        expect([...order]).toEqual(["notice entered"]);
        expect(subscription.assistantTexts).toEqual([]);
        expect(subscription.getCurrentAttemptAssistant()).toBeUndefined();
        expect(onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant")).toEqual(
          [],
        );
        expect(onBlockReplyFlush).not.toHaveBeenCalled();
        expect(subscription.didSendDeterministicApprovalPrompt()).toBe(false);

        if (delivery === "reject") {
          notice.reject(new Error("notice transport failed"));
        } else {
          notice.resolve();
        }
        await drain;

        expect(order).toEqual([
          "notice entered",
          "notice settled",
          "assistant start",
          "partial",
          "block",
          "terminal",
          "drained",
        ]);
        expect(onPartialReply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: answer, delta: answer }),
        );
        expect(onBlockReply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: answer }),
          { assistantMessageIndex: 1 },
        );
        expect(onBlockReplyFlush.mock.calls).toEqual(
          flush ? [[{ reason: "message_end" }], [{ reason: "terminal" }]] : [],
        );
        expect(subscription.didSendDeterministicApprovalPrompt()).toBe(false);
        expect(subscription.getLastToolError()).toEqual(
          delivery === "reject"
            ? expect.objectContaining({
                error: "Approval prompt delivery failed: notice transport failed",
              })
            : undefined,
        );
        expect(
          buildEmbeddedRunPayloads({
            assistantTexts: subscription.assistantTexts,
            lastAssistant: subscription.getCurrentAttemptAssistant(),
            lastToolError: subscription.getLastToolError(),
            sessionKey: "agent:main:ordering",
            didSendDeterministicApprovalPrompt: subscription.didSendDeterministicApprovalPrompt(),
          }),
        ).toEqual([expect.objectContaining({ text: answer })]);
      } finally {
        notice.resolve();
        await subscription.waitForPendingEvents();
        subscription.unsubscribe();
      }
    },
  );
});
