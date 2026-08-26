// Channel turn pipeline tests cover orchestration, dispatch, and completion behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { noteDispatchProcessedOutcome } from "../../auto-reply/reply/dispatch-processed-outcome.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { getReplySystemEventSessionKey } from "../../auto-reply/reply/system-event-session-key.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { logMessageProcessed } from "../../logging/diagnostic.js";
import { getChildLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import type { RecordInboundSession } from "../session.types.js";
import { runPreparedChannelTurn } from "./execution.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";
import type { ChannelTurnResult, PreparedChannelTurn } from "./types.js";

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
const subsystemWarn = vi.hoisted(() => vi.fn());

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  const makeLogger = (subsystem: string): import("../../logging/subsystem.js").SubsystemLogger => ({
    subsystem,
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: subsystemWarn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: (name: string) => makeLogger(`${subsystem}/${name}`),
  });
  return {
    ...actual,
    createSubsystemLogger: makeLogger,
  };
});

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

const cfg = {} as OpenClawConfig;
const visibleFinalReceipt = {
  counts: {
    tool: {
      delivered: 0,
      deliveredNotVisible: 0,
      cancelled: 0,
      failedBeforeSend: 0,
      failedAfterSend: 0,
    },
    block: {
      delivered: 0,
      deliveredNotVisible: 0,
      cancelled: 0,
      failedBeforeSend: 0,
      failedAfterSend: 0,
    },
    final: {
      delivered: 1,
      deliveredNotVisible: 0,
      cancelled: 0,
      failedBeforeSend: 0,
      failedAfterSend: 0,
    },
  },
  anyVisibleDelivered: true,
} as const;

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

