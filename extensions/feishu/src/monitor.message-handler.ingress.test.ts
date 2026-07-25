import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
// Feishu ingress tests cover debounce ownership and constituent claim settlement.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import * as dedup from "./dedup.js";
import type { FeishuMessageEvent } from "./event-types.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

type MessageReceiveHandlerContext = Parameters<typeof createFeishuMessageReceiveHandler>[0];
type HandleMessageParams = Parameters<MessageReceiveHandlerContext["handleMessage"]>[0];
type DebounceEntry = Parameters<
  Parameters<PluginRuntime["channel"]["debounce"]["createInboundDebouncer"]>[0]["onFlush"]
>[0][number];

function createTextEvent(
  eventId: string,
  messageId: string,
  text: string,
): FeishuMessageEvent & { event_id: string } {
  return {
    event_id: eventId,
    sender: {
      sender_id: { open_id: "ou-user" },
      sender_type: "user",
    },
    message: {
      message_id: messageId,
      chat_id: "oc-chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
      create_time: "1710000000000",
    },
  };
}

function createLifecycle() {
  const controller = new AbortController();
  const abandonHandlers = new Set<() => void | Promise<void>>();
  const calls = {
    adopted: vi.fn(async () => {}),
    deferred: vi.fn(),
    finalizing: vi.fn(),
    abandoned: vi.fn(async () => {}),
  };
  const lifecycle: FeishuIngressLifecycle = {
    abortSignal: controller.signal,
    onAdopted: calls.adopted,
    onDeferred: calls.deferred,
    onAdoptionFinalizing: calls.finalizing,
    onAbandoned: async () => {
      await Promise.all([...abandonHandlers].map(async (handler) => await handler()));
      await calls.abandoned();
    },
    registerAbandonHandler: (handler) => {
      abandonHandlers.add(handler);
      return () => abandonHandlers.delete(handler);
    },
  };
  return { calls, controller, lifecycle };
}

function createClaim(name: string): dedup.FeishuMessageProcessingClaim {
  return {
    keys: [name],
    commit: vi.fn(async () => true),
    release: vi.fn(),
  };
}

