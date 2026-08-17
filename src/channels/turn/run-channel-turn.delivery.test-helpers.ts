import { expect, vi } from "vitest";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatchSettledCounts } from "../../auto-reply/reply/reply-dispatch-outcome.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type {
  ReplyDispatchKind,
  ReplyDispatchReceipt,
  ReplyDispatchSettledCounts,
} from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { RecordInboundSession } from "../session.types.js";
import type { ChannelTurnResult } from "./types.js";

export function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    From: "sender",
    To: "target",
    SessionKey: "agent:main:test:peer",
    Provider: "test",
    Surface: "test",
    ...overrides,
  } as FinalizedMsgContext;
}

export function createRecordInboundSession(events: string[] = []): RecordInboundSession {
  return vi.fn(async () => {
    events.push("record");
  }) as unknown as RecordInboundSession;
}

export function createDurableSendResult(messageIds: string[]) {
  return {
    status: "sent",
    results: messageIds.map((messageId) => ({ messageId })),
    receipt: {
      platformMessageIds: messageIds,
      parts: [],
      sentAt: 1,
    },
  };
}

export function expectDispatched<TDispatchResult>(
  result: ChannelTurnResult<TDispatchResult>,
): asserts result is Extract<ChannelTurnResult<TDispatchResult>, { dispatched: true }> {
  expect(result.dispatched).toBe(true);
  if (!result.dispatched) {
    throw new Error("expected dispatch");
  }
}

export function createDispatch(
  events: string[] = [],
  deliverPayload: { text: string } = { text: "reply" },
): DispatchReplyWithBufferedBlockDispatcher {
  return vi.fn(async (params) => {
    events.push("dispatch");
    const delivery = await params.dispatcherOptions.deliver(deliverPayload, { kind: "final" });
    const deliveredNotVisible =
      typeof delivery === "object" &&
      delivery !== null &&
      "visibleReplySent" in delivery &&
      delivery.visibleReplySent === false;
    return {
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      settledReceipt: createReplyDispatchReceipt({
        final: deliveredNotVisible ? { deliveredNotVisible: 1 } : { delivered: 1 },
      }),
    };
  }) as DispatchReplyWithBufferedBlockDispatcher;
}

export function createDispatcherBackedDispatch(
  onReceipt: (receipt: ReplyDispatchReceipt | undefined) => void,
): DispatchReplyWithBufferedBlockDispatcher {
  return vi.fn(async (params) => {
    const dispatcher = createReplyDispatcher(params.dispatcherOptions);
    dispatcher.sendFinalReply({ text: "reply" });
    dispatcher.markComplete();
    const settledReceipt = (await dispatcher.waitForIdle()) || undefined;
    onReceipt(settledReceipt);
    return {
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      settledReceipt,
    };
  }) as DispatchReplyWithBufferedBlockDispatcher;
}

export function createReplyDispatchReceipt(
  outcomes: Partial<Record<ReplyDispatchKind, Partial<ReplyDispatchSettledCounts>>>,
): ReplyDispatchReceipt {
  const counts = (kind: ReplyDispatchKind): ReplyDispatchSettledCounts => ({
    ...createReplyDispatchSettledCounts(),
    ...outcomes[kind],
  });
  const receipt = { tool: counts("tool"), block: counts("block"), final: counts("final") };
  const anyVisibleDelivered = Object.values(receipt).some(
    (entry) => entry.delivered > 0 || entry.failedAfterSend > 0,
  );
  return { counts: receipt, anyVisibleDelivered };
}

export function expectNonVisibleFinalReceipt(result: unknown) {
  expect(result).toMatchObject({
    settledReceipt: {
      anyVisibleDelivered: false,
      counts: { final: { deliveredNotVisible: 1 } },
    },
  });
}
