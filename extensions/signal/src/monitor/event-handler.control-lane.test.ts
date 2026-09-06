import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  dispatchInboundMessageMock,
  recordInboundSessionMock,
  sendReadReceiptMock,
  sendTypingMock,
} = vi.hoisted(() => ({
  dispatchInboundMessageMock: vi.fn(),
  recordInboundSessionMock: vi.fn(),
  sendReadReceiptMock: vi.fn(),
  sendTypingMock: vi.fn(),
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  type RunParams = Parameters<typeof actual.runChannelInboundEvent>[0];
  return {
    ...actual,
    runChannelInboundEvent: async (params: RunParams) => {
      const input = await params.adapter.ingest(params.raw);
      if (!input) {
        return { admission: { kind: "drop" as const, reason: "ingest-null" }, dispatched: false };
      }
      const eventClass = (await params.adapter.classify?.(input)) ?? {
        kind: "message" as const,
        canStartAgentTurn: true,
      };
      const preflight = (await params.adapter.preflight?.(input, eventClass)) ?? {};
      const resolved = await params.adapter.resolveTurn(
        input,
        eventClass,
        "kind" in preflight ? { admission: preflight } : preflight,
      );
      if (!("route" in resolved) || !("delivery" in resolved)) {
        throw new Error("expected assembled Signal channel turn plan");
      }
      const result = await actual.runPreparedInboundReply({
        channel: resolved.channel,
        accountId: resolved.accountId,
        routeSessionKey: resolved.route.sessionKey,
        storePath: "/tmp/openclaw/signal-sessions.json",
        ctxPayload: resolved.ctxPayload,
        recordInboundSession: recordInboundSessionMock,
        afterRecord: resolved.afterRecord,
        record: resolved.record,
        history: resolved.history,
        admission: resolved.admission,
        botLoopProtection: resolved.botLoopProtection,
        runDispatch: async () => await dispatchInboundMessageMock({ ctx: resolved.ctxPayload }),
      });
      await params.adapter.onFinalize?.(result);
      return result;
    },
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    recordInboundSession: recordInboundSessionMock,
    readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
    upsertChannelPairingRequest: vi.fn(),
  };
});

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
  {
    createSignalPendingInboundRegistry,
    resolveSignalControlLaneKey,
    resolveSignalInboundDebounceKey,
  },
] = await Promise.all([
  import("./event-handler.test-harness.js"),
  import("./event-handler.js"),
  import("./event-handler.control-lane.js"),
]);

type DispatchParams = { ctx: MsgContext };

const dispatchResult = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 1 },
};

const pendingTasks: Promise<void>[] = [];
const activeGates: Array<() => void> = [];
let pendingDebounceMs = 0;

function holdNextDispatch() {
  const gate = createDeferred<void>();
  activeGates.push(gate.resolve);
  dispatchInboundMessageMock.mockImplementationOnce(async () => {
    await gate.promise;
    return dispatchResult;
  });
  return gate.resolve;
}

function createHandler(debounceMs: number, config?: OpenClawConfig) {
  pendingDebounceMs = Math.max(pendingDebounceMs, debounceMs);
  const dmPolicy = "allowlist";
  const allowFrom = ["+15550001111"];
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg:
        config ??
        ({
          messages: { inbound: { debounceMs } },
          channels: { signal: { dmPolicy, allowFrom } },
        } as OpenClawConfig),
      dmPolicy,
      allowFrom,
      historyLimit: 0,
      runTrackedTask: (task) => {
        pendingTasks.push(task());
      },
    }),
  );
}

function signalText(message: string, timestamp: number) {
  return createSignalReceiveEvent({
    timestamp,
    dataMessage: { message, attachments: [] },
  });
}

function signalGroupText(message: string, timestamp: number, sourceNumber: string) {
  return createSignalReceiveEvent({
    sourceNumber,
    sourceName: sourceNumber,
    timestamp,
    dataMessage: {
      message,
      attachments: [],
      groupInfo: { groupId: "group-1", groupName: "Test Group" },
    },
  });
}

function dispatchedCommandBody(index: number): string | undefined {
  const call = dispatchInboundMessageMock.mock.calls[index];
  if (!call) {
    throw new Error(`missing dispatch call ${index}`);
  }
  return (call[0] as DispatchParams).ctx.CommandBody;
}