function createDispatch(
  events: string[] = [],
  deliverPayload: { text: string } = { text: "reply" },
): DispatchReplyWithBufferedBlockDispatcher {
  return vi.fn(async (params) => {
    events.push("dispatch");
    await params.dispatcherOptions.deliver(deliverPayload, { kind: "final" });
    return {
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      settledReceipt: visibleFinalReceipt,
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

function runTestPreparedChannelTurn<TDispatchResult>(
  params: Pick<PreparedChannelTurn<TDispatchResult>, "runDispatch" | "log" | "messageId">,
) {
  return runPreparedChannelTurn({
    channel: "test",
    routeSessionKey: "agent:main:test:peer",
    storePath: "/tmp/sessions.json",
    ctxPayload: createCtx(),
    recordInboundSession: createRecordInboundSession(),
    record: { onRecordError: vi.fn() },
    ...params,
  });
}

type TurnLogEvent = {
  event?: string;
  messageId?: string;
  stage?: string;
};

type DeliveryResult = {
  messageIds?: string[];
  visibleReplySent?: boolean;
};

function expectDispatched<TDispatchResult>(
  result: ChannelTurnResult<TDispatchResult>,
): asserts result is Extract<ChannelTurnResult<TDispatchResult>, { dispatched: true }> {
  expect(result.dispatched).toBe(true);
  if (!result.dispatched) {
    throw new Error("expected dispatch");
  }
}

function loggedEvents(log: ReturnType<typeof vi.fn>): TurnLogEvent[] {
  return log.mock.calls.map(([event]) => {
    const entry = event as TurnLogEvent;
    return {
      stage: entry.stage,
      event: entry.event,
      ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
    };
  });
}

describe("channel turn pipeline", () => {
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

  it("emits and observes ordinary delivery before buffered dispatch continues", async () => {
    const events: string[] = [];
    emitMessageSent.mockImplementation(() => {
      events.push("message_sent");
    });
    const onDelivered = vi.fn(() => {
      events.push("onDelivered");
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver({ text: "ordinary" }, { kind: "final" });
      events.push("after-deliver");
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await dispatchTestAssembledTurn({
      channel: "feishu",
      routeSessionKey: "agent:main:feishu:peer",
      ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu" }),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        observeMessageSent: true,
        deliver: async () => ({
          content: "ordinary",
          messageIds: ["om-ordinary"],
          visibleReplySent: true,
        }),
        onDelivered,
      },
    });

    expect(events).toEqual(["message_sent", "onDelivered", "after-deliver"]);
    expect(onDelivered).toHaveBeenCalledOnce();
  });

  it.each([
    {
      channel: "slack",
      routeSessionKey: "agent:main:slack:channel:c1",
      dispatchSessionKey: "agent:main:slack:channel:c1:thread:123.456",
    },
    {
      channel: "discord",
      routeSessionKey: "agent:main:discord:channel:c1",
      dispatchSessionKey: "agent:main:discord:channel:c1:thread:t1",
    },
  ])("carries $channel route system-event ownership privately into dispatch", async (scenario) => {
    const { channel, routeSessionKey, dispatchSessionKey } = scenario;
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      expect(params.ctx).not.toHaveProperty("SystemEventSessionKey");
      expect(getReplySystemEventSessionKey({ ...params.replyOptions })).toBe(routeSessionKey);
      await params.dispatcherOptions.deliver({ text: "reply" }, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await dispatchTestAssembledTurn({
      channel,
      routeSessionKey,
      ctxPayload: createCtx({
        SessionKey: dispatchSessionKey,
        Surface: channel,
        Provider: channel,
      }),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        deliver: async () => ({ visibleReplySent: true }),
      },
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("does not emit a second failure when a post-send observer throws", async () => {
    const observerError = new Error("observer failed");
    const onError = vi.fn();

    await expect(
      dispatchTestAssembledTurn({
        channel: "feishu",
        routeSessionKey: "agent:main:feishu:peer",
        ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu" }),
        recordInboundSession: createRecordInboundSession(),
        dispatchReplyWithBufferedBlockDispatcher: createDispatch(),
        delivery: {
          observeMessageSent: true,
          deliver: async () => ({ messageIds: ["om-visible"], visibleReplySent: true }),
          onDelivered: () => {
            throw observerError;
          },
          onError,
        },
      }),
    ).rejects.toBe(observerError);

    expect(emitMessageSent).toHaveBeenCalledOnce();
    expect(emitMessageSent).toHaveBeenCalledWith({
      success: true,
      content: "reply",
      messageId: "om-visible",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("observes early finalization rejection before reporting partial delivery", async () => {
    let rejectFinalization!: (error: unknown) => void;
    const finalization = new Promise<{
      content: string;
      messageIds: string[];
      visibleReplySent: true;
    }>((_resolve, reject) => {
      rejectFinalization = reject;
    });
    const catchSpy = vi.spyOn(finalization, "catch");
    const partialError = Object.assign(
      new Error("final edit failed", { cause: new Error("provider rejected edit") }),
      {
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: {
          content: "accepted preview",
          messageIds: ["om-preview"],
          visibleReplySent: true,
        },
      },
    );
    const onError = vi.fn();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver({ text: "requested final" }, { kind: "final" });
      expect(catchSpy).toHaveBeenCalledOnce();
      rejectFinalization(partialError);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await expect(
      dispatchTestAssembledTurn({
        channel: "feishu",
        routeSessionKey: "agent:main:feishu:peer",
        ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu" }),
        recordInboundSession: createRecordInboundSession(),
        dispatchReplyWithBufferedBlockDispatcher,
        delivery: {
          observeMessageSent: true,
          deliver: async () => ({ visibleReplySent: false, finalization }),
          onError,
        },
      }),
    ).rejects.toBe(partialError);

    expect(emitMessageSent).toHaveBeenCalledOnce();
    expect(emitMessageSent).toHaveBeenCalledWith({
      success: false,
      content: "accepted preview",
      error: "final edit failed | provider rejected edit",
      messageId: "om-preview",
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(partialError, { kind: "final" });
  });

  it("preserves deferred partial delivery when dispatch also fails", async () => {
    let rejectFinalization!: (error: unknown) => void;
    const finalization = new Promise<{
      content: string;
      messageIds: string[];
      visibleReplySent: true;
    }>((_resolve, reject) => {
      rejectFinalization = reject;
    });
    const dispatchError = new Error("stream close failed");
    const settlementError = Object.assign(new Error("static fallback failed"), {
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "accepted preview",
        messageIds: ["om-preview"],
        visibleReplySent: true,
      },
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver({ text: "requested final" }, { kind: "final" });
      rejectFinalization(settlementError);
      throw dispatchError;
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await expect(
      dispatchTestAssembledTurn({
        channel: "feishu",
        routeSessionKey: "agent:main:feishu:peer",
        ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu" }),
        recordInboundSession: createRecordInboundSession(),
        dispatchReplyWithBufferedBlockDispatcher,
        delivery: {
          observeMessageSent: true,
          deliver: async () => ({ visibleReplySent: false, finalization }),
        },
      }),
    ).rejects.toBe(settlementError);

    expect(emitMessageSent).toHaveBeenCalledOnce();
    expect(emitMessageSent).toHaveBeenCalledWith({
      success: false,
      content: "accepted preview",
      error: "static fallback failed",
      messageId: "om-preview",
    });
  });

  it("prefers a later visible partial error across deferred payloads", async () => {
    let rejectFirst!: (error: unknown) => void;
    let rejectSecond!: (error: unknown) => void;
    const firstFinalization = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondFinalization = new Promise<never>((_resolve, reject) => {
      rejectSecond = reject;
    });
    const firstError = new Error("first finalization failed");
    const partialError = Object.assign(new Error("second finalization failed"), {
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "accepted second preview",
        messageIds: ["om-second-preview"],
        visibleReplySent: true,
      },
    });
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({ visibleReplySent: false, finalization: firstFinalization })
      .mockResolvedValueOnce({ visibleReplySent: false, finalization: secondFinalization });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      await params.dispatcherOptions.deliver({ text: "first requested" }, { kind: "final" });
      await params.dispatcherOptions.deliver({ text: "second requested" }, { kind: "final" });
      rejectFirst(firstError);
      rejectSecond(partialError);
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 2 } };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await expect(
      dispatchTestAssembledTurn({
        channel: "feishu",
        routeSessionKey: "agent:main:feishu:peer",
        ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu" }),
        recordInboundSession: createRecordInboundSession(),
        dispatchReplyWithBufferedBlockDispatcher,
        delivery: { observeMessageSent: true, deliver },
      }),
    ).rejects.toBe(partialError);

    expect(emitMessageSent).toHaveBeenCalledTimes(2);
    expect(emitMessageSent).toHaveBeenNthCalledWith(1, {
      success: false,
      content: "first requested",
      error: "first finalization failed",
      messageId: undefined,
    });
    expect(emitMessageSent).toHaveBeenNthCalledWith(2, {
      success: false,
      content: "accepted second preview",
      error: "second finalization failed",
      messageId: "om-second-preview",
    });
  });

  it("suppresses message_sent when the adapter proves provider dispatch never began", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      try {
        await params.dispatcherOptions.deliver({ text: "reply" }, { kind: "final" });
      } catch {
        // The buffered dispatcher already owns delivery-error reporting.
      }
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    await dispatchTestAssembledTurn({
      channel: "feishu",
      routeSessionKey: "agent:main:feishu:peer",
      ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu" }),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        observeMessageSent: true,
        deliver: async () => {
          throw new PlatformMessageNotDispatchedError("local media load failed", {
            cause: new Error("missing file"),
          });
        },
      },
    });

    expect(emitMessageSent).not.toHaveBeenCalled();
  });

  it("does not use durable outbound delivery when durable options are omitted", async () => {
    const deliver = vi.fn(async () => ({ messageIds: ["local-1"], visibleReplySent: true }));
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    await dispatchTestAssembledTurn({
      channel: "telegram",
      accountId: "acct",
      routeSessionKey: "agent:main:telegram:peer",
      ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver },
    });

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith({ text: "reply" }, { kind: "final" });
  });

  it("prepares payloads and observes legacy delivery results", async () => {
    const onDelivered = vi.fn();
    const deliver = vi.fn(async () => ({ messageIds: ["local-1"], visibleReplySent: true }));
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    await dispatchTestAssembledTurn({
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      ctxPayload: createCtx(),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        deliver,
        preparePayload: (payload) => ({ ...payload, text: `${payload.text}!` }),
        onDelivered,
      },
    });

    expect(deliver).toHaveBeenCalledWith({ text: "reply!" }, { kind: "final" });
    expect(onDelivered).toHaveBeenCalledTimes(1);
    const [deliveredPayload, deliveredInfo, deliveredResult] = onDelivered.mock
      .calls[0] as unknown as [ReplyPayload, unknown, DeliveryResult];
    expect(deliveredPayload).toEqual({ text: "reply!" });
    expect(deliveredInfo).toEqual({ kind: "final" });
    expect(deliveredResult.messageIds).toEqual(["local-1"]);
    expect(deliveredResult.visibleReplySent).toBe(true);
  });

  it("assembles channel message reply pipeline options inside the turn kernel", async () => {
    const deliver = vi.fn(async () => ({ messageIds: ["local-1"], visibleReplySent: true }));
    const transformReplyPayload = vi.fn((payload: ReplyPayload) => ({
      ...payload,
      text: `${payload.text} from pipeline`,
    }));
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async (params: Parameters<DispatchReplyWithBufferedBlockDispatcher>[0]) => {
        const transformed = params.dispatcherOptions.transformReplyPayload?.({ text: "reply" });
        await params.dispatcherOptions.deliver(transformed ?? { text: "missing" }, {
          kind: "final",
        });
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
      delivery: { deliver },
      replyPipeline: { transformReplyPayload },
    });

    expect(transformReplyPayload).toHaveBeenCalledWith({ text: "reply" });
    expect(deliver).toHaveBeenCalledWith({ text: "reply from pipeline" }, { kind: "final" });
  });

  it("records transform suppression without blocking a later visible channel payload", async () => {
    const deliver = vi.fn(async (payload: ReplyPayload) => ({
      messageIds: [`local:${payload.text}`],
      visibleReplySent: true,
      content: payload.text,
    }));
    const onDelivered = vi.fn();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      const dispatcher = createReplyDispatcher(params.dispatcherOptions);
      expect(dispatcher.sendFinalReply({ text: "private reply" })).toBe(false);
      expect(dispatcher.sendFinalReply({ text: "public reply" })).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return {
        queuedFinal: dispatcher.getQueuedCounts().final > 0,
        counts: dispatcher.getQueuedCounts(),
      };
    }) as DispatchReplyWithBufferedBlockDispatcher;

    const result = await dispatchTestAssembledTurn({
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      ctxPayload: createCtx(),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver, onDelivered, observeMessageSent: true },
      replyPipeline: {
        transformReplyPayload: (payload) => (payload.text === "private reply" ? null : payload),
      },
    });

    expect(deliver).toHaveBeenCalledExactlyOnceWith({ text: "public reply" }, { kind: "final" });
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "private reply" },
      { kind: "final" },
      {
        visibleReplySent: false,
        suppression: { reason: "channel_transform" },
      },
    );
    expect(emitMessageSent).toHaveBeenCalledTimes(1);
    expectDispatched(result);
    expect(result.dispatchResult).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
  });

  it("records inbound session before dispatching delivery", async () => {
    const events: string[] = [];
    const deliver = vi.fn(async () => {
      events.push("deliver");
    });
    const recordInboundSession = createRecordInboundSession(events);
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch(events);

    const result = await dispatchTestAssembledTurn({
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      ctxPayload: createCtx(),
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver },
      record: {
        onRecordError: vi.fn(),
      },
    });

    expectDispatched(result);
    expect(result.dispatchResult?.counts.final).toBe(1);
    expect(events).toEqual(["record", "dispatch", "deliver"]);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const [recordRequest] = (recordInboundSession as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown as [{ sessionKey?: string; storePath?: string }];
    expect(recordRequest.sessionKey).toBe("agent:main:test:peer");
    expect(recordRequest.storePath).toBe("/tmp/sessions.json");
    expect(deliver).toHaveBeenCalledWith({ text: "reply" }, { kind: "final" });
  });

  it("can record a target session without changing the command dispatch session", async () => {
    const log = vi.fn();
    const recordInboundSession = createRecordInboundSession();
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();
    const commandSessionKey = "agent:main:command:telegram:42";
    const targetSessionKey = "agent:main:telegram:group:42:topic:7";

    const result = await dispatchTestAssembledTurn({
      channel: "telegram",
      routeSessionKey: commandSessionKey,
      ctxPayload: createCtx({
        AgentId: "main",
        SessionKey: commandSessionKey,
        CommandTargetSessionKey: targetSessionKey,
        SessionTranscriptContext: { historyLimit: 1 },
      }),
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver: async () => ({ visibleReplySent: true }) },
      record: { sessionKey: targetSessionKey },
      log,
    });

    expectDispatched(result);
    expect(result.routeSessionKey).toBe(commandSessionKey);
    expect(result.ctxPayload.SessionKey).toBe(commandSessionKey);
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: targetSessionKey }),
    );
    expect(readRecentUserAssistantTextForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: targetSessionKey,
        storePath: "/tmp/sessions.json",
      }),
    );
    const recordEvents = log.mock.calls
      .map(([event]) => event as TurnLogEvent)
      .filter((event) => event.stage === "record");
    expect(recordEvents).toEqual([
      expect.objectContaining({ event: "start", sessionKey: targetSessionKey }),
      expect.objectContaining({ event: "done", sessionKey: targetSessionKey }),
    ]);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ SessionKey: commandSessionKey }),
      }),
    );
  });

  it("rejects an empty explicit record session before recording or dispatch", async () => {
    const recordInboundSession = createRecordInboundSession();
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    await expect(
      dispatchTestAssembledTurn({
        channel: "telegram",
        routeSessionKey: "agent:main:command:telegram:42",
        ctxPayload: createCtx(),
        recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher,
        delivery: { deliver: async () => ({ visibleReplySent: true }) },
        record: { sessionKey: "  " },
      }),
    ).rejects.toThrow("Channel turn record.sessionKey must be non-empty.");
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("rejects surrounding whitespace in an explicit record session", async () => {
    await expect(
      dispatchTestAssembledTurn({
        channel: "telegram",
        routeSessionKey: "agent:main:command:telegram:42",
        ctxPayload: createCtx(),
        recordInboundSession: createRecordInboundSession(),
        dispatchReplyWithBufferedBlockDispatcher: createDispatch(),
        delivery: { deliver: async () => ({ visibleReplySent: true }) },
        record: { sessionKey: " agent:main:telegram:group:42 " },
      }),
    ).rejects.toThrow("Channel turn record.sessionKey must not include surrounding whitespace.");
  });

  it("runs prepared dispatches after recording session metadata", async () => {
    const events: string[] = [];
    const log = vi.fn();
    const recordInboundSession = createRecordInboundSession(events);
    const runDispatch = vi.fn(async () => {
      events.push("dispatch");
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
        settledReceipt: visibleFinalReceipt,
      };
    });

    const result = await runPreparedChannelTurn({
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx(),
      recordInboundSession,
      runDispatch,
      log,
      messageId: "msg-1",
      record: {
        onRecordError: vi.fn(),
      },
    });

    expect(events).toEqual(["record", "dispatch"]);
    expectDispatched(result);
    expect(result.dispatchResult?.queuedFinal).toBe(true);
    expect(loggedEvents(log)).toEqual([
      { stage: "record", event: "start", messageId: "msg-1" },
      { stage: "record", event: "done", messageId: "msg-1" },
      { stage: "dispatch", event: "start", messageId: "msg-1" },
      { stage: "dispatch", event: "done", messageId: "msg-1" },
    ]);
  });

  it("keeps channel message, harness, usage, and model diagnostics in one trace scope", async () => {
    const diagnostics: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (
        event.type === "message.processed" ||
        event.type === "harness.run.started" ||
        event.type === "model.usage" ||
        event.type === "model.call.started" ||
        event.type === "log.record"
      ) {
        diagnostics.push(event);
      }
    });
    const recordInboundSession = createRecordInboundSession();
    const runDispatch = vi.fn(async () => {
      const messageTrace = getActiveDiagnosticTraceContext();
      if (!messageTrace) {
        throw new Error("expected active channel message trace");
      }
      const harnessTrace = freezeDiagnosticTraceContext(
        createChildDiagnosticTraceContext(messageTrace),
      );
      const runTrace = freezeDiagnosticTraceContext(
        createChildDiagnosticTraceContext(harnessTrace),
      );
      const modelCallTrace = freezeDiagnosticTraceContext(
        createChildDiagnosticTraceContext(runTrace),
      );
      const usageTrace = freezeDiagnosticTraceContext(
        createChildDiagnosticTraceContext(harnessTrace),
      );
      getChildLogger({ subsystem: "diagnostic" }).info({ runId: "run-1" }, "channel lifecycle log");

      emitTrustedDiagnosticEvent({
        type: "harness.run.started",
        runId: "run-1",
        harnessId: "codex",
        pluginId: "codex",
        provider: "openai",
        model: "gpt-5.5",
        channel: "slack",
        trace: harnessTrace,
      });
      emitTrustedDiagnosticEvent({
        type: "model.call.started",
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.5",
        api: "openai-codex-responses",
        transport: "stdio",
        trace: modelCallTrace,
      });
      emitTrustedDiagnosticEvent({
        type: "model.usage",
        sessionKey: "agent:main:slack:channel:c1",
        channel: "slack",
        agentId: "main",
        provider: "openai",
        model: "gpt-5.5",
        usage: { input: 10, output: 5, total: 15 },
        durationMs: 25,
        trace: usageTrace,
      });
      logMessageProcessed({
        channel: "slack",
        messageId: "msg-1",
        chatId: "c1",
        sessionKey: "agent:main:slack:channel:c1",
        durationMs: 50,
        outcome: "completed",
      });
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    });

    try {
      await runPreparedChannelTurn({
        channel: "slack",
        routeSessionKey: "agent:main:slack:channel:c1",
        storePath: "/tmp/sessions.json",
        ctxPayload: createCtx({ SessionKey: "agent:main:slack:channel:c1" }),
        recordInboundSession,
        runDispatch,
        messageId: "msg-1",
      });
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribe();
    }

    const message = diagnostics.find((event) => event.type === "message.processed");
    const harness = diagnostics.find((event) => event.type === "harness.run.started");
    const usage = diagnostics.find((event) => event.type === "model.usage");
    const modelCall = diagnostics.find((event) => event.type === "model.call.started");
    const logRecord = diagnostics.find(
      (event) => event.type === "log.record" && event.message === "channel lifecycle log",
    );
    const traceId = message?.trace?.traceId;

    expect(traceId).toBeTruthy();
    expect(harness?.trace?.traceId).toBe(traceId);
    expect(usage?.trace?.traceId).toBe(traceId);
    expect(modelCall?.trace?.traceId).toBe(traceId);
    expect(harness?.trace?.parentSpanId).toBe(message?.trace?.spanId);
    expect(usage?.trace?.parentSpanId).toBe(harness?.trace?.spanId);
    expect(modelCall?.trace?.parentSpanId).toBeTruthy();
    expect(modelCall?.trace?.parentSpanId).not.toBe(message?.trace?.spanId);
    expect(logRecord?.trace?.traceId).toBe(traceId);
  });

  it("logs a warning when a visible prepared dispatch queues no payloads", async () => {
    const log = vi.fn();
    const runDispatch = vi.fn(async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    }));

    const result = await runTestPreparedChannelTurn({
      runDispatch,
      log,
      messageId: "msg-zero",
    });

    expectDispatched(result);
    expect(result.dispatchResult?.queuedFinal).toBe(false);
    expect(log.mock.calls).toContainEqual([
      expect.objectContaining({
        stage: "dispatch",
        event: "warning",
        messageId: "msg-zero",
        reason: "zero-count-visible-dispatch",
      }),
    ]);
    // A dispatch that recorded no processed outcome reads as unknown in the
    // core-owned warn line.
    expect(subsystemWarn).toHaveBeenCalledWith(expect.stringContaining("cause=unknown"));
  });

  it("attributes the zero-count warn line with the dispatch's processed outcome", async () => {
    const log = vi.fn();
    // The dispatch pipeline records its terminal branch through the kernel's
    // sink instead of widening the plugin-visible result contract.
    const runDispatch = vi.fn(async () => {
      noteDispatchProcessedOutcome({ outcome: "skipped", reason: "duplicate" });
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    });

    const result = await runTestPreparedChannelTurn({
      runDispatch,
      log,
      messageId: "msg-zero-cause",
    });

    expectDispatched(result);
    expect(subsystemWarn).toHaveBeenCalledWith(expect.stringContaining("messageId=msg-zero-cause"));
    expect(subsystemWarn).toHaveBeenCalledWith(expect.stringContaining("cause=skipped:duplicate"));
    // The channel log event is a plugin contract; the attribution must stay out of it.
    const warning = log.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .find((event) => event.reason === "zero-count-visible-dispatch");
    expect(warning).toBeDefined();
    expect(warning).not.toHaveProperty("cause");
  });

  it.each([
    {
      name: "accepts compatibility counters when no receipt exists",
      dispatchResult: { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
      warns: false,
    },
    {
      name: "keeps a non-visible settled receipt authoritative",
      dispatchResult: {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
        settledReceipt: {
          anyVisibleDelivered: false,
          counts: { final: { delivered: 0, failedAfterSend: 0 } },
        },
      },
      warns: true,
    },
  ])("$name", async ({ dispatchResult, warns }) => {
    const log = vi.fn();

    await runTestPreparedChannelTurn({
      runDispatch: vi.fn(async () => dispatchResult),
      log,
      messageId: "msg-compat",
    });

    expect(log.mock.calls.some(([event]) => event.reason === "zero-count-visible-dispatch")).toBe(
      warns,
    );
  });

  it("does not warn for observed-path deliveries with zero queued counts", async () => {
    const log = vi.fn();
    // Observed-delivery path: queuedFinal false and all counts zero, but the reply was
    // delivered via observedReplyDelivery and must not trip the silent-drop sentinel.
    const runDispatch = vi.fn(async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      observedReplyDelivery: true,
    }));

    const result = await runTestPreparedChannelTurn({
      runDispatch,
      log,
      messageId: "msg-observed",
    });

    expectDispatched(result);
    expect(result.dispatchResult?.observedReplyDelivery).toBe(true);
    expect(log.mock.calls).not.toContainEqual([
      expect.objectContaining({ reason: "zero-count-visible-dispatch" }),
    ]);
  });

  it("does not warn when an active run accepts deferred steer ownership", async () => {
    const log = vi.fn();
    const runDispatch = vi.fn(async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      deferredToActiveRun: "steer" as const,
    }));

    const result = await runTestPreparedChannelTurn({
      runDispatch,
      log,
      messageId: "msg-deferred-steer",
    });

    expectDispatched(result);
    expect(result.dispatchResult?.deferredToActiveRun).toBe("steer");
    expect(log.mock.calls).not.toContainEqual([
      expect.objectContaining({ reason: "zero-count-visible-dispatch" }),
    ]);
  });
});
