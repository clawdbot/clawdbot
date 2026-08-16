// Channel turn delivery tests cover orchestration, dispatch, and completion behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatchSettledCounts } from "../../auto-reply/reply/reply-dispatch-outcome.js";
import type {
  ReplyDispatchKind,
  ReplyDispatchReceipt,
  ReplyDispatchSettledCounts,
} from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import type { RecordInboundSession } from "../session.types.js";
import {
  readAgentRunTerminalOutcome,
  recordAgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";
import { hasVisibleChannelTurnDispatchFromReceipt as hasVisibleChannelTurnDispatch } from "./dispatch-result.js";
import { dispatchAssembledChannelTurn, dispatchRoutedChannelTurn } from "./lifecycle.js";
import type { ChannelDeliveryInfo, ChannelTurnResult } from "./types.js";

const deliverOutboundPayloads = vi.hoisted(() => vi.fn());
const resolveOutboundDurableFinalDeliverySupport = vi.hoisted(() => vi.fn());
const sendDurableMessageBatch = vi.hoisted(() => vi.fn());
const recordInboundSessionCore = vi.hoisted(() => vi.fn(async () => undefined));
const dispatchReplyWithBufferedBlockDispatcherCore = vi.hoisted(() => vi.fn());
const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
const emitMessageSent = vi.hoisted(() => vi.fn());
const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const createMessageSentEmitter = vi.hoisted(() =>
  vi.fn(() => ({ emitMessageSent, hasMessageSentHooks: true })),
);
const readRecentUserAssistantTextForSession = vi.hoisted(() => vi.fn());
const settlePendingFinalDelivery = vi.hoisted(() =>
  vi.fn(async (_completion: unknown, state: string) => ({ state })),
);

vi.mock("../../auto-reply/reply/provider-dispatcher.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../auto-reply/reply/provider-dispatcher.js")>();
  return {
    ...actual,
    dispatchReplyWithBufferedBlockDispatcherCore,
  };
});

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/outbound/deliver.js")>();
  return {
    ...actual,
    deliverOutboundPayloads,
    resolveOutboundDurableFinalDeliverySupport,
  };
});

vi.mock("../message/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../message/send.js")>();
  return {
    ...actual,
    sendDurableMessageBatchCore: sendDurableMessageBatch,
  };
});

vi.mock("../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session.js")>();
  return { ...actual, recordInboundSession: recordInboundSessionCore };
});

vi.mock("../../infra/outbound/message-sent-hook.js", () => ({
  createMessageSentEmitter,
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner };
});

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession,
}));

vi.mock("../../infra/outbound/delivery-completion.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/delivery-completion.js")>();
  return { ...actual, settlePendingFinalDelivery };
});

const cfg = {} as OpenClawConfig;

function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
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

function createRecordInboundSession(events: string[] = []): RecordInboundSession {
  return vi.fn(async () => {
    events.push("record");
  }) as unknown as RecordInboundSession;
}

function createReceipt(
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

function createDispatch(
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
      settledReceipt: createReceipt({
        final: deliveredNotVisible ? { deliveredNotVisible: 1 } : { delivered: 1 },
      }),
    };
  }) as DispatchReplyWithBufferedBlockDispatcher;
}

function dispatchTestAssembledTurn(
  overrides: Omit<
    Parameters<typeof dispatchAssembledChannelTurn>[0],
    "cfg" | "agentId" | "storePath"
  >,
) {
  return dispatchAssembledChannelTurn({
    cfg,
    agentId: "main",
    storePath: "/tmp/sessions.json",
    ...overrides,
  });
}

