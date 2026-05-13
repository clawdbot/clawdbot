/**
 * Tests for Matrix group chat history accumulation.
 *
 * Covers two key scenarios:
 *
 * Scenario 1 — basic accumulation across agents:
 *   user: msg A              (no mention, accumulates)
 *   user: @agent_a msg B     (triggers agent_a; agent_a sees [A] in history, not B itself)
 *   user: @agent_b msg C     (triggers agent_b; agent_b sees [A, B] — independent watermark)
 *   user: @agent_b msg D     (triggers agent_b; agent_b sees [] — A/B/C were consumed)
 *
 * Scenario 2 — race condition safety:
 *   user: @agent_a msg A     (triggers agent_a; agent starts processing, not yet replied)
 *   user: msg B              (no mention, arrives during processing — must not be lost)
 *   agent_a: reply           (watermark advances to just after A, not after B)
 *   user: @agent_a msg C     (triggers agent_a; agent_a sees [B] in history)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import { type MatrixRawEvent } from "./types.js";

const deliverMatrixRepliesMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./replies.js", () => ({
  deliverMatrixReplies: deliverMatrixRepliesMock,
}));

vi.mock("./route.js", () => ({
  resolveMatrixInboundRoute: (params: {
    resolveAgentRoute: (input: unknown) => unknown;
    cfg: unknown;
    accountId: string;
    roomId: string;
    senderId: string;
    isDirectMessage: boolean;
  }) => ({
    route: params.resolveAgentRoute({
      cfg: params.cfg,
      channel: "matrix",
      accountId: params.accountId,
      peer: {
        kind: params.isDirectMessage ? "direct" : "channel",
        id: params.isDirectMessage ? params.senderId : params.roomId,
      },
    }),
    configuredBinding: null,
    runtimeBindingId: null,
  }),
}));

const DEFAULT_ROOM = "!room:example.org";

function makeRoomTriggerEvent(params: { eventId: string; body: string; ts?: number }) {
  // Use @room mention to trigger the bot without requiring agent-specific mention regexes
  return createMatrixTextMessageEvent({
    eventId: params.eventId,
    body: `@room ${params.body}`,
    originServerTs: params.ts ?? Date.now(),
    mentions: { room: true },
  });
}

function makeRoomPlainEvent(params: { eventId: string; body: string; ts?: number }) {
  return createMatrixTextMessageEvent({
    eventId: params.eventId,
    body: params.body,
    originServerTs: params.ts ?? Date.now(),
  });
}

function makeDevRoute(agentId: string) {
  return {
    agentId,
    channel: "matrix" as const,
    accountId: "ops",
    sessionKey: `agent:${agentId}:main`,
    mainSessionKey: `agent:${agentId}:main`,
    matchedBy: "binding.account" as const,
  };
}

beforeEach(() => {
  installMatrixMonitorTestRuntime();
});

function deferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function createFinalDeliveryFailureHandler(finalizeInboundContext: (ctx: unknown) => unknown) {
  let capturedOnError:
    | ((err: unknown, info: { kind: "tool" | "block" | "final" }) => void)
    | undefined;

  return createMatrixHandlerTestHarness({
    historyLimit: 20,
    groupPolicy: "open",
    isDirectMessage: false,
    finalizeInboundContext,
    dispatchReplyFromConfig: async () => ({
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    }),
    createReplyDispatcherWithTyping: (params?: {
      onError?: (err: unknown, info: { kind: "tool" | "block" | "final" }) => void;
    }) => {
      capturedOnError = params?.onError;
      return {
        dispatcher: {},
        replyOptions: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
      };
    },
    withReplyDispatcher: async <T>(params: {
      dispatcher: { markComplete?: () => void; waitForIdle?: () => Promise<void> };
      run: () => Promise<T>;
      onSettled?: () => void | Promise<void>;
    }) => {
      const result = await params.run();
      capturedOnError?.(new Error("simulated delivery failure"), { kind: "final" });
      params.dispatcher.markComplete?.();
      await params.dispatcher.waitForIdle?.();
      await params.onSettled?.();
      return result;
    },
  });
}

function inboundHistoryBodies(finalizeInboundContext: ReturnType<typeof vi.fn>, callIndex: number) {
  const ctx = finalizeInboundContextCall(finalizeInboundContext, callIndex);
  const history = ctx["InboundHistory"] as Array<{ body: string }> | undefined;
  return history?.map((entry) => entry.body) ?? [];
}

function finalizeInboundContextCall(
  finalizeInboundContext: ReturnType<typeof vi.fn>,
  callIndex: number,
) {
  const ctx = finalizeInboundContext.mock.calls.at(callIndex)?.[0];
  if (!ctx || typeof ctx !== "object") {
    throw new Error(`Expected finalizeInboundContext call ${callIndex + 1}`);
  }
  return ctx as Record<string, unknown>;
}

function expectSomeBodyContaining(bodies: readonly string[], fragment: string) {
  expect(bodies.join("\n")).toContain(fragment);
}

function expectNoBodyContaining(bodies: readonly string[], fragment: string) {
  expect(bodies.join("\n")).not.toContain(fragment);
}

describe("matrix group chat history — scenario 1: basic accumulation", () => {
  it("pending messages appear in InboundHistory; trigger itself does not", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 20,
      groupPolicy: "open",
      isDirectMessage: false,
      finalizeInboundContext,
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    // Non-trigger message A — should not dispatch
    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ eventId: "$a", body: "msg A", ts: 1000 }));
    expect(finalizeInboundContext).not.toHaveBeenCalled();

    // Trigger B — history must contain [msg A] only, not the trigger itself
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ eventId: "$b", body: "msg B", ts: 2000 }));
    expect(finalizeInboundContext).toHaveBeenCalledOnce();
    const ctx = finalizeInboundContextCall(finalizeInboundContext, 0);
    const history = ctx["InboundHistory"] as Array<{ body: string; sender: string }>;
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toContain("msg A");
  });

  it("multi-agent: each agent has an independent watermark", async () => {
    let currentAgentId = "agent_a";
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 20,
      groupPolicy: "open",
      isDirectMessage: false,
      finalizeInboundContext,
      resolveAgentRoute: vi.fn(() => makeDevRoute(currentAgentId)),
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    // msg A accumulates for all agents
    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ eventId: "$a", body: "msg A", ts: 1000 }));

    // @agent_a trigger B — agent_a sees [msg A]
    currentAgentId = "agent_a";
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ eventId: "$b", body: "msg B", ts: 2000 }));
    {
      const ctx = finalizeInboundContextCall(finalizeInboundContext, 0);
      const history = ctx["InboundHistory"] as Array<{ body: string }>;
      expect(history).toHaveLength(1);
      expect(history[0]?.body).toContain("msg A");
    }

    // @agent_b trigger C — agent_b watermark is 0, so it sees [msg A, msg B]
    currentAgentId = "agent_b";
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ eventId: "$c", body: "msg C", ts: 3000 }));
    {
      const bodies = inboundHistoryBodies(finalizeInboundContext, 1);
      expect(bodies).toHaveLength(2);
      expectSomeBodyContaining(bodies, "msg A");
      expectSomeBodyContaining(bodies, "msg B");
    }

    // @agent_b trigger D — A/B/C consumed; history is empty
    currentAgentId = "agent_b";
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ eventId: "$d", body: "msg D", ts: 4000 }));
    {
      const ctx = finalizeInboundContextCall(finalizeInboundContext, 2);
      const history = ctx["InboundHistory"] as Array<unknown> | undefined;
      expect(history ?? []).toHaveLength(0);
    }
  });

  it("respects historyLimit: caps to the most recent N entries", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 2,
      groupPolicy: "open",
      isDirectMessage: false,
      finalizeInboundContext,
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    for (let i = 1; i <= 4; i++) {
      await handler(
        DEFAULT_ROOM,
        makeRoomPlainEvent({ eventId: `$p${i}`, body: `pending ${i}`, ts: i * 1000 }),
      );
    }

    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ eventId: "$t", body: "trigger", ts: 5000 }));
    const ctx = finalizeInboundContextCall(finalizeInboundContext, 0);
    const history = ctx["InboundHistory"] as Array<{ body: string }>;
    expect(history).toHaveLength(2);
    expect(history[0]?.body).toContain("pending 3");
    expect(history[1]?.body).toContain("pending 4");
  });

  it("historyLimit=0 disables history accumulation entirely", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 0,
      groupPolicy: "open",
      isDirectMessage: false,
      finalizeInboundContext,
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ eventId: "$p", body: "pending" }));
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ eventId: "$t", body: "trigger" }));

    const ctx = finalizeInboundContextCall(finalizeInboundContext, 0);
    const history = ctx["InboundHistory"] as Array<unknown> | undefined;
    expect(history ?? []).toHaveLength(0);
  });

  it("historyLimit=0 does not serialize same-room ingress", async () => {
    const firstUserId = deferred<string>();
    let getUserIdCalls = 0;
    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 0,
      groupPolicy: "open",
      isDirectMessage: false,
      client: {
        getUserId: async () => {
          getUserIdCalls += 1;
          if (getUserIdCalls === 1) {
            return await firstUserId.promise;
          }
          return "@bot:example.org";
        },
      },
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    const first = handler(DEFAULT_ROOM, makeRoomTriggerEvent({ eventId: "$a", body: "first" }));
    await Promise.resolve();
    const second = handler(DEFAULT_ROOM, makeRoomTriggerEvent({ eventId: "$b", body: "second" }));
    await Promise.resolve();

    expect(getUserIdCalls).toBe(2);

    firstUserId.resolve("@bot:example.org");
    await Promise.all([first, second]);
  });

  it("DMs do not accumulate history (group chat only)", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 20,
      isDirectMessage: true,
      finalizeInboundContext,
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ eventId: "$dm1", body: "dm message 1" }));
    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ eventId: "$dm2", body: "dm message 2" }));

    expect(finalizeInboundContext).toHaveBeenCalledTimes(2);
    for (const call of finalizeInboundContext.mock.calls) {
      const ctx = call[0] as Record<string, unknown>;
      const history = ctx["InboundHistory"] as Array<unknown> | undefined;
      expect(history ?? []).toHaveLength(0);
    }
  });

  it("history-enabled rooms do not serialize DM ingress heavy work", async () => {
    let resolveFirstName: (() => void) | undefined;
    let nameLookupCalls = 0;
    const getMemberDisplayName = vi.fn(async () => {
      nameLookupCalls += 1;
      if (nameLookupCalls === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstName = resolve;
        });
      }
      return "sender";
    });

    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 20,
      isDirectMessage: true,
      getMemberDisplayName,
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    const first = handler(DEFAULT_ROOM, makeRoomPlainEvent({ eventId: "$dm-a", body: "first dm" }));
    await vi.waitFor(() => {
      expect(resolveFirstName).toBeTypeOf("function");
    });

    const second = handler(
      DEFAULT_ROOM,
      makeRoomPlainEvent({ eventId: "$dm-b", body: "second dm" }),
    );
    await vi.waitFor(() => {
      expect(nameLookupCalls).toBe(2);
    });

    resolveFirstName?.();
    await Promise.all([first, second]);
  });

  it("includes skipped media-only room messages in next trigger history", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 20,
      groupPolicy: "open",
      isDirectMessage: false,
      finalizeInboundContext,
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    // Unmentioned media-only message should be buffered as pending history context.
    await handler(
      DEFAULT_ROOM,
      createMatrixRoomMessageEvent({
        eventId: "$media-a",
        originServerTs: 1000,
        content: {
          msgtype: "m.image",
          body: "",
          url: "mxc://example.org/media-a",
        },
      }),
    );
    expect(finalizeInboundContext).not.toHaveBeenCalled();

    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ eventId: "$trigger-media", body: "trigger", ts: 2000 }),
    );
    expect(finalizeInboundContext).toHaveBeenCalledOnce();
    expectSomeBodyContaining(
      inboundHistoryBodies(finalizeInboundContext, 0),
      "[matrix image attachment]",
    );
  });

  it("includes skipped poll updates in next trigger history", async () => {
    const getEvent = vi.fn(async () => ({
      event_id: "$poll",
      sender: "@user:example.org",
      type: "m.poll.start",
      origin_server_ts: Date.now(),
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          kind: "m.poll.disclosed",
          max_selections: 1,
          answers: [{ id: "a1", "m.text": "Pizza" }],
        },
      },
    }));
    const getRelations = vi.fn(async () => ({
      events: [],
      nextBatch: null,
      prevBatch: null,
    }));
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 20,
      groupPolicy: "open",
      isDirectMessage: false,
      client: {
        getEvent,
        getRelations,
      },
      finalizeInboundContext,
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    await handler(DEFAULT_ROOM, {
      type: "m.poll.response",
      sender: "@user:example.org",
      event_id: "$poll-response-1",
      origin_server_ts: 1000,
      content: {
        "m.poll.response": {
          answers: ["a1"],
        },
        "m.relates_to": {
          rel_type: "m.reference",
          event_id: "$poll",
        },
      },
    } as MatrixRawEvent);
    expect(finalizeInboundContext).not.toHaveBeenCalled();

    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ eventId: "$trigger-poll", body: "trigger", ts: 2000 }),
    );

    expect(getEvent).toHaveBeenCalledOnce();
    expect(getRelations).toHaveBeenCalledOnce();
    expectSomeBodyContaining(inboundHistoryBodies(finalizeInboundContext, 0), "Lunch?");
  });
});

describe("matrix group chat history — scenario 2: race condition safety", () => {
  it("messages arriving during agent processing are visible on the next trigger", async () => {
    let resolveFirstDispatch: (() => void) | undefined;
    let firstDispatchStarted = false;

    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const dispatchReplyFromConfig = vi.fn(async () => {
      if (!firstDispatchStarted) {
        firstDispatchStarted = true;
        await new Promise<void>((resolve) => {
          resolveFirstDispatch = resolve;
        });
      }
      return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
    });

    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 20,
      groupPolicy: "open",
      isDirectMessage: false,
      finalizeInboundContext,
      dispatchReplyFromConfig,
    });

    // Step 1: trigger msg A — don't await, let it block in dispatch
    const firstHandlerDone = handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ eventId: "$a", body: "msg A", ts: 1000 }),
    );

    // Step 2: wait until dispatch is in-flight
    await vi.waitFor(() => {
      expect(firstDispatchStarted).toBe(true);
    });

    // Step 3: msg B arrives while agent is processing — must not be lost
    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ eventId: "$b", body: "msg B", ts: 2000 }));

    // Step 4: unblock dispatch and complete
    resolveFirstDispatch!();
    await firstHandlerDone;
    // watermark advances to snapshot taken at dispatch time (just after msg A), not to queue end

    // Step 5: trigger msg C — should see [msg B] in history (msg A was consumed)
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ eventId: "$c", body: "msg C", ts: 3000 }));

    expect(finalizeInboundContext).toHaveBeenCalledTimes(2);
    const bodies = inboundHistoryBodies(finalizeInboundContext, 1);
    expectSomeBodyContaining(bodies, "msg B");
    expectNoBodyContaining(bodies, "msg A");
  });

  it("watermark does not advance when final reply delivery fails (retry sees same history)", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createFinalDeliveryFailureHandler(finalizeInboundContext);

    await handler(
      DEFAULT_ROOM,
      makeRoomPlainEvent({ eventId: "$p", body: "pending msg", ts: 1000 }),
    );

    // First trigger — delivery fails; watermark must NOT advance
    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ eventId: "$t1", body: "trigger 1", ts: 2000 }),
    );
    expect(finalizeInboundContext).toHaveBeenCalledOnce();
    {
      const ctx = finalizeInboundContextCall(finalizeInboundContext, 0);
      const history = ctx["InboundHistory"] as Array<{ body: string }>;
      expect(history).toHaveLength(1);
      expect(history[0]?.body).toContain("pending msg");
    }

    // Second trigger — pending msg must still be visible (watermark not advanced)
    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ eventId: "$t2", body: "trigger 2", ts: 3000 }),
    );
    expect(finalizeInboundContext).toHaveBeenCalledTimes(2);
    {
      expectSomeBodyContaining(inboundHistoryBodies(finalizeInboundContext, 1), "pending msg");
    }
  });

  it("retrying the same failed trigger reuses the original history window", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createFinalDeliveryFailureHandler(finalizeInboundContext);

    await handler(
      DEFAULT_ROOM,
      makeRoomPlainEvent({ eventId: "$p", body: "pending msg", ts: 1000 }),
    );

    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ eventId: "$same", body: "trigger", ts: 2000 }),
    );
    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ eventId: "$same", body: "trigger", ts: 2000 }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledTimes(2);
    const firstHistory = finalizeInboundContextCall(finalizeInboundContext, 0)[
      "InboundHistory"
    ] as Array<{ body: string }>;
    const retryHistory = finalizeInboundContextCall(finalizeInboundContext, 1)[
      "InboundHistory"
    ] as Array<{ body: string }>;

    expect(firstHistory.map((entry) => entry.body)).toEqual(["pending msg"]);
    expect(retryHistory.map((entry) => entry.body)).toEqual(["pending msg"]);
  });

  it("records pending history before sender-name lookup resolves", async () => {
    let resolveFirstName: (() => void) | undefined;
    let firstNameLookupStarted = false;
    const getMemberDisplayName = vi.fn(async () => {
      firstNameLookupStarted = true;
      await new Promise<void>((resolve) => {
        resolveFirstName = resolve;
      });
      return "sender";
    });

    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 20,
      groupPolicy: "open",
      isDirectMessage: false,
      getMemberDisplayName,
      finalizeInboundContext,
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    // Unmentioned message should be buffered without waiting for async sender-name lookup.
    await handler(
      DEFAULT_ROOM,
      makeRoomPlainEvent({ eventId: "$slow-name", body: "plain before trigger", ts: 1000 }),
    );
    expect(firstNameLookupStarted).toBe(false);

    // Trigger reads pending history first, then can await sender-name lookup later.
    const triggerDone = handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ eventId: "$trigger-after-slow-name", body: "trigger", ts: 2000 }),
    );
    await vi.waitFor(() => {
      expect(firstNameLookupStarted).toBe(true);
    });
    resolveFirstName?.();
    await triggerDone;

    expectSomeBodyContaining(
      inboundHistoryBodies(finalizeInboundContext, 0),
      "plain before trigger",
    );
  });

  it("preserves arrival order when a plain message starts before a later trigger", async () => {
    let releaseFirstGetUserId: (() => void) | undefined;
    let getUserIdCalls = 0;

    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      historyLimit: 20,
      groupPolicy: "open",
      isDirectMessage: false,
      client: {
        async getUserId() {
          getUserIdCalls += 1;
          if (getUserIdCalls === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstGetUserId = resolve;
            });
          }
          return "@bot:example.org";
        },
        getEvent: async () => ({ sender: "@bot:example.org" }),
      },
      finalizeInboundContext,
      dispatchReplyFromConfig: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    const plainPromise = handler(
      DEFAULT_ROOM,
      makeRoomPlainEvent({ eventId: "$a", body: "msg A", ts: 1000 }),
    );
    await vi.waitFor(() => {
      expect(releaseFirstGetUserId).toBeTypeOf("function");
    });
    const triggerPromise = handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ eventId: "$b", body: "msg B", ts: 2000 }),
    );

    releaseFirstGetUserId?.();
    await Promise.all([plainPromise, triggerPromise]);

    const ctx = finalizeInboundContextCall(finalizeInboundContext, 0);
    const history = ctx["InboundHistory"] as Array<{ body: string }>;
    expect(history.map((entry) => entry.body)).toEqual(["msg A"]);
  });
});