function createHarness(params: {
  lifecycles: ReadonlyMap<string, FeishuIngressLifecycle>;
  claims: readonly dedup.FeishuMessageProcessingClaim[];
  adoptTurn: boolean;
}) {
  let onFlush: ((entries: DebounceEntry[]) => Promise<void>) | undefined;
  let onError: ((err: unknown, entries: DebounceEntry[]) => void) | undefined;
  const entries: DebounceEntry[] = [];
  const runtimeError = vi.fn();
  const channelRuntime = {
    commands: { isControlCommandMessage: () => false },
    debounce: {
      resolveInboundDebounceMs: () => 25,
      createInboundDebouncer: vi.fn(
        (options: {
          onFlush: (entries: DebounceEntry[]) => Promise<void>;
          onError: (err: unknown, entries: DebounceEntry[]) => void;
        }) => {
          onFlush = options.onFlush;
          onError = options.onError;
          return {
            enqueue: async (entry: DebounceEntry) => {
              entries.push(entry);
            },
          };
        },
      ),
    },
  } as unknown as PluginRuntime["channel"];
  const handleMessage = vi.fn(async (turn: HandleMessageParams) => {
    if (params.adoptTurn) {
      turn.turnAdoptionLifecycle?.onAdoptionFinalizing();
      await turn.turnAdoptionLifecycle?.onAdopted();
    }
  });
  const claim = vi.spyOn(dedup, "claimUnprocessedFeishuMessage");
  for (const handle of params.claims) {
    claim.mockResolvedValueOnce({ kind: "claimed", handle });
  }
  const handler = createFeishuMessageReceiveHandler({
    cfg: {} as ClawdbotConfig,
    channelRuntime,
    accountId: "default",
    runtime: { ...createNonExitingRuntimeEnv(), error: runtimeError } satisfies RuntimeEnv,
    chatHistories: new Map(),
    handleMessage,
    resolveDebounceText: () => "hello",
    hasProcessedMessage: vi.fn(async () => false),
    getBotOpenId: () => "ou-bot",
    resolveIngressLifecycle: (data) => {
      const eventId = (data as { event_id?: string }).event_id;
      return eventId ? params.lifecycles.get(eventId) : undefined;
    },
  });
  return {
    claim,
    entries,
    handler,
    handleMessage,
    flush: async () => {
      if (!onFlush) {
        throw new Error("debouncer flush callback missing");
      }
      await onFlush(entries.splice(0));
    },
    failFlush: (err: unknown) => {
      if (!onError) {
        throw new Error("debouncer error callback missing");
      }
      onError(err, entries);
    },
    runtimeError,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Feishu durable ingress debounce lifecycle", () => {
  it("returns deferred and fans merged adoption to every constituent claim", async () => {
    const first = createLifecycle();
    const second = createLifecycle();
    const firstClaim = createClaim("first");
    const secondClaim = createClaim("second");
    const harness = createHarness({
      lifecycles: new Map([
        ["evt-a", first.lifecycle],
        ["evt-b", second.lifecycle],
      ]),
      claims: [firstClaim, secondClaim],
      adoptTurn: true,
    });

    await expect(harness.handler(createTextEvent("evt-a", "om-a", "alpha"))).resolves.toEqual({
      kind: "deferred",
    });
    await expect(harness.handler(createTextEvent("evt-b", "om-b", "beta"))).resolves.toEqual({
      kind: "deferred",
    });
    await harness.flush();

    expect(harness.handleMessage).toHaveBeenCalledTimes(1);
    expect(firstClaim.commit).toHaveBeenCalledTimes(1);
    expect(secondClaim.commit).toHaveBeenCalledTimes(1);
    expect(first.calls.finalizing).toHaveBeenCalledTimes(1);
    expect(second.calls.finalizing).toHaveBeenCalledTimes(1);
    expect(first.calls.adopted).toHaveBeenCalledTimes(1);
    expect(second.calls.adopted).toHaveBeenCalledTimes(1);
  });

  it("completes gated no-dispatch transport claims and releases the logical guard", async () => {
    const transport = createLifecycle();
    const logicalClaim = createClaim("gated");
    const harness = createHarness({
      lifecycles: new Map([["evt-gated", transport.lifecycle]]),
      claims: [logicalClaim],
      adoptTurn: false,
    });

    await harness.handler(createTextEvent("evt-gated", "om-gated", "gated"));
    await harness.flush();

    expect(logicalClaim.commit).not.toHaveBeenCalled();
    expect(logicalClaim.release).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).not.toHaveBeenCalled();
  });

  it("completes the transport claim when the permanent logical guard suppresses a twin", async () => {
    const transport = createLifecycle();
    const harness = createHarness({
      lifecycles: new Map([["evt-twin", transport.lifecycle]]),
      claims: [],
      adoptTurn: false,
    });
    harness.claim.mockResolvedValueOnce({ kind: "duplicate" });

    await expect(harness.handler(createTextEvent("evt-twin", "om-twin", "twin"))).resolves.toBe(
      undefined,
    );

    expect(harness.entries).toHaveLength(0);
    expect(transport.calls.finalizing).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).not.toHaveBeenCalled();
  });

  it("releases a deferred logical claim when the drain abandons before debounce flush", async () => {
    const transport = createLifecycle();
    const logicalClaim = createClaim("pre-flush-abandonment");
    const harness = createHarness({
      lifecycles: new Map([["evt-abandoned", transport.lifecycle]]),
      claims: [logicalClaim],
      adoptTurn: false,
    });

    await expect(
      harness.handler(createTextEvent("evt-abandoned", "om-abandoned", "queued")),
    ).resolves.toEqual({ kind: "deferred" });
    await transport.lifecycle.onAbandoned();
    await harness.flush();

    expect(logicalClaim.release).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
    expect(harness.handleMessage).not.toHaveBeenCalled();
  });

  it("reports rejected durable abandonment after a debounce flush error", async () => {
    const transport = createLifecycle();
    transport.calls.abandoned.mockRejectedValueOnce(new Error("state store unavailable"));
    const logicalClaim = createClaim("flush-error");
    const harness = createHarness({
      lifecycles: new Map([["evt-flush-error", transport.lifecycle]]),
      claims: [logicalClaim],
      adoptTurn: false,
    });

    await harness.handler(createTextEvent("evt-flush-error", "om-flush-error", "queued"));
    harness.failFlush(new Error("flush failed"));

    await vi.waitFor(() => {
      expect(harness.runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("failed to abandon durable ingress after debounce error"),
      );
    });
    expect(logicalClaim.release).toHaveBeenCalled();
  });

  it("does not dispatch a queued turn after its ingress claim aborts", async () => {
    const first = createLifecycle();
    const second = createLifecycle();
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const harness = createHarness({
      lifecycles: new Map([
        ["evt-first", first.lifecycle],
        ["evt-second", second.lifecycle],
      ]),
      claims: [createClaim("first-queued"), createClaim("second-queued")],
      adoptTurn: true,
    });
    harness.handleMessage.mockImplementationOnce(async (turn) => {
      await firstGate;
      turn.turnAdoptionLifecycle?.onAdoptionFinalizing();
      await turn.turnAdoptionLifecycle?.onAdopted();
    });

    await harness.handler(createTextEvent("evt-first", "om-first", "first"));
    const firstFlush = harness.flush();
    await vi.waitFor(() => expect(harness.handleMessage).toHaveBeenCalledTimes(1));
    await harness.handler(createTextEvent("evt-second", "om-second", "second"));
    const secondFlush = harness.flush();
    await Promise.resolve();
    second.controller.abort(new Error("adoption timeout"));
    await second.lifecycle.onAbandoned();
    finishFirst();
    await Promise.all([firstFlush, secondFlush]);

    expect(harness.handleMessage).toHaveBeenCalledTimes(1);
    expect(second.calls.adopted).not.toHaveBeenCalled();
  });
});
