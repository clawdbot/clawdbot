// Channel turn finalize tests cover orchestration, dispatch, and completion behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTestChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.types.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import {
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "../message-access/admission-evidence.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import { recordOutboundMessageIdentity } from "../message/outbound-echo.js";
import type { RecordInboundSession } from "../session.types.js";
import {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatchFromReceipt as hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
} from "./dispatch-result.js";
import { runPreparedChannelTurn } from "./execution.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";
import { runChannelTurn } from "./run-channel-turn.js";
import type { ChannelTurnHistoryFinalizeOptions, ChannelTurnResult } from "./types.js";

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
  return vi.fn<RecordInboundSession>(async () => {
    events.push("record");
  });
}

function createPendingGroupHistory() {
  const historyKey = "group-room-1";
  const historyMap = new Map<string, HistoryEntry[]>([
    [historyKey, [{ sender: "Alice", body: "earlier group message", timestamp: 1 }]],
  ]);
  const history = {
    isGroup: true,
    historyKey,
    historyMap,
    limit: 50,
  } satisfies ChannelTurnHistoryFinalizeOptions;
  return { history, historyMap };
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

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

type FinalizeResult = {
  admission?: unknown;
  dispatched?: boolean;
  routeSessionKey?: string;
};

type TurnLogEvent = {
  event?: string;
  messageId?: string;
  stage?: string;
};

function finalizeResult(value: unknown): FinalizeResult {
  return value as FinalizeResult;
}

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

describe("channel turn finalize", () => {
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

  it("drops direct prepared turns with bot-loop protection before record and dispatch", async () => {
    const events: string[] = [];
    const log = vi.fn();
    const historyMap = new Map<string, HistoryEntry[]>([
      ["room", [{ sender: "User", body: "queued before suppression" }]],
    ]);
    const recordInboundSession = createRecordInboundSession(events);
    const runDispatch = vi.fn(async () => {
      events.push("dispatch");
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    });
    const onDispatchSkipped = vi.fn();
    const botLoopProtection = {
      scopeId: "prepared-loop-test",
      conversationId: "room",
      senderId: "bot-a",
      receiverId: "bot-b",
      config: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
      defaultEnabled: true,
    };

    const first = await runPreparedChannelTurn({
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx(),
      recordInboundSession,
      runDispatch,
      runDispatchLifecycle: {
        turnAdoptionLifecycle: undefined,
        onDispatchSkipped,
      },
      botLoopProtection: { ...botLoopProtection, nowMs: 1_000 },
    });
    const second = await runPreparedChannelTurn({
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx(),
      recordInboundSession,
      runDispatch,
      runDispatchLifecycle: {
        turnAdoptionLifecycle: undefined,
        onDispatchSkipped,
      },
      log,
      messageId: "msg-loop",
      botLoopProtection: { ...botLoopProtection, nowMs: 1_001 },
      history: {
        isGroup: true,
        historyKey: "room",
        historyMap,
        limit: 50,
      },
    });

    expect(first.dispatched).toBe(true);
    expect(second).toMatchObject({
      admission: { kind: "drop", reason: "bot-loop-protection" },
      dispatched: false,
      routeSessionKey: "agent:main:test:peer",
    });
    expect(events).toEqual(["record", "dispatch"]);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(runDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatchSkipped).toHaveBeenCalledWith("botLoopProtection");
    expect(historyMap.get("room")).toStrictEqual([]);
    expect(loggedEvents(log)).toEqual([
      { stage: "authorize", event: "drop", messageId: "msg-loop" },
    ]);
  });

  it("drops a recorded Discord webhook echo after thread unbind before record and dispatch", async () => {
    const recordInboundSession = createRecordInboundSession();
    const dispatchReplyWithBufferedBlockDispatcher = createDispatch();
    const deliver = vi.fn();
    const onAdopted = vi.fn(async () => {});
    const log = vi.fn();
    const historyMap = new Map([["thread-1", [{ sender: "Bot", body: "echo" }]]]);
    recordOutboundMessageIdentity({
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      sourceId: "webhook-1",
    });

    // Unbinding removes Discord's thread route, not the core-owned outbound identity.
    const result = await dispatchTestAssembledTurn({
      channel: "discord",
      accountId: "default",
      routeSessionKey: "agent:main:discord:channel:thread-1",
      ctxPayload: createCtx({
        Provider: "discord",
        Surface: "discord",
        ChatId: "thread-1",
        MessageSid: "webhook-message-1",
      }),
      outboundEchoSourceId: "webhook-1",
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver },
      turnAdoptionLifecycle: { onAdopted },
      history: {
        isGroup: true,
        historyKey: "thread-1",
        historyMap,
        limit: 50,
      },
      log,
    });

    expect(result).toMatchObject({
      admission: { kind: "drop", reason: "outbound-echo" },
      dispatched: false,
      routeSessionKey: "agent:main:discord:channel:thread-1",
    });
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(historyMap.get("thread-1")).toStrictEqual([]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "authorize",
        event: "drop",
        reason: "outbound-echo",
      }),
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
    const onDispatchSkipped = vi.fn();

    const result = await runPreparedChannelTurn({
      channel: "test",
      routeSessionKey: "agent:observer:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx({ SessionKey: "agent:observer:test:peer" }),
      recordInboundSession,
      runDispatch,
      runDispatchLifecycle: {
        turnAdoptionLifecycle: undefined,
        onDispatchSkipped,
      },
      observeOnlyDispatchResult,
      admission: { kind: "observeOnly", reason: "broadcast-observer" },
    });

    expect(events).toEqual(["record"]);
    expect(runDispatch).not.toHaveBeenCalled();
    expect(onDispatchSkipped).toHaveBeenCalledWith("observeOnly");
    expect(result.admission).toEqual({ kind: "observeOnly", reason: "broadcast-observer" });
    expectDispatched(result);
    expect(result.dispatchResult).toBe(observeOnlyDispatchResult);
    expect(hasFinalChannelTurnDispatch(result.dispatchResult)).toBe(false);
  });

  it("uses noop delivery for direct assembled observe-only dispatch", async () => {
    const events: string[] = [];
    const deliver = vi.fn(async () => {
      events.push("deliver");
      return { visibleReplySent: true };
    });

    const result = await dispatchAssembledChannelTurn({
      cfg,
      channel: "test",
      agentId: "observer",
      routeSessionKey: "agent:observer:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx({ SessionKey: "agent:observer:test:peer" }),
      recordInboundSession: createRecordInboundSession(events),
      dispatchReplyWithBufferedBlockDispatcher: createDispatch(events),
      delivery: { deliver },
      admission: { kind: "observeOnly", reason: "broadcast-observer" },
    });

    expect(events).toEqual(["record", "dispatch"]);
    expect(deliver).not.toHaveBeenCalled();
    expect(result.admission).toEqual({ kind: "observeOnly", reason: "broadcast-observer" });
    expect(result.dispatched).toBe(true);
    if (!result.dispatched) {
      throw new Error("expected dispatch");
    }
    expect(resolveChannelTurnDispatchCounts(result.dispatchResult)).toEqual({
      tool: 0,
      block: 0,
      final: 0,
    });
  });

  it("clears pending group history after a successful prepared turn", async () => {
    const { history, historyMap } = createPendingGroupHistory();

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
      history,
    });

    expect(historyMap.get(history.historyKey)).toStrictEqual([]);
  });

  it("clears pending group history when the explicit record session key is invalid", async () => {
    const { history, historyMap } = createPendingGroupHistory();
    const runDispatch = vi.fn();

    await expect(
      runPreparedChannelTurn({
        channel: "test",
        routeSessionKey: "agent:main:test:peer",
        storePath: "/tmp/sessions.json",
        ctxPayload: createCtx(),
        recordInboundSession: createRecordInboundSession(),
        runDispatch,
        record: { sessionKey: "  " },
        history,
      }),
    ).rejects.toThrow("Channel turn record.sessionKey must be non-empty.");

    expect(runDispatch).not.toHaveBeenCalled();
    expect(historyMap.get(history.historyKey)).toStrictEqual([]);
  });

  it("clears pending group history when transcript-context merge fails", async () => {
    const { history, historyMap } = createPendingGroupHistory();
    const transcriptError = new Error("transcript read failed");
    const recordInboundSession = createRecordInboundSession();
    readRecentUserAssistantTextForSession.mockRejectedValueOnce(transcriptError);

    await expect(
      runPreparedChannelTurn({
        channel: "test",
        routeSessionKey: "agent:main:test:peer",
        storePath: "/tmp/sessions.json",
        ctxPayload: createCtx({
          AgentId: "main",
          SessionTranscriptContext: { historyLimit: 1 },
        }),
        recordInboundSession,
        runDispatch: vi.fn(),
        history,
      }),
    ).rejects.toThrow(transcriptError);

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(historyMap.get(history.historyKey)).toStrictEqual([]);
  });

  it("cleans up pre-created dispatchers when session recording fails", async () => {
    const { history, historyMap } = createPendingGroupHistory();
    const events: string[] = [];
    const recordError = new Error("session store failed");
    const log = vi.fn();
    const recordInboundSession = vi.fn<RecordInboundSession>(async () => {
      events.push("record");
      throw recordError;
    });
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
        history,
      }),
    ).rejects.toThrow(recordError);

    expect(events).toEqual(["record", "cleanup"]);
    expect(runDispatch).not.toHaveBeenCalled();
    expect(onPreDispatchFailure).toHaveBeenCalledWith(recordError);
    expect(historyMap.get(history.historyKey)).toStrictEqual([]);
    expect(loggedEvents(log)).toEqual([
      { stage: "record", event: "start" },
      { stage: "record", event: "error" },
    ]);
  });

  it("clears pending group history when dispatch fails", async () => {
    const { history, historyMap } = createPendingGroupHistory();
    const dispatchError = new Error("dispatch failed");
    const recordInboundSession = createRecordInboundSession();

    await expect(
      runPreparedChannelTurn({
        channel: "test",
        routeSessionKey: "agent:main:test:peer",
        storePath: "/tmp/sessions.json",
        ctxPayload: createCtx(),
        recordInboundSession,
        runDispatch: vi.fn(async () => {
          throw dispatchError;
        }),
        history,
      }),
    ).rejects.toThrow(dispatchError);

    expect(recordInboundSession).toHaveBeenCalledOnce();
    expect(historyMap.get(history.historyKey)).toStrictEqual([]);
  });

  it("runs afterRecord only after session recording succeeds and before dispatch", async () => {
    const events: string[] = [];
    await runPreparedChannelTurn({
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      storePath: "/tmp/sessions.json",
      ctxPayload: createCtx(),
      recordInboundSession: createRecordInboundSession(events),
      afterRecord: vi.fn(async () => {
        events.push("afterRecord");
      }),
      runDispatch: vi.fn(async () => {
        events.push("dispatch");
        return { visibleReplySent: true };
      }),
    });

    expect(events).toEqual(["record", "afterRecord", "dispatch"]);
  });

  it("threads turnAdoptionLifecycle into assembled reply options and fires after recovery persist attempt", async () => {
    const events: string[] = [];
    const onAdopted = vi.fn(async () => {
      events.push("adopted");
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async (params: Parameters<DispatchReplyWithBufferedBlockDispatcher>[0]) => {
        events.push("dispatch-start");
        // Persist attempt completes before adoption (agent-runner contract).
        events.push("recovery-persist");
        await params.replyOptions?.turnAdoptionLifecycle?.onAdopted();
        events.push("settle");
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
      recordInboundSession: createRecordInboundSession(events),
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        deliver: vi.fn(async () => undefined),
      },
      turnAdoptionLifecycle: { onAdopted },
    });

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(events).toEqual(["record", "dispatch-start", "recovery-persist", "adopted", "settle"]);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          turnAdoptionLifecycle: expect.objectContaining({ onAdopted }),
        }),
      }),
    );
  });

  it("does not run afterRecord when session recording fails", async () => {
    const recordError = new Error("session store failed");
    const afterRecord = vi.fn();

    await expect(
      runPreparedChannelTurn({
        channel: "test",
        routeSessionKey: "agent:main:test:peer",
        storePath: "/tmp/sessions.json",
        ctxPayload: createCtx(),
        recordInboundSession: vi.fn(async () => {
          throw recordError;
        }) as unknown as RecordInboundSession,
        afterRecord,
        runDispatch: vi.fn(),
      }),
    ).rejects.toThrow(recordError);

    expect(afterRecord).not.toHaveBeenCalled();
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

  it("records preflight drop history through the turn kernel", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    const resolveTurn = vi.fn();

    const result = await runChannelTurn({
      channel: "test",
      raw: {},
      adapter: {
        ingest: () => ({
          id: "msg-1",
          timestamp: 1_700_000_000_000,
          rawText: "<media:image>",
        }),
        preflight: () => ({
          admission: { kind: "drop", reason: "missing-mention", recordHistory: true },
          message: {
            bodyForAgent: "<media:image>",
            senderLabel: "Alice",
          },
          history: {
            key: "room-1",
            historyMap,
            limit: 5,
            mediaLimit: 2,
          },
          media: async () => [
            { path: "/tmp/a.png", contentType: "image/png", kind: "image" },
            { path: "https://example.com/b.png", contentType: "image/png", kind: "image" },
          ],
        }),
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
    expect(historyMap.get("room-1")).toEqual([
      {
        sender: "Alice",
        body: "<media:image>",
        timestamp: 1_700_000_000_000,
        messageId: "msg-1",
        media: [
          { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
        ],
      },
    ]);
  });

  it("drops repeated bot-pair turns in the core turn kernel before record and dispatch", async () => {
    const events: string[] = [];
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createDispatch(events));
    const onFinalize = vi.fn();
    recordInboundSessionCore.mockImplementation(async () => {
      events.push("record");
    });
    let nowMs = 1_000;
    const runOne = async (id: string) =>
      await runChannelTurn({
        channel: "test",
        accountId: "acct",
        raw: { id },
        adapter: {
          ingest: () => ({ id, rawText: "hello" }),
          resolveTurn: () => ({
            cfg,
            channel: "test",
            accountId: "acct",
            route: { agentId: "main", sessionKey: "agent:main:test:peer" },
            ctxPayload: createCtx(),
            botLoopProtection: {
              scopeId: "acct",
              conversationId: "room",
              senderId: "bot-a",
              receiverId: "bot-b",
              config: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
              defaultEnabled: true,
              nowMs: nowMs++,
            },
            delivery: { deliver: async () => ({ visibleReplySent: true }) },
          }),
          onFinalize,
        },
      });

    const first = await runOne("msg-1");
    const second = await runOne("msg-2");

    expect(first.dispatched).toBe(true);
    expect(second).toEqual({
      admission: { kind: "drop", reason: "bot-loop-protection" },
      dispatched: false,
      ctxPayload: createCtx(),
      routeSessionKey: "agent:main:test:peer",
    });
    expect(events).toEqual(["record", "dispatch"]);
    expect(onFinalize).toHaveBeenCalledTimes(2);
    const [, suppressed] = onFinalize.mock.calls;
    expect(suppressed?.[0]).toMatchObject({
      admission: { kind: "drop", reason: "bot-loop-protection" },
      dispatched: false,
      routeSessionKey: "agent:main:test:peer",
    });
  });

  it("runs observe-only preflights through resolve, record, dispatch, and finalize without visible delivery", async () => {
    const events: string[] = [];
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createDispatch(events));
    recordInboundSessionCore.mockImplementation(async () => {
      events.push("record");
    });
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
          route: {
            agentId: "observer",
            dmScope: "per-channel-peer",
            sessionKey: "agent:observer:test:peer",
          },
          ctxPayload: createCtx({ SessionKey: "agent:observer:test:peer" }),
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
    expect(dispatchReplyWithRoutedChannelDispatcherCore).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ DmScope: "per-channel-peer" }),
        suppressOutboundHooks: true,
      }),
    );
    expect(deliver).not.toHaveBeenCalled();
    if (!result.dispatched) {
      throw new Error("expected dispatch");
    }
    expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(false);
    expect(resolveChannelTurnDispatchCounts(result.dispatchResult)).toEqual({
      tool: 0,
      block: 0,
      final: 0,
    });
    expect(onFinalize).toHaveBeenCalledTimes(1);
    const [finalized] = requireFirstMockCall(onFinalize, "finalize");
    const finalizedResult = finalizeResult(finalized);
    expect(finalizedResult.admission).toEqual({
      kind: "observeOnly",
      reason: "broadcast-observer",
    });
    expect(finalizedResult.dispatched).toBe(true);
    expect(finalizedResult.routeSessionKey).toBe("agent:observer:test:peer");
  });

  it("degrades private channel admission evidence when routing changes the DM scope", async () => {
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    try {
      const ctx = createCtx();
      bindTestChannelParticipantAdmissionEvidence({
        context: ctx,
        channelId: "test",
        participantId: "person-1",
      });
      dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createDispatch());

      await runChannelTurn({
        channel: "test",
        raw: {},
        adapter: {
          ingest: () => ({ id: "msg-evidence", rawText: "hello" }),
          resolveTurn: () => ({
            cfg,
            channel: "test",
            route: {
              agentId: "main",
              dmScope: "per-channel-peer",
              sessionKey: "agent:main:test:peer",
            },
            ctxPayload: ctx,
            delivery: { deliver: vi.fn() },
            record: { onRecordError: vi.fn() },
          }),
        },
      });

      const dispatched = dispatchReplyWithRoutedChannelDispatcherCore.mock.calls[0]?.[0];
      expect(dispatched?.ctx.DmScope).toBe("per-channel-peer");
      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(dispatched?.ctx ?? {})),
      ).toMatchObject({ ingressState: "unknown", invoker: { state: "unknown" } });
    } finally {
      clearCollection();
    }
  });

  it("finalizes failed dispatches before rethrowing", async () => {
    const onFinalize = vi.fn();
    const dispatchError = new Error("dispatch failed");
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => {
      throw dispatchError;
    }) as unknown as DispatchReplyWithBufferedBlockDispatcher;
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(
      dispatchReplyWithBufferedBlockDispatcher,
    );

    await expect(
      runChannelTurn({
        channel: "test",
        raw: {},
        adapter: {
          ingest: () => ({ id: "msg-1", rawText: "hello" }),
          resolveTurn: () => ({
            cfg,
            channel: "test",
            route: { agentId: "main", sessionKey: "agent:main:test:peer" },
            ctxPayload: createCtx(),
            delivery: { deliver: async () => ({ visibleReplySent: false }) },
            record: {
              onRecordError: vi.fn(),
            },
          }),
          onFinalize,
        },
      }),
    ).rejects.toThrow(dispatchError);

    expect(onFinalize).toHaveBeenCalledTimes(1);
    const [finalized] = requireFirstMockCall(onFinalize, "finalize");
    const finalizedResult = finalizeResult(finalized);
    expect(finalizedResult.admission).toEqual({ kind: "dispatch" });
    expect(finalizedResult.dispatched).toBe(false);
    expect(finalizedResult.routeSessionKey).toBe("agent:main:test:peer");
  });
});