function createDurableSendResult(messageIds: string[]) {
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

type DurableSendRequest = {
  accountId?: string;
  channel?: string;
  durability?: string;
  payloads?: ReplyPayload[];
  replyToMode?: string;
  session?: {
    key?: string;
    agentId?: string;
    requesterAccountId?: string;
    requesterSenderId?: string;
    conversationType?: string;
  };
  threadId?: string | number | null;
  to?: string;
};

type DurableSupportRequest = {
  channel?: string;
  requirements?: Record<string, boolean>;
};

type DeliveryResult = {
  messageIds?: string[];
  receipt?: { platformMessageIds?: string[] };
  visibleReplySent?: boolean;
};

function latestDurableSendRequest(): DurableSendRequest {
  const calls = sendDurableMessageBatch.mock.calls;
  const call = calls[calls.length - 1] as unknown as [DurableSendRequest] | undefined;
  if (!call) {
    throw new Error("expected durable send request");
  }
  const [request] = call;
  return request;
}

function latestDurableSupportRequest(): DurableSupportRequest {
  const calls = resolveOutboundDurableFinalDeliverySupport.mock.calls;
  const call = calls[calls.length - 1] as unknown as [DurableSupportRequest] | undefined;
  if (!call) {
    throw new Error("expected durable support request");
  }
  const [request] = call;
  return request;
}

function deliveryResult(value: unknown): DeliveryResult {
  return value as DeliveryResult;
}

function expectDispatched<TDispatchResult>(
  result: ChannelTurnResult<TDispatchResult>,
): asserts result is Extract<ChannelTurnResult<TDispatchResult>, { dispatched: true }> {
  expect(result.dispatched).toBe(true);
  if (!result.dispatched) {
    throw new Error("expected dispatch");
  }
}

describe("channel turn delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordInboundSessionCore.mockResolvedValue(undefined);
    dispatchReplyWithBufferedBlockDispatcherCore.mockImplementation(createDispatch());
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createDispatch());
    outboundMessageIdentities.clear();
    resetDiagnosticEventsForTest();
    resetLogger();
    setLoggerOverride({ level: "info" });
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
    createMessageSentEmitter.mockImplementation(() => ({
      emitMessageSent,
      hasMessageSentHooks: true,
    }));
    getGlobalHookRunner.mockReturnValue(null);
    readRecentUserAssistantTextForSession.mockResolvedValue([]);
  });

  afterEach(() => {
    setLoggerOverride(null);
    resetLogger();
  });

  it("runs routed direct message hooks after payload preparation", async () => {
    const events: string[] = [];
    const runMessageSending = vi.fn(async (event: { content: string }) => {
      events.push("message_sending");
      return { content: `${event.content} + message-hook` };
    });
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
    const deliver = vi.fn(async (payload: ReplyPayload) => {
      events.push("deliver");
      return { messageIds: ["direct-1"], visibleReplySent: true, content: payload.text };
    });

    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "acct",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({
        Surface: "telegram",
        OriginatingTo: "chat-1",
        ReplyToId: "source-1",
        MessageThreadId: 42,
      }),
      delivery: {
        preparePayload: (payload) => {
          events.push("prepare");
          return { ...payload, text: `${payload.text} + prepared`, mediaUrls: ["media://1"] };
        },
        deliver,
      },
    });

    expect(events).toEqual(["prepare", "message_sending", "deliver"]);
    expect(deliver).toHaveBeenCalledWith(
      { text: "reply + prepared + message-hook", mediaUrls: ["media://1"] },
      { kind: "final" },
    );
    expect(runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "reply + prepared",
        replyToId: "source-1",
        threadId: 42,
        metadata: expect.objectContaining({
          channel: "telegram",
          accountId: "acct",
          mediaUrls: ["media://1"],
        }),
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "acct",
        conversationId: "chat-1",
        sessionKey: "agent:main:telegram:peer",
      }),
    );
    expectDispatched(result);
    expect(result.dispatchResult.counts.final).toBe(1);
  });

  it("preserves pending final custody through preparation and message hook rewrites", async () => {
    const order: string[] = [];
    const completion = {
      deliveryId: "delivery-1",
      intentId: "intent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:peer",
      storePath: "/tmp/sessions.json",
    };
    const sourcePayload = setReplyPayloadMetadata(
      { text: "reply" },
      { pendingFinalDeliveryCompletion: completion },
    );
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
      await params.dispatcherOptions.deliver(sourcePayload, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending: vi.fn(async ({ content }: { content: string }) => ({
        content: `${content} + hook`,
      })),
    });
    let releaseDelivery: (() => void) | undefined;
    const deliveryPending = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    settlePendingFinalDelivery.mockImplementationOnce(async (_completion, state: string) => {
      order.push(`settle:${state}`);
      return { state };
    });
    const deliver = vi.fn(async (payload: ReplyPayload, info: ChannelDeliveryInfo) => {
      expect(getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion).toEqual(completion);
      expect("onPlatformSendDispatch" in info).toBe(false);
      order.push("signal:accepted");
      await deliveryPending;
      return { messageIds: ["direct-1"], visibleReplySent: true };
    });

    const dispatch = dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "acct",
      route: { agentId: "main", sessionKey: completion.sessionKey },
      ctxPayload: createCtx({ Surface: "telegram", OriginatingTo: "chat-1" }),
      delivery: {
        preparePayload: (payload) => ({ ...payload, text: `${payload.text} + prepared` }),
        deliver,
      },
    });

    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect(order).toEqual(["settle:unknown", "signal:accepted"]);
    releaseDelivery?.();
    await dispatch;

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ text: "reply + prepared + hook" });
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(
      1,
      { kind: "pending-final", ...completion },
      "unknown",
      ["prepared", "queued"],
    );
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(
      2,
      { kind: "pending-final", ...completion },
      "delivered",
    );
  });

  it("does not let message hooks resurrect payloads suppressed during preparation", async () => {
    const runMessageSending = vi.fn(async () => ({ content: "resurrected" }));
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
    const durable = vi.fn();
    const deliver = vi.fn();
    const onDelivered = vi.fn();

    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "whatsapp",
      route: { agentId: "main", sessionKey: "agent:main:whatsapp:peer" },
      ctxPayload: createCtx({ Surface: "whatsapp", OriginatingTo: "chat-1" }),
      delivery: {
        preparePayload: () => null,
        durable,
        deliver,
        onDelivered,
      },
    });

    expect(runMessageSending).not.toHaveBeenCalled();
    expect(durable).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "reply" },
      { kind: "final" },
      {
        visibleReplySent: false,
        suppression: { reason: "no_visible_payload" },
      },
    );
    expectDispatched(result);
    expect(result.dispatchResult).toMatchObject({
      settledReceipt: {
        anyVisibleDelivered: false,
        counts: { final: { deliveredNotVisible: 1 } },
      },
    });
  });

  it("suppresses routed direct delivery and visible counts when message hooks cancel", async () => {
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending: vi.fn(async () => ({
        cancel: true,
        cancelReason: "policy",
        metadata: { source: "test" },
      })),
    });
    const deliver = vi.fn();
    const onDelivered = vi.fn();

    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({ Surface: "telegram", OriginatingTo: "chat-1" }),
      delivery: { deliver, onDelivered, observeMessageSent: true },
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "reply" },
      { kind: "final" },
      {
        visibleReplySent: false,
        suppression: {
          reason: "cancelled_by_message_sending_hook",
          cancelReason: "policy",
          metadata: { source: "test" },
        },
      },
    );
    expect(emitMessageSent).not.toHaveBeenCalled();
    expectDispatched(result);
    expect(result.dispatchResult).toMatchObject({
      settledReceipt: {
        anyVisibleDelivered: false,
        counts: { final: { deliveredNotVisible: 1 } },
      },
    });
    expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(false);
  });

  it("exposes media-only routed payloads to the message hook before direct delivery", async () => {
    const runMessageSending = vi.fn(async () => ({ cancel: true }));
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
    const deliver = vi.fn();
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
      await params.dispatcherOptions.deliver({ mediaUrls: ["media://only"] }, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({ Surface: "telegram", OriginatingTo: "chat-1" }),
      delivery: { deliver },
    });

    expect(runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "",
        metadata: expect.objectContaining({ mediaUrls: ["media://only"] }),
      }),
      expect.anything(),
    );
    expect(deliver).not.toHaveBeenCalled();
  });

  it("reconciles one cancelled payload without hiding a delivered sibling", async () => {
    const runMessageSending = vi.fn(async ({ content }: { content: string }) =>
      content === "cancel me" ? { cancel: true } : undefined,
    );
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
    const deliver = vi.fn(async () => ({ visibleReplySent: true }));
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
      await params.dispatcherOptions.deliver({ text: "deliver me" }, { kind: "block" });
      await params.dispatcherOptions.deliver({ text: "cancel me" }, { kind: "final" });
      return recordAgentRunTerminalOutcome(
        {
          queuedFinal: true,
          counts: { tool: 0, block: 1, final: 1 },
          settledReceipt: createReceipt({
            block: { delivered: 1 },
            final: { deliveredNotVisible: 1 },
          }),
        },
        "failed",
      );
    });

    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({ Surface: "telegram" }),
      delivery: { deliver },
    });

    expect(runMessageSending).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ text: "deliver me" }, { kind: "block" });
    expectDispatched(result);
    expect(result.dispatchResult).toMatchObject({
      settledReceipt: {
        anyVisibleDelivered: true,
        counts: {
          block: { delivered: 1 },
          final: { deliveredNotVisible: 1 },
        },
      },
    });
    expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(true);
    expect(readAgentRunTerminalOutcome(result.dispatchResult)).toBe("failed");
  });

  it("delegates routed hybrid delivery to the provider message hook owner", async () => {
    const runMessageSending = vi.fn();
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
    const deliverWithProviderMessageSending = vi.fn(async () => ({
      messageIds: ["provider-1"],
      visibleReplySent: true,
    }));

    await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({ Surface: "telegram" }),
      delivery: { deliverWithProviderMessageSending },
    });

    expect(deliverWithProviderMessageSending).toHaveBeenCalledWith(
      { text: "reply" },
      expect.objectContaining({
        kind: "final",
        onPlatformSendDispatch: expect.any(Function),
      }),
    );
    expect(runMessageSending).not.toHaveBeenCalled();
  });

  it("uses the durable message hook owner and the core owner only after unsupported preflight", async () => {
    const runMessageSending = vi.fn(async ({ content }: { content: string }) => ({
      content: `${content} + direct-hook`,
    }));
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending",
      runMessageSending,
    });
    sendDurableMessageBatch.mockResolvedValueOnce(createDurableSendResult(["durable-1"]));
    const durableDeliver = vi.fn();

    await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({ Surface: "telegram", To: "chat-1" }),
      delivery: { deliver: durableDeliver, durable: { replyToMode: "first" } },
    });

    expect(durableDeliver).not.toHaveBeenCalled();
    expect(runMessageSending).not.toHaveBeenCalled();

    resolveOutboundDurableFinalDeliverySupport.mockResolvedValueOnce({
      ok: false,
      reason: "missing_outbound_handler",
    });
    const fallbackDeliver = vi.fn(async () => ({ visibleReplySent: true }));
    await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({ Surface: "telegram", To: "chat-1" }),
      delivery: { deliver: fallbackDeliver, durable: { replyToMode: "first" } },
    });

    expect(runMessageSending).toHaveBeenCalledTimes(1);
    expect(fallbackDeliver).toHaveBeenCalledWith(
      { text: "reply + direct-hook" },
      { kind: "final" },
    );
  });

  it("classifies routed delivery only after provider finalization settles", async () => {
    const onDelivered = vi.fn();
    const finalization = Promise.resolve({
      messageIds: ["final-1"],
      visibleReplySent: true as const,
      content: "final content",
    });

    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({ Surface: "telegram" }),
      delivery: {
        deliver: async () => ({ visibleReplySent: false, finalization }),
        onDelivered,
      },
    });

    expect(onDelivered).toHaveBeenCalledWith(
      { text: "reply" },
      { kind: "final" },
      expect.objectContaining({
        messageIds: ["final-1"],
        visibleReplySent: true,
        content: "final content",
      }),
    );
    expectDispatched(result);
    expect(result.dispatchResult.counts.final).toBe(1);
    expect(result.dispatchResult.queuedFinal).toBe(true);
  });

  it("routes assembled final replies through durable outbound delivery", async () => {
    sendDurableMessageBatch.mockResolvedValueOnce(createDurableSendResult(["tg-1"]));
    const deliver = vi.fn();
    const recordInboundSession = createRecordInboundSession();
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    const result = await dispatchTestAssembledTurn({
      channel: "telegram",
      accountId: "acct",
      routeSessionKey: "agent:main:telegram:peer",
      ctxPayload: createCtx({
        To: "123",
        OriginatingTo: "123",
        MessageThreadId: 777,
        AccountId: "acct",
        ChatType: "group",
        SenderId: "sender-1",
      }),
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver, durable: { replyToMode: "first" } },
    });

    expect(result.dispatched).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    const sendRequest = latestDurableSendRequest();
    expect(sendRequest.channel).toBe("telegram");
    expect(sendRequest.to).toBe("123");
    expect(sendRequest.accountId).toBe("acct");
    expect(sendRequest.payloads?.[0]?.text).toBe("reply");
    expect(sendRequest.durability).toBe("best_effort");
    expect(sendRequest.replyToMode).toBe("first");
    expect(sendRequest.threadId).toBe(777);
    expect(sendRequest.session).toEqual({
      key: "agent:main:test:peer",
      agentId: "main",
      requesterAccountId: "acct",
      requesterSenderId: "sender-1",
      conversationType: "group",
      conversationKind: "group",
    });
    expect(resolveOutboundDurableFinalDeliverySupport).toHaveBeenCalledTimes(1);
    const supportRequest = latestDurableSupportRequest();
    expect(supportRequest.channel).toBe("telegram");
    expect(supportRequest.requirements).toEqual({
      text: true,
      thread: true,
      messageSendingHooks: true,
    });
  });

  it("returns durable delivery result to the buffered dispatcher", async () => {
    sendDurableMessageBatch.mockResolvedValueOnce(createDurableSendResult(["tg-1", "tg-2"]));
    let deliveredResult: unknown;
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async (params: Parameters<DispatchReplyWithBufferedBlockDispatcher>[0]) => {
        deliveredResult = await params.dispatcherOptions.deliver(
          { text: "reply" },
          { kind: "final" },
        );
        return {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        };
      },
    ) as DispatchReplyWithBufferedBlockDispatcher;

    await dispatchTestAssembledTurn({
      channel: "telegram",
      accountId: "acct",
      routeSessionKey: "agent:main:telegram:peer",
      ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver: vi.fn(), durable: { replyToMode: "first" } },
    });

    const delivered = deliveryResult(deliveredResult);
    expect(delivered.messageIds).toEqual(["tg-1", "tg-2"]);
    expect(delivered.receipt?.platformMessageIds).toEqual(["tg-1", "tg-2"]);
    expect(delivered.visibleReplySent).toBe(true);
  });

  it("maps durable hook cancellation to typed routed suppression", async () => {
    sendDurableMessageBatch.mockResolvedValueOnce({
      status: "suppressed",
      results: [],
      receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
      reason: "cancelled_by_message_sending_hook",
      payloadOutcomes: [
        {
          index: 0,
          status: "suppressed",
          reason: "cancelled_by_message_sending_hook",
          hookEffect: { cancelReason: "policy", metadata: { source: "test" } },
        },
      ],
    });
    const onDelivered = vi.fn();

    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({ Surface: "telegram", To: "chat-1" }),
      delivery: {
        deliver: vi.fn(),
        durable: { replyToMode: "first" },
        onDelivered,
      },
    });

    expect(onDelivered).toHaveBeenCalledWith(
      { text: "reply" },
      { kind: "final" },
      expect.objectContaining({
        visibleReplySent: false,
        suppression: {
          reason: "cancelled_by_message_sending_hook",
          cancelReason: "policy",
          metadata: { source: "test" },
        },
      }),
    );
    expectDispatched(result);
    expect(result.dispatchResult).toMatchObject({
      settledReceipt: {
        anyVisibleDelivered: false,
        counts: { final: { deliveredNotVisible: 1 } },
      },
    });
  });

  it("keeps no-identity durable sends visible through lifecycle settlement", async () => {
    sendDurableMessageBatch.mockResolvedValueOnce({
      status: "suppressed",
      results: [],
      receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
      reason: "adapter_returned_no_identity",
    });
    const onDelivered = vi.fn();

    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({ Surface: "telegram", To: "chat-1" }),
      delivery: {
        deliver: vi.fn(),
        durable: { replyToMode: "first" },
        onDelivered,
      },
    });

    expect(onDelivered).toHaveBeenCalledWith(
      { text: "reply" },
      { kind: "final" },
      expect.objectContaining({
        visibleReplySent: true,
        suppression: { reason: "adapter_returned_no_identity" },
      }),
    );
    expectDispatched(result);
    expect(result.dispatchResult).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(true);
  });

  it("prepares payloads before durable enqueue and observes handled delivery", async () => {
    sendDurableMessageBatch.mockResolvedValueOnce(createDurableSendResult(["tlon-1"]));
    const onDelivered = vi.fn();
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    await dispatchTestAssembledTurn({
      channel: "tlon",
      accountId: "acct",
      routeSessionKey: "agent:main:tlon:peer",
      ctxPayload: createCtx({ To: "chat/~nec/general", OriginatingTo: "chat/~nec/general" }),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        deliver: vi.fn(),
        durable: (payload) => ({
          replyToMode: "first",
          requiredCapabilities: { text: payload.text?.includes("Generated") === true },
        }),
        preparePayload: (payload) => ({
          ...payload,
          text: `${payload.text}\n\n_[Generated by test]_`,
        }),
        observeMessageSent: true,
        onDelivered,
      },
    });

    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    expect(latestDurableSendRequest().payloads?.[0]?.text).toBe("reply\n\n_[Generated by test]_");
    expect(resolveOutboundDurableFinalDeliverySupport).toHaveBeenCalledTimes(1);
    expect(latestDurableSupportRequest().requirements).toEqual({
      text: true,
    });
    expect(onDelivered).toHaveBeenCalledTimes(1);
    const [deliveredPayload, deliveredInfo, deliveredResult] = onDelivered.mock
      .calls[0] as unknown as [ReplyPayload, unknown, DeliveryResult];
    expect(deliveredPayload.text).toBe("reply\n\n_[Generated by test]_");
    expect(deliveredInfo).toEqual({ kind: "final" });
    expect(deliveredResult.visibleReplySent).toBe(true);
    // The durable outbound pipeline owns message_sent; the turn lifecycle must not duplicate it.
    expect(emitMessageSent).not.toHaveBeenCalled();
  });

  it("falls back before queueing when durable outbound delivery is unsupported", async () => {
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValueOnce({
      ok: false,
      reason: "missing_outbound_handler",
    });
    const deliver = vi.fn(async () => ({ messageIds: ["legacy-1"], visibleReplySent: true }));
    let deliveredResult: unknown;
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async (params: Parameters<DispatchReplyWithBufferedBlockDispatcher>[0]) => {
        deliveredResult = await params.dispatcherOptions.deliver(
          { text: "reply" },
          { kind: "final" },
        );
        return {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        };
      },
    ) as DispatchReplyWithBufferedBlockDispatcher;

    await dispatchTestAssembledTurn({
      channel: "telegram",
      accountId: "acct",
      routeSessionKey: "agent:main:telegram:peer",
      ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver, durable: { replyToMode: "first" } },
    });

    expect(resolveOutboundDurableFinalDeliverySupport).toHaveBeenCalledTimes(1);
    const supportRequest = latestDurableSupportRequest();
    expect(supportRequest.channel).toBe("telegram");
    expect(supportRequest.requirements).toEqual({
      text: true,
      messageSendingHooks: true,
    });
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith({ text: "reply" }, { kind: "final" });
    const delivered = deliveryResult(deliveredResult);
    expect(delivered.messageIds).toEqual(["legacy-1"]);
    expect(delivered.visibleReplySent).toBe(true);
  });

  it("treats durable outbound support preflight failures as terminal", async () => {
    resolveOutboundDurableFinalDeliverySupport.mockRejectedValueOnce(new Error("preflight failed"));
    const deliver = vi.fn(async () => ({ messageIds: ["legacy-1"], visibleReplySent: true }));
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    await expect(
      dispatchTestAssembledTurn({
        channel: "telegram",
        accountId: "acct",
        routeSessionKey: "agent:main:telegram:peer",
        ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
        recordInboundSession: createRecordInboundSession(),
        dispatchReplyWithBufferedBlockDispatcher,
        delivery: { deliver, durable: { replyToMode: "first" } },
      }),
    ).rejects.toThrow("preflight failed");

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("preserves durable partial-send visibility when generic delivery throws", async () => {
    const error = new Error("second chunk failed");
    sendDurableMessageBatch.mockResolvedValueOnce({
      status: "partial_failed",
      results: [{ channel: "telegram", messageId: "tg-1" }],
      receipt: {
        primaryPlatformMessageId: "tg-1",
        platformMessageIds: ["tg-1"],
        parts: [{ platformMessageId: "tg-1", kind: "text", index: 0 }],
        sentAt: 1,
      },
      error,
      sentBeforeError: true,
    });
    const deliver = vi.fn(async () => ({ messageIds: ["legacy-1"], visibleReplySent: true }));
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    await expect(
      dispatchTestAssembledTurn({
        channel: "telegram",
        accountId: "acct",
        routeSessionKey: "agent:main:telegram:peer",
        ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
        recordInboundSession: createRecordInboundSession(),
        dispatchReplyWithBufferedBlockDispatcher,
        delivery: { deliver, durable: { replyToMode: "first" } },
      }),
    ).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });

    expect(deliver).not.toHaveBeenCalled();
  });

  it("preserves visible delivery when post-delivery observers throw", async () => {
    const error = new Error("observer failed");
    const deliver = vi.fn(async () => ({ messageIds: ["local-1"], visibleReplySent: true }));
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    await expect(
      dispatchTestAssembledTurn({
        channel: "telegram",
        accountId: "acct",
        routeSessionKey: "agent:main:telegram:peer",
        ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
        recordInboundSession: createRecordInboundSession(),
        dispatchReplyWithBufferedBlockDispatcher,
        delivery: {
          deliver,
          durable: false,
          onDelivered: () => {
            throw error;
          },
        },
      }),
    ).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });
    expect(error).toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });
  });

  it("returns custom delivery result to the buffered dispatcher", async () => {
    let deliveredResult: unknown;
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async (params: Parameters<DispatchReplyWithBufferedBlockDispatcher>[0]) => {
        deliveredResult = await params.dispatcherOptions.deliver(
          { text: "reply" },
          { kind: "final" },
        );
        return {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        };
      },
    ) as DispatchReplyWithBufferedBlockDispatcher;

    await dispatchTestAssembledTurn({
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      ctxPayload: createCtx(),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        durable: false,
        deliver: vi.fn(async () => ({ messageIds: ["local-1"], visibleReplySent: true })),
      },
    });

    const delivered = deliveryResult(deliveredResult);
    expect(delivered.messageIds).toEqual(["local-1"]);
    expect(delivered.visibleReplySent).toBe(true);
  });

  it("observes provider-finalized content and identity after deferred delivery settles", async () => {
    const events: string[] = [];
    emitMessageSent.mockImplementation((event) => {
      events.push("message_sent");
      return event;
    });
    let resolveFinalization!: (result: {
      content: string;
      messageIds: string[];
      visibleReplySent: true;
    }) => void;
    const finalization = new Promise<{
      content: string;
      messageIds: string[];
      visibleReplySent: true;
    }>((resolve) => {
      resolveFinalization = resolve;
    });
    const deliver = vi.fn(async () => {
      events.push("deliver");
      return { visibleReplySent: false, finalization };
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      params.replyOptions?.onAgentRunStart?.("run-finalized");
      await params.dispatcherOptions.deliver({ text: "pre-final text" }, { kind: "final" });
      events.push("provider-finalized");
      resolveFinalization({
        content: "provider final text",
        messageIds: ["om-final"],
        visibleReplySent: true,
      });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await dispatchTestAssembledTurn({
      channel: "feishu",
      accountId: "acct",
      routeSessionKey: "agent:main:feishu:peer",
      ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu", OriginatingTo: "oc_chat" }),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver, observeMessageSent: true },
    });

    expect(events).toEqual(["deliver", "provider-finalized", "message_sent"]);
    expect(emitMessageSent).toHaveBeenCalledOnce();
    expect(emitMessageSent).toHaveBeenCalledWith({
      success: true,
      content: "provider final text",
      messageId: "om-final",
    });
    expect(createMessageSentEmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        to: "oc_chat",
        runId: "run-finalized",
        sessionKeyForInternalHooks: "agent:main:feishu:peer",
      }),
    );
  });
});
