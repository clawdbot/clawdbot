import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RecordInboundSession } from "../session.types.js";
import {
  createNoopChannelTurnDeliveryAdapter,
  dispatchAssembledChannelTurn,
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
  runPreparedChannelTurn,
  runChannelTurn,
} from "./kernel.js";

const deliverOutboundPayloads = vi.hoisted(() => vi.fn());
const resolveOutboundDurableFinalDeliverySupport = vi.hoisted(() => vi.fn());

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/outbound/deliver.js")>();
  return {
    ...actual,
    deliverOutboundPayloads,
    resolveOutboundDurableFinalDeliverySupport,
  };
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
    };
  }) as DispatchReplyWithBufferedBlockDispatcher;
}

describe("channel turn kernel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
  });

  it("routes assembled final replies through durable outbound delivery", async () => {
    deliverOutboundPayloads.mockResolvedValueOnce([{ messageId: "tg-1" }]);
    const deliver = vi.fn();
    const recordInboundSession = createRecordInboundSession();
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    const result = await dispatchAssembledChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "acct",
      agentId: "main",
      routeSessionKey: "agent:main:telegram:peer",
      storePath: "/tmp/sessions.json",
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
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        accountId: "acct",
        payloads: [expect.objectContaining({ text: "reply" })],
        queuePolicy: "best_effort",
        replyToMode: "first",
        threadId: 777,
        session: expect.objectContaining({
          key: "agent:main:test:peer",
          agentId: "main",
          requesterAccountId: "acct",
          requesterSenderId: "sender-1",
          conversationType: "group",
        }),
      }),
    );
    expect(resolveOutboundDurableFinalDeliverySupport).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        requirements: {
          text: true,
          thread: true,
          messageSendingHooks: true,
        },
      }),
    );
  });

  it("returns durable delivery result to the buffered dispatcher", async () => {
    deliverOutboundPayloads.mockResolvedValueOnce([{ messageId: "tg-1" }, { messageId: "tg-2" }]);
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

    await dispatchAssembledChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "acct",
      agentId: "main",
      routeSessionKey: "agent:main:telegram:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver: vi.fn(), durable: { replyToMode: "first" } },
    });

    expect(deliveredResult).toEqual(
      expect.objectContaining({
        messageIds: ["tg-1", "tg-2"],
        receipt: expect.objectContaining({
          platformMessageIds: ["tg-1", "tg-2"],
        }),
        visibleReplySent: true,
      }),
    );
  });

  it("prepares payloads before durable enqueue and observes handled delivery", async () => {
    deliverOutboundPayloads.mockResolvedValueOnce([{ messageId: "tlon-1" }]);
    const onDelivered = vi.fn();
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    await dispatchAssembledChannelTurn({
      cfg,
      channel: "tlon",
      accountId: "acct",
      agentId: "main",
      routeSessionKey: "agent:main:tlon:peer",
      storePath: "/tmp/sessions.json",
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
        onDelivered,
      },
    });

    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [expect.objectContaining({ text: "reply\n\n_[Generated by test]_" })],
      }),
    );
    expect(resolveOutboundDurableFinalDeliverySupport).toHaveBeenCalledWith(
      expect.objectContaining({
        requirements: {
          text: true,
        },
      }),
    );
    expect(onDelivered).toHaveBeenCalledWith(
      expect.objectContaining({ text: "reply\n\n_[Generated by test]_" }),
      { kind: "final" },
      expect.objectContaining({ visibleReplySent: true }),
    );
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

    await dispatchAssembledChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "acct",
      agentId: "main",
      routeSessionKey: "agent:main:telegram:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver, durable: { replyToMode: "first" } },
    });

    expect(resolveOutboundDurableFinalDeliverySupport).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        requirements: {
          text: true,
          messageSendingHooks: true,
        },
      }),
    );
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith({ text: "reply" }, { kind: "final" });
    expect(deliveredResult).toEqual(
      expect.objectContaining({
        messageIds: ["legacy-1"],
        visibleReplySent: true,
      }),
    );
  });

  it("treats durable outbound support preflight failures as terminal", async () => {
    resolveOutboundDurableFinalDeliverySupport.mockRejectedValueOnce(new Error("preflight failed"));
    const deliver = vi.fn(async () => ({ messageIds: ["legacy-1"], visibleReplySent: true }));
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    await expect(
      dispatchAssembledChannelTurn({
        cfg,
        channel: "telegram",
        accountId: "acct",
        agentId: "main",
        routeSessionKey: "agent:main:telegram:peer",
        storePath: "/tmp/sessions.json",
        ctxPayload: createCtx({ To: "123", OriginatingTo: "123" }),
        recordInboundSession: createRecordInboundSession(),
        dispatchReplyWithBufferedBlockDispatcher,
        delivery: { deliver, durable: { replyToMode: "first" } },
      }),
    ).rejects.toThrow("preflight failed");

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
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

    await dispatchAssembledChannelTurn({
      cfg,
      channel: "test",
      agentId: "main",
      routeSessionKey: "agent:main:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx(),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        durable: false,
        deliver: vi.fn(async () => ({ messageIds: ["local-1"], visibleReplySent: true })),
      },
    });

    expect(deliveredResult).toEqual(
      expect.objectContaining({
        messageIds: ["local-1"],
        visibleReplySent: true,
      }),
    );
  });

  it("does not use durable outbound delivery when durable options are omitted", async () => {
    const deliver = vi.fn(async () => ({ messageIds: ["local-1"], visibleReplySent: true }));
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();

    await dispatchAssembledChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "acct",
      agentId: "main",
      routeSessionKey: "agent:main:telegram:peer",
      storePath: "/tmp/sessions.json",
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

    await dispatchAssembledChannelTurn({
      cfg,
      channel: "test",
      agentId: "main",
      routeSessionKey: "agent:main:test:peer",
      storePath: "/tmp/sessions.json",
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
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "reply!" },
      { kind: "final" },
      expect.objectContaining({ messageIds: ["local-1"], visibleReplySent: true }),
    );
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

    await dispatchAssembledChannelTurn({
      cfg,
      channel: "test",
      agentId: "main",
      routeSessionKey: "agent:main:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx(),
      recordInboundSession: createRecordInboundSession(),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver },
      replyPipeline: { transformReplyPayload },
    });

    expect(transformReplyPayload).toHaveBeenCalledWith({ text: "reply" });
    expect(deliver).toHaveBeenCalledWith({ text: "reply from pipeline" }, { kind: "final" });
  });

  it("records inbound session before dispatching delivery", async () => {
    const events: string[] = [];
    const deliver = vi.fn(async () => {
      events.push("deliver");
    });
    const recordInboundSession = createRecordInboundSession(events);
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch(events);

    const result = await dispatchAssembledChannelTurn({
      cfg,
      channel: "test",
      agentId: "main",
      routeSessionKey: "agent:main:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx(),
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver },
      record: {
        onRecordError: vi.fn(),
      },
    });

    expect(result.dispatched).toBe(true);
    expect(result.dispatchResult?.counts.final).toBe(1);
    expect(events).toEqual(["record", "dispatch", "deliver"]);
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:test:peer",
        storePath: "/tmp/sessions.json",
      }),
    );
    expect(deliver).toHaveBeenCalledWith({ text: "reply" }, { kind: "final" });
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
    expect(result.dispatchResult?.queuedFinal).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "record", event: "start", messageId: "msg-1" }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "record", event: "done", messageId: "msg-1" }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "dispatch", event: "start", messageId: "msg-1" }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "dispatch", event: "done", messageId: "msg-1" }),
    );
  });

  it("suppresses direct prepared dispatches for observe-only admission", async () => {
    const events: string[] = [];
    const recordInboundSession = createRecordInboundSession(events);
    const runDispatch = vi.fn(async () => {
      events.push("dispatch");
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    });
    const observeOnlyDispatchResult = {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    };

    const result = await runPreparedChannelTurn({
      channel: "test",
      routeSessionKey: "agent:observer:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx({ SessionKey: "agent:observer:test:peer" }),
      recordInboundSession,
      runDispatch,
      observeOnlyDispatchResult,
      admission: { kind: "observeOnly", reason: "broadcast-observer" },
    });

    expect(events).toEqual(["record"]);
    expect(runDispatch).not.toHaveBeenCalled();
    expect(result.admission).toEqual({ kind: "observeOnly", reason: "broadcast-observer" });
    expect(result.dispatched).toBe(true);
    expect(result.dispatchResult).toBe(observeOnlyDispatchResult);
    expect(hasFinalChannelTurnDispatch(result.dispatchResult)).toBe(false);
  });

  it("clears pending group history after a successful prepared turn", async () => {
    const historyMap = new Map([["room-1", [{ sender: "User", body: "queued before reply" }]]]);

    await runPreparedChannelTurn({
      channel: "test",
      routeSessionKey: "agent:main:test:group:room-1",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx(),
      recordInboundSession: createRecordInboundSession(),
      runDispatch: vi.fn(async () => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      })),
      history: {
        isGroup: true,
        historyKey: "room-1",
        historyMap,
        limit: 50,
      },
    });

    expect(historyMap.get("room-1")).toEqual([]);
  });

  it("cleans up pre-created dispatchers when session recording fails", async () => {
    const events: string[] = [];
    const recordError = new Error("session store failed");
    const log = vi.fn();
    const recordInboundSession = vi.fn(async () => {
      events.push("record");
      throw recordError;
    }) as unknown as RecordInboundSession;
    const runDispatch = vi.fn();
    const onPreDispatchFailure = vi.fn(async () => {
      events.push("cleanup");
    });

    await expect(
      runPreparedChannelTurn({
        channel: "test",
        routeSessionKey: "agent:main:test:peer",
        storePath: "/tmp/sessions.json",
        ctxPayload: createCtx(),
        recordInboundSession,
        onPreDispatchFailure,
        runDispatch,
        log,
        record: {
          onRecordError: vi.fn(),
        },
      }),
    ).rejects.toThrow(recordError);

    expect(events).toEqual(["record", "cleanup"]);
    expect(runDispatch).not.toHaveBeenCalled();
    expect(onPreDispatchFailure).toHaveBeenCalledWith(recordError);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ stage: "record", event: "error" }));
  });

  it("normalizes visible dispatch checks", () => {
    expect(hasVisibleChannelTurnDispatch(undefined)).toBe(false);
    expect(
      hasVisibleChannelTurnDispatch({
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 0 },
      }),
    ).toBe(true);
    expect(
      hasVisibleChannelTurnDispatch(undefined, {
        observedReplyDelivery: true,
      }),
    ).toBe(true);
    expect(
      hasFinalChannelTurnDispatch({
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 0 },
      }),
    ).toBe(false);
    expect(resolveChannelTurnDispatchCounts(undefined)).toEqual({
      tool: 0,
      block: 0,
      final: 0,
    });
  });

  it("drops when ingest returns null", async () => {
    const result = await runChannelTurn({
      channel: "test",
      raw: {},
      adapter: {
        ingest: () => null,
        resolveTurn: vi.fn(),
      },
    });

    expect(result).toEqual({
      admission: { kind: "drop", reason: "ingest-null" },
      dispatched: false,
    });
  });

  it("handles non-turn event classes without dispatch", async () => {
    const resolveTurn = vi.fn();
    const result = await runChannelTurn({
      channel: "test",
      raw: {},
      adapter: {
        ingest: () => ({ id: "evt-1", rawText: "" }),
        classify: () => ({ kind: "reaction", canStartAgentTurn: false }),
        resolveTurn,
      },
    });

    expect(result.admission).toEqual({ kind: "handled", reason: "event:reaction" });
    expect(result.dispatched).toBe(false);
    expect(resolveTurn).not.toHaveBeenCalled();
  });

  it("stops on preflight admission drops", async () => {
    const resolveTurn = vi.fn();
    const result = await runChannelTurn({
      channel: "test",
      raw: {},
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        preflight: () => ({ kind: "drop", reason: "missing-mention", recordHistory: true }),
        resolveTurn,
      },
    });

    expect(result.admission).toEqual({
      kind: "drop",
      reason: "missing-mention",
      recordHistory: true,
    });
    expect(result.dispatched).toBe(false);
    expect(resolveTurn).not.toHaveBeenCalled();
  });

  it("runs observe-only preflights through resolve, record, dispatch, and finalize without visible delivery", async () => {
    const events: string[] = [];
    const deliver = vi.fn();
    const onFinalize = vi.fn();
    const result = await runChannelTurn({
      channel: "test",
      raw: {},
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "observe" }),
        preflight: () => ({ kind: "observeOnly", reason: "broadcast-observer" }),
        resolveTurn: () => ({
          cfg,
          channel: "test",
          agentId: "observer",
          routeSessionKey: "agent:observer:test:peer",
          storePath: "/tmp/sessions.json",
          ctxPayload: createCtx({ SessionKey: "agent:observer:test:peer" }),
          recordInboundSession: createRecordInboundSession(events),
          dispatchReplyWithBufferedBlockDispatcher: createDispatch(events),
          delivery: { deliver },
          record: {
            onRecordError: vi.fn(),
          },
        }),
        onFinalize,
      },
    });

    expect(result.admission).toEqual({
      kind: "observeOnly",
      reason: "broadcast-observer",
    });
    expect(result.dispatched).toBe(true);
    expect(events).toEqual(["record", "dispatch"]);
    expect(deliver).not.toHaveBeenCalled();
    expect(onFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        admission: { kind: "observeOnly", reason: "broadcast-observer" },
        dispatched: true,
        routeSessionKey: "agent:observer:test:peer",
      }),
    );
  });

  it("runs custom prepared dispatch from a full turn adapter", async () => {
    const events: string[] = [];
    const result = await runChannelTurn({
      channel: "test",
      raw: { id: "msg-1", text: "hello" },
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        resolveTurn: () => ({
          channel: "test",
          routeSessionKey: "agent:main:test:peer",
          storePath: "/tmp/sessions.json",
          ctxPayload: createCtx(),
          recordInboundSession: createRecordInboundSession(events),
          runDispatch: async () => {
            events.push("custom-dispatch");
            return {
              queuedFinal: true,
              counts: { tool: 0, block: 0, final: 1 },
            };
          },
        }),
      },
    });

    expect(events).toEqual(["record", "custom-dispatch"]);
    expect(result.dispatched).toBe(true);
    if (!result.dispatched) {
      throw new Error("expected dispatch");
    }
    expect(result.dispatchResult.queuedFinal).toBe(true);
  });

  it("suppresses prepared dispatch for observe-only full turns", async () => {
    const events: string[] = [];
    const onFinalize = vi.fn();
    const runDispatch = vi.fn(async () => {
      events.push("custom-dispatch");
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    });
    const result = await runChannelTurn({
      channel: "test",
      raw: { id: "msg-1", text: "hello" },
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        preflight: () => ({ kind: "observeOnly", reason: "broadcast-observer" }),
        resolveTurn: () => ({
          channel: "test",
          routeSessionKey: "agent:observer:test:peer",
          storePath: "/tmp/sessions.json",
          ctxPayload: createCtx({ SessionKey: "agent:observer:test:peer" }),
          recordInboundSession: createRecordInboundSession(events),
          runDispatch,
        }),
        onFinalize,
      },
    });

    expect(result.admission).toEqual({ kind: "observeOnly", reason: "broadcast-observer" });
    expect(result.dispatched).toBe(true);
    expect(events).toEqual(["record"]);
    expect(runDispatch).not.toHaveBeenCalled();
    if (!result.dispatched) {
      throw new Error("expected dispatch");
    }
    expect(hasFinalChannelTurnDispatch(result.dispatchResult)).toBe(false);
    expect(onFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        admission: { kind: "observeOnly", reason: "broadcast-observer" },
        dispatched: true,
      }),
    );
  });

  it("finalizes failed dispatches before rethrowing", async () => {
    const onFinalize = vi.fn();
    const dispatchError = new Error("dispatch failed");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => {
      throw dispatchError;
    }) as unknown as DispatchReplyWithBufferedBlockDispatcher;

    await expect(
      runChannelTurn({
        channel: "test",
        raw: {},
        adapter: {
          ingest: () => ({ id: "msg-1", rawText: "hello" }),
          resolveTurn: () => ({
            cfg,
            channel: "test",
            agentId: "main",
            routeSessionKey: "agent:main:test:peer",
            storePath: "/tmp/sessions.json",
            ctxPayload: createCtx(),
            recordInboundSession: createRecordInboundSession(),
            dispatchReplyWithBufferedBlockDispatcher,
            delivery: createNoopChannelTurnDeliveryAdapter(),
            record: {
              onRecordError: vi.fn(),
            },
          }),
          onFinalize,
        },
      }),
    ).rejects.toThrow(dispatchError);

    expect(onFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        admission: { kind: "dispatch" },
        dispatched: false,
        routeSessionKey: "agent:main:test:peer",
      }),
    );
  });
});