describe("Signal active-run control lane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dispatchInboundMessageMock.mockReset().mockResolvedValue(dispatchResult);
    recordInboundSessionMock.mockReset().mockResolvedValue(undefined);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    sendTypingMock.mockReset().mockResolvedValue(true);
  });

  afterEach(async () => {
    try {
      for (const release of activeGates.splice(0)) {
        release();
      }
      // Shared runtime timers can recur; advance only this fixture's debounce window.
      await vi.advanceTimersByTimeAsync(pendingDebounceMs);
      // Debounce admission can finish before dispatch; drain the tracked completion.
      await Promise.all(pendingTasks.splice(0));
    } finally {
      pendingDebounceMs = 0;
      clearRuntimeConfigSnapshot();
      vi.useRealTimers();
    }
  });

  it("collects both authorized messages through one debounce dispatch", async () => {
    const handler = createHandler(10);
    await Promise.all([handler(signalText("first", 1)), handler(signalText("second", 2))]);
    await vi.advanceTimersByTimeAsync(10);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

    expect(dispatchedCommandBody(0)).toBe("first\nsecond");
  });

  it("updates Signal batching while keeping stop on the immediate control lane", async () => {
    const cfg: OpenClawConfig = {
      messages: { inbound: { debounceMs: 0 } },
      channels: { signal: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const handler = createHandler(25, cfg);
    const publish = (debounceMs: number) => {
      const current = { ...cfg, messages: { inbound: { byChannel: { signal: debounceMs } } } };
      setRuntimeConfigSnapshot(current, current);
    };
    await handler(signalText("immediate", 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    publish(25);
    await handler(signalText("first", 2));
    await handler(signalText("second", 3));
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(dispatchedCommandBody(1)).toBe("first\nsecond");
    publish(0);
    await handler(signalText("after disable", 4));
    expect(dispatchedCommandBody(2)).toBe("after disable");
    publish(25);
    await handler(signalText("pending", 5));
    await handler(signalText("stop", 6));
    expect(dispatchedCommandBody(3)).toBe("stop");
    await vi.advanceTimersByTimeAsync(25);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    "stop",
    "/approve abc12345 allow-once",
    "/status",
    "/queue",
    "/QUEUE",
    "/steer keep going",
  ])("dispatches active-run-safe control %s while normal work is active", async (controlText) => {
    const releaseActive = holdNextDispatch();
    const handler = createHandler(5);

    await handler(signalText("start a long task", 1));
    await vi.advanceTimersByTimeAsync(5);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

    const controlHandled = handler(signalText(controlText, 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchedCommandBody(1)).toBe(controlText);

    releaseActive();
    await controlHandled;
  });

  it("serializes repeated aborts on the control lane", async () => {
    const releaseFirstAbort = holdNextDispatch();
    const handler = createHandler(0);

    const first = handler(signalText("stop", 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    const second = handler(signalText("halt", 2));
    await vi.advanceTimersByTimeAsync(20);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

    releaseFirstAbort();
    await Promise.all([first, second]);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchedCommandBody(1)).toBe("halt");
  });

  it.each(["one more detail", "/reset"])(
    "leaves zero-debounce turn %s to core session admission",
    async (followupText) => {
      const releaseActive = holdNextDispatch();
      const handler = createHandler(0);

      const active = handler(signalText("start a long task", 1));
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      const followup = handler(signalText(followupText, 2));
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(dispatchedCommandBody(1)).toBe(followupText);

      releaseActive();
      await Promise.all([active, followup]);
    },
  );

  it("does not promote or cancel an unauthorized abort", () => {
    const entry = {
      cfg: {},
      senderName: "Alice",
      senderDisplay: "+15550001111",
      senderRecipient: "+15550001111",
      senderPeerId: "+15550001111",
      isGroup: false,
      bodyText: "stop",
      commandBody: "stop",
      commandAuthorized: false,
    };
    const cancelKey = vi.fn(() => true);
    const pendingInboundRegistry = createSignalPendingInboundRegistry("default");

    expect(resolveSignalInboundDebounceKey("default", entry)).toBe(
      "signal:default:+15550001111:+15550001111",
    );
    expect(resolveSignalControlLaneKey("default", entry)).toBeNull();
    pendingInboundRegistry.track(entry);
    pendingInboundRegistry.cancelPendingOnAbort(entry, cancelKey);
    expect(cancelKey).not.toHaveBeenCalled();
  });

  it("shares one group control lane without merging normal sender batches", () => {
    const entry = {
      cfg: {},
      senderName: "Alice",
      senderDisplay: "+15550001111",
      senderRecipient: "+15550001111",
      senderPeerId: "+15550001111",
      groupId: "group-1",
      isGroup: true,
      bodyText: "stop",
      commandBody: "stop",
      commandAuthorized: true,
    };
    const otherSender = { ...entry, senderPeerId: "+15550002222" };

    expect(resolveSignalControlLaneKey("default", entry)).toBe(
      resolveSignalControlLaneKey("default", otherSender),
    );
    expect(resolveSignalInboundDebounceKey("default", entry)).not.toBe(
      resolveSignalInboundDebounceKey("default", otherSender),
    );
  });

  it.each([
    "/reset",
    "/queue status",
    "/queue collect",
    "/queue interrupt",
    "/queue reset",
    "/queue debounce:2s",
    "/queue cap:5",
    "/queue drop:summarize",
  ])("keeps stateful command %s behind active conversation work", async (commandText) => {
    const releaseActive = holdNextDispatch();
    const handler = createHandler(5);

    const active = handler(signalText("start a long task", 1));
    await vi.advanceTimersByTimeAsync(5);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    const statefulCommand = handler(signalText(commandText, 2));
    await vi.advanceTimersByTimeAsync(20);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

    releaseActive();
    await Promise.all([active, statefulCommand]);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchedCommandBody(1)).toBe(commandText);
  });

  it("cancels ordinary text still waiting in the debounce window", async () => {
    const handler = createHandler(50);

    await handler(signalText("queued work", 1));
    await handler(signalText("stop", 2));
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchedCommandBody(0)).toBe("stop");

    await vi.advanceTimersByTimeAsync(75);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  });

  it("cancels pending normal work from every sender in a group conversation", async () => {
    const handler = createHandler(50);

    await handler(signalGroupText("queued work", 1, "+15550001111"));
    await handler(signalGroupText("stop", 2, "+15550002222"));
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchedCommandBody(0)).toBe("stop");

    await vi.advanceTimersByTimeAsync(75);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  });

  it("cancels ordinary text released from debounce but still waiting on active work", async () => {
    const releaseActive = holdNextDispatch();
    const handler = createHandler(5);

    await handler(signalText("start a long task", 1));
    await vi.advanceTimersByTimeAsync(5);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    await handler(signalText("queued followup", 2));
    await vi.advanceTimersByTimeAsync(20);

    await handler(signalText("stop", 3));
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchedCommandBody(1)).toBe("stop");

    releaseActive();
    await vi.advanceTimersByTimeAsync(20);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
  });
});
