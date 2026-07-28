// Signal tests cover drain claim ownership through debounce, merge, and skip.
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalIngressLifecycle } from "../signal-ingress.js";

vi.useRealTimers();
let createBaseSignalEventHandlerDeps: typeof import("./event-handler.test-harness.js").createBaseSignalEventHandlerDeps;
let createSignalReceiveEvent: typeof import("./event-handler.test-harness.js").createSignalReceiveEvent;
let createSignalEventHandler: typeof import("./event-handler.js").createSignalEventHandler;

type DispatchParams = {
  ctx: MsgContext;
  replyOptions?: { turnAdoptionLifecycle?: { onAdopted: () => Promise<void> | void } };
};

const { dispatchInboundMessageMock, recordInboundSessionMock, dispatchCapture, dispatchBehavior } =
  vi.hoisted(() => {
    const captured: DispatchParams[] = [];
    const behavior = { adoptDuringDispatch: true };
    return {
      dispatchCapture: captured,
      dispatchBehavior: behavior,
      recordInboundSessionMock: vi.fn(),
      dispatchInboundMessageMock: vi.fn(async (params: DispatchParams) => {
        captured.push(params);
        if (behavior.adoptDuringDispatch) {
          // Mirror the real reply lane: adoption fires while dispatch runs.
          await params.replyOptions?.turnAdoptionLifecycle?.onAdopted();
        }
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      }),
    };
  });

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn(),
  sendReadReceiptSignal: vi.fn(),
}));

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: vi.fn(async () => ({ ok: true })),
  removeReactionSignal: vi.fn(async () => ({ ok: true })),
}));

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
        runDispatch: async () =>
          await dispatchInboundMessageMock({
            ctx: resolved.ctxPayload,
            replyOptions: resolved.replyOptions,
          }),
      });
      await params.adapter.onFinalize?.(result);
      return result;
    },
  };
});

beforeAll(async () => {
  const harness = await import("./event-handler.test-harness.js");
  createBaseSignalEventHandlerDeps = harness.createBaseSignalEventHandlerDeps;
  createSignalReceiveEvent = harness.createSignalReceiveEvent;
  ({ createSignalEventHandler } = await import("./event-handler.js"));
});

function createTrackedLifecycle(): SignalIngressLifecycle & {
  adoptedCount: () => number;
  abandonedCount: () => number;
} {
  let adopted = 0;
  let abandoned = 0;
  return {
    abortSignal: new AbortController().signal,
    onAdopted: async () => {
      adopted += 1;
    },
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onAbandoned: () => {
      abandoned += 1;
    },
    adoptedCount: () => adopted,
    abandonedCount: () => abandoned,
  };
}

function createDataEvent(params: { timestamp: number; message: string; source?: string }) {
  return createSignalReceiveEvent({
    sourceUuid: "11111111-2222-3333-4444-555555555555",
    timestamp: params.timestamp,
    dataMessage: { timestamp: params.timestamp, message: params.message },
    ...(params.source ? { sourceNumber: params.source } : {}),
  });
}

describe("signal drain claim ownership", () => {
  beforeEach(() => {
    dispatchCapture.length = 0;
    dispatchBehavior.adoptDuringDispatch = true;
    dispatchInboundMessageMock.mockClear();
  });

  it("defers a drain-claimed event and completes the claim at reply adoption", async () => {
    const handler = createSignalEventHandler(createBaseSignalEventHandlerDeps());
    const lifecycle = createTrackedLifecycle();

    const result = await handler(
      createDataEvent({ timestamp: 1700000001000, message: "hello there" }),
      lifecycle,
    );

    // Deferred, never completed-at-enqueue: a crash inside the debounce window
    // must leave the claim held so the queue replays the message.
    expect(result).toEqual({ kind: "deferred" });
    await vi.waitFor(() => expect(lifecycle.adoptedCount()).toBe(1), { timeout: 5_000 });
    expect(dispatchCapture[0]?.replyOptions?.turnAdoptionLifecycle).toBeDefined();
    expect(lifecycle.abandonedCount()).toBe(0);
  });

  it("completes every constituent claim when debounced entries merge into one turn", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 40 } } },
      }),
    );
    const first = createTrackedLifecycle();
    const second = createTrackedLifecycle();

    const results = [
      await handler(createDataEvent({ timestamp: 1700000002000, message: "part one" }), first),
      await handler(createDataEvent({ timestamp: 1700000003000, message: "part two" }), second),
    ];
    expect(results).toEqual([{ kind: "deferred" }, { kind: "deferred" }]);

    await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    await vi.waitFor(
      () => {
        expect(first.adoptedCount()).toBe(1);
        expect(second.adoptedCount()).toBe(1);
      },
      { timeout: 5_000 },
    );
  });

  it("settles the claim for a turn that finishes without adoption", async () => {
    // Dispatch resolves without the reply lane ever adopting (gated/no-reply):
    // the flush must complete the claim, or the stall watchdog would
    // dead-letter a deliberately handled message.
    dispatchBehavior.adoptDuringDispatch = false;
    const handler = createSignalEventHandler(createBaseSignalEventHandlerDeps());
    const lifecycle = createTrackedLifecycle();

    const result = await handler(
      createDataEvent({ timestamp: 1700000004000, message: "no adoption" }),
      lifecycle,
    );

    expect(result).toEqual({ kind: "deferred" });
    await vi.waitFor(() => expect(lifecycle.adoptedCount()).toBe(1), { timeout: 5_000 });
    expect(lifecycle.abandonedCount()).toBe(0);
  });
});
