import { describe, expect, it, vi } from "vitest";
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
