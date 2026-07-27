import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { JsonValue } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter, type CodexAppServerServerRequest } from "./turn-router.js";

const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;

type ClientHarness = ReturnType<typeof createClientHarness>;

type WireResponse = {
  id: number | string;
  result?: unknown;
  error?: unknown;
};

describe("CodexAppServerTurnRouter", () => {
  const clients: CodexAppServerClient[] = [];

  afterEach(() => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createHarness(): ClientHarness {
    const harness = createClientHarness();
    clients.push(harness.client);
    return harness;
  }

  it("installs one request and notification handler per client", () => {
    const harness = createHarness();
    const addNotificationHandler = vi.spyOn(harness.client, "addNotificationHandler");
    const addRequestHandler = vi.spyOn(harness.client, "addRequestHandler");
    const addCloseHandler = vi.spyOn(harness.client, "addCloseHandler");

    const first = getCodexAppServerTurnRouter(harness.client);
    const second = getCodexAppServerTurnRouter(harness.client);

    expect(second).toBe(first);
    expect(addNotificationHandler).toHaveBeenCalledTimes(1);
    expect(addRequestHandler).toHaveBeenCalledTimes(1);
    expect(addCloseHandler).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a request that times out before route activation", async () => {
    vi.useFakeTimers();
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    const requestHandler = vi.fn(() => ({ executed: true }));
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-late",
    });

    harness.send({
      id: "request-late",
      method: "item/tool/call",
      params: { threadId: "thread-late", turnId: "turn-late", tool: "message" },
    });
    await vi.advanceTimersByTimeAsync(CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS);
    expect(await waitForResponse(harness, "request-late")).toMatchObject({
      id: "request-late",
      result: { success: false },
    });

    await route.activate({ onRequest: requestHandler });

    expect(requestHandler).not.toHaveBeenCalled();
  });

  it("routes concurrent traffic to the exact thread and turn", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const firstNotifications = vi.fn();
    const secondNotifications = vi.fn();
    const firstRequests = vi.fn(() => ({ owner: "first" }));
    const secondRequests = vi.fn(() => ({ owner: "second" }));
    const first = router.reserveThread({
      threadId: "thread-1",
      onNotification: firstNotifications,
      onRequest: firstRequests,
    });
    const second = router.reserveThread({
      threadId: "thread-2",
      onNotification: secondNotifications,
      onRequest: secondRequests,
    });
    first.armTurn();
    second.armTurn();
    await Promise.all([first.bindTurn("turn-1"), second.bindTurn("turn-2")]);

    harness.send({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", turnId: "turn-2", delta: "right" },
    });
    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-2", turn: { id: "turn-2", items: [] } },
    });
    harness.send({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", turnId: "turn-stale", delta: "wrong" },
    });
    harness.send({
      id: "request-2",
      method: "item/tool/call",
      params: { threadId: "thread-2", turnId: "turn-2", tool: "second" },
    });
    harness.send({
      id: "request-1",
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-1", tool: "first" },
    });

    await vi.waitFor(() => expect(secondNotifications).toHaveBeenCalledTimes(2));
    const firstResponse = await waitForResponse(harness, "request-1");
    const secondResponse = await waitForResponse(harness, "request-2");

    expect(firstNotifications).not.toHaveBeenCalled();
    expect(secondNotifications).toHaveBeenCalledWith(
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-2", turnId: "turn-2", delta: "right" },
      },
      { threadId: "thread-2", turnId: "turn-2" },
    );
    expect(secondNotifications).toHaveBeenCalledWith(
      {
        method: "turn/completed",
        params: { threadId: "thread-2", turn: { id: "turn-2", items: [] } },
      },
      { threadId: "thread-2", turnId: "turn-2" },
    );
    expect(firstRequests).toHaveBeenCalledTimes(1);
    expect(secondRequests).toHaveBeenCalledTimes(1);
    expect(firstResponse).toEqual({ id: "request-1", result: { owner: "first" } });
    expect(secondResponse).toEqual({ id: "request-2", result: { owner: "second" } });
  });

  it("warns once only for a thread-correlated stale turn notification", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    const notifications = vi.fn();
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-1",
      onNotification: notifications,
    });
    route.armTurn();
    await route.bindTurn("turn-current");
    const staleNotification = {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-stale",
        itemId: "msg-stale",
        delta: "ignored",
      },
    };

    harness.send(staleNotification);
    harness.send(staleNotification);
    harness.send({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "active" } },
    });
    harness.send({ method: "configWarning", params: { message: "global" } });
    await settleInput();

    expect(notifications).toHaveBeenCalledOnce();
    expect(notifications).toHaveBeenCalledWith(
      {
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "active" } },
      },
      { threadId: "thread-1" },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("codex app-server notification ignored for inactive turn", {
      eventKind: "item/agentMessage/delta",
      activeThreadId: "thread-1",
      activeTurnId: "turn-current",
      threadId: "thread-1",
      turnId: "turn-stale",
      matchesActiveThread: true,
      matchesActiveTurn: false,
    });
  });

  it("buffers pre-bind notifications in order and filters the bound turn", async () => {
    const harness = createHarness();
    const methods: string[] = [];
    const receivedMethods: string[] = [];
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-1",
      onNotificationReceived: (notification) => {
        receivedMethods.push(notification.method);
      },
      onNotification: async (notification) => {
        await Promise.resolve();
        methods.push(notification.method);
      },
    });
    route.armTurn();

    harness.send({
      method: "thread/started",
      params: { thread: { id: "thread-1" } },
    });
    harness.send({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    harness.send({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "active" } },
    });
    harness.send({
      method: "item/completed",
      params: { threadId: "thread-1", turnId: "turn-stale" },
    });
    harness.send({
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await settleInput();

    expect(methods).toEqual([]);
    expect(receivedMethods).toEqual([]);
    await route.bindTurn("turn-1");

    expect(receivedMethods).toEqual([
      "thread/started",
      "item/started",
      "thread/status/changed",
      "turn/started",
    ]);
    expect(methods).toEqual([
      "thread/started",
      "item/started",
      "thread/status/changed",
      "turn/started",
    ]);
  });

  it("flushes prior notifications before releasing a bound request", async () => {
    const harness = createHarness();
    const events: string[] = [];
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-ordered",
      onNotification: async (notification) => {
        events.push(`${notification.method}:start`);
        if (notification.method === "item/started") {
          await firstPending;
        }
        events.push(`${notification.method}:end`);
      },
      onRequest: () => {
        events.push("request");
        return { success: true, contentItems: [] };
      },
    });
    route.armTurn();
    harness.send({
      method: "item/started",
      params: { threadId: "thread-ordered", turnId: "turn-ordered" },
    });
    harness.send({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-ordered", turnId: "turn-ordered", delta: "done" },
    });
    harness.send({
      id: "request-ordered",
      method: "item/tool/call",
      params: { threadId: "thread-ordered", turnId: "turn-ordered", tool: "message" },
    });

    const binding = route.bindTurn("turn-ordered");
    await vi.waitFor(() => expect(events).toEqual(["item/started:start"]));
    expect(harness.writes).toEqual([]);

    finishFirst();
    await binding;
    expect(await waitForResponse(harness, "request-ordered")).toEqual({
      id: "request-ordered",
      result: { success: true, contentItems: [] },
    });
    expect(events).toEqual([
      "item/started:start",
      "item/started:end",
      "item/agentMessage/delta:start",
      "item/agentMessage/delta:end",
      "request",
    ]);
  });

  it("records receipt synchronously and drains accepted work after release", async () => {
    const harness = createHarness();
    const events: string[] = [];
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-receive",
      onNotificationReceived: (notification) => {
        events.push(`${notification.method}:received`);
      },
      onNotification: async (notification) => {
        events.push(`${notification.method}:start`);
        if (notification.method === "item/started") {
          await firstPending;
        }
        events.push(`${notification.method}:end`);
      },
    });
    harness.send({
      method: "item/started",
      params: { threadId: "thread-receive", turnId: "turn-receive" },
    });
    harness.send({
      method: "item/completed",
      params: { threadId: "thread-receive", turnId: "turn-receive" },
    });

    await vi.waitFor(() => expect(events).toContain("item/started:start"));
    expect(events.slice(0, 3)).toEqual([
      "item/started:received",
      "item/completed:received",
      "item/started:start",
    ]);

    route.release();
    finishFirst();
    await route.drain();
    expect(events).toEqual([
      "item/started:received",
      "item/completed:received",
      "item/started:start",
      "item/started:end",
      "item/completed:start",
      "item/completed:end",
    ]);
  });

  it("releases routing waiters without waiting for an async notification", async () => {
    const harness = createHarness();
    let notificationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notificationStarted = resolve;
    });
    const neverFinishes = new Promise<void>(() => {});
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-release-tail",
      onNotification: async () => {
        notificationStarted();
        await neverFinishes;
      },
      onRequest: () => ({ decision: "accept" }),
    });
    route.armTurn();
    harness.send({
      method: "item/started",
      params: { threadId: "thread-release-tail", turnId: "turn-release-tail" },
    });
    harness.send({
      id: "request-release-tail",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-release-tail",
        turnId: "turn-release-tail",
        itemId: "item-1",
      },
    });
    const binding = route.bindTurn("turn-release-tail");
    await started;

    route.release();

    await expect(binding).rejects.toThrow("thread route is released");
    expect(await waitForResponse(harness, "request-release-tail")).toEqual({
      id: "request-release-tail",
      result: { decision: "decline" },
    });
  });

  it("delivers open-route notifications while an armed route waits", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const threadHandler = vi.fn();
    const turnHandler = vi.fn();
    router.reserveThread({
      threadId: "thread-live",
      onNotification: threadHandler,
    });
    const turnRoute = router.reserveThread({
      threadId: "thread-buffered",
      onNotification: turnHandler,
    });
    turnRoute.armTurn();

    const liveNotification = {
      method: "thread/status/changed",
      params: { threadId: "thread-live", status: { type: "active" } },
    };
    const bufferedNotification = {
      method: "item/started",
      params: { threadId: "thread-buffered", turnId: "turn-buffered" },
    };
    harness.send(liveNotification);
    harness.send(bufferedNotification);

    await vi.waitFor(() =>
      expect(threadHandler).toHaveBeenCalledWith(liveNotification, {
        threadId: "thread-live",
      }),
    );
    expect(turnHandler).not.toHaveBeenCalled();

    await turnRoute.bindTurn("turn-buffered");
    expect(turnHandler).toHaveBeenCalledWith(bufferedNotification, {
      threadId: "thread-buffered",
      turnId: "turn-buffered",
    });
  });

  it("holds dormant traffic until one-shot activation", async () => {
    const harness = createHarness();
    const events: string[] = [];
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-dormant",
    });
    route.armTurn();

    harness.send({
      method: "thread/status/changed",
      params: { threadId: "thread-dormant", status: { type: "active" } },
    });
    harness.send({
      method: "item/started",
      params: { threadId: "thread-dormant", turnId: "turn-dormant" },
    });
    harness.send({
      id: "request-dormant-thread",
      method: "mcpServer/elicitation/request",
      params: { threadId: "thread-dormant", turnId: null },
    });
    harness.send({
      id: "request-dormant-turn",
      method: "item/tool/call",
      params: { threadId: "thread-dormant", turnId: "turn-dormant" },
    });
    await settleInput();

    expect(events).toEqual([]);
    expect(harness.writes).toEqual([]);
    expect(route.signal.aborted).toBe(false);
    await expect(route.bindTurn("turn-dormant")).rejects.toThrow(
      "thread route must be activated before binding a turn",
    );
    await expect(route.activate({})).rejects.toThrow(
      "thread route requires a notification or request handler",
    );

    await route.activate({
      onNotification: async (notification) => {
        await Promise.resolve();
        events.push(`notification:${notification.method}`);
      },
      onRequest: (request): JsonValue => {
        events.push(`request:${request.method}`);
        return request.method === "item/tool/call"
          ? { success: true, contentItems: [] }
          : { action: "accept" };
      },
    });

    expect(events).toEqual([]);
    expect(harness.writes.map((line) => JSON.parse(line) as WireResponse)).not.toContainEqual(
      expect.objectContaining({ id: "request-dormant-turn" }),
    );

    await route.bindTurn("turn-dormant");
    expect(events.slice(0, 2)).toEqual([
      "notification:thread/status/changed",
      "notification:item/started",
    ]);
    expect(await waitForResponse(harness, "request-dormant-thread")).toEqual({
      id: "request-dormant-thread",
      result: { action: "accept" },
    });
    expect(await waitForResponse(harness, "request-dormant-turn")).toEqual({
      id: "request-dormant-turn",
      result: { success: true, contentItems: [] },
    });
    expect(events.at(-1)).toBe("request:item/tool/call");
    await expect(route.activate({ onRequest: vi.fn() })).rejects.toThrow(
      "thread route already activated",
    );
  });

  it("waits for binding before validating turn-scoped requests", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const matchingHandler = vi.fn(() => ({ success: true, contentItems: [] }));
    const matchingRoute = router.reserveThread({
      threadId: "thread-match",
      onRequest: matchingHandler,
    });
    matchingRoute.armTurn();

    harness.send({
      id: "request-match",
      method: "item/tool/call",
      params: { threadId: "thread-match", turnId: "turn-match", tool: "message" },
    });
    await settleInput();

    expect(matchingHandler).not.toHaveBeenCalled();
    expect(harness.writes).toEqual([]);

    await matchingRoute.bindTurn("turn-match");
    await expect(waitForResponse(harness, "request-match")).resolves.toEqual({
      id: "request-match",
      result: { success: true, contentItems: [] },
    });
    expect(matchingHandler).toHaveBeenCalledTimes(1);

    const staleHandler = vi.fn(() => ({ success: true, contentItems: [] }));
    const staleRoute = router.reserveThread({
      threadId: "thread-stale",
      onRequest: staleHandler,
    });
    staleRoute.armTurn();
    harness.send({
      id: "request-stale",
      method: "item/tool/call",
      params: { threadId: "thread-stale", turnId: "turn-stale", tool: "message" },
    });
    await settleInput();

    expect(staleHandler).not.toHaveBeenCalled();
    await staleRoute.bindTurn("turn-current");

    expect(await waitForResponse(harness, "request-stale")).toEqual({
      id: "request-stale",
      result: {
        contentItems: [
          {
            type: "inputText",
            text: "OpenClaw did not register a handler for this app-server tool call.",
          },
        ],
        success: false,
      },
    });
    expect(staleHandler).not.toHaveBeenCalled();
  });

  it("routes no-turn requests immediately after activation", async () => {
    const harness = createHarness();
    const handleRequest = (request: CodexAppServerServerRequest): JsonValue => {
      if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
        return { decision: "approved" };
      }
      return { action: "accept", content: { answer: "yes" } };
    };
    const handler = vi.fn(handleRequest);
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-1",
    });

    harness.send({
      id: "elicitation-1",
      method: "mcpServer/elicitation/request",
      params: { threadId: "thread-1", turnId: null, message: "Continue?" },
    });

    await settleInput();

    expect(handler).not.toHaveBeenCalled();
    expect(harness.writes).toEqual([]);

    await route.activate({ onRequest: handler });

    expect(await waitForResponse(harness, "elicitation-1")).toEqual({
      id: "elicitation-1",
      result: { action: "accept", content: { answer: "yes" } },
    });
    expect(handler).toHaveBeenCalledOnce();
    route.release();
  });

  it("keeps resumed-turn requests open until a new turn is armed", async () => {
    const harness = createHarness();
    const handler = vi.fn(() => undefined);
    const notificationHandler = vi.fn();
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-resumed",
      onRequest: handler,
      onNotification: notificationHandler,
    });

    harness.send({
      id: "old-turn-request",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-resumed", turnId: "turn-old", itemId: "item-old" },
    });
    await expect(waitForResponse(harness, "old-turn-request")).resolves.toEqual({
      id: "old-turn-request",
      result: { decision: "decline" },
    });
    expect(handler).toHaveBeenCalledTimes(1);

    route.armTurn();
    harness.send({
      id: "pending-turn-request",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-resumed", turnId: "turn-next", itemId: "item-next" },
    });
    const earlyError = {
      method: "error",
      params: { threadId: "thread-resumed", message: "turn start failed" },
    };
    harness.send(earlyError);
    await settleInput();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(notificationHandler).not.toHaveBeenCalled();

    await route.cancelTurn();
    expect(notificationHandler).toHaveBeenCalledWith(earlyError, {
      threadId: "thread-resumed",
    });
    await expect(waitForResponse(harness, "pending-turn-request")).resolves.toEqual({
      id: "pending-turn-request",
      result: { decision: "decline" },
    });
    expect(handler).toHaveBeenCalledTimes(2);

    route.armTurn();
    await route.bindTurn("turn-final");
    route.release();
  });

  it("consumes one native completion and clears stale completion when arming", async () => {
    const harness = createHarness();
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-native",
      onNotification: vi.fn(),
    });
    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-native", turn: { id: "turn-native", items: [] } },
    });
    await settleInput();

    await expect(route.waitForTurnCompletion({ timeoutMs: 10 })).resolves.toBe(true);
    await expect(route.waitForTurnCompletion({ timeoutMs: 1 })).resolves.toBe(false);

    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-native", turn: { id: "turn-stale", items: [] } },
    });
    await settleInput();
    route.armTurn();
    await expect(route.waitForTurnCompletion({ timeoutMs: 1 })).resolves.toBe(false);
    await route.cancelTurn();
  });

  it("settles an active native-completion waiter on completion, abort, and release", async () => {
    const harness = createHarness();
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-native-wait",
      onNotification: vi.fn(),
    });

    const completed = route.waitForTurnCompletion({ timeoutMs: 100 });
    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-native-wait", turn: { id: "turn-native", items: [] } },
    });
    await expect(completed).resolves.toBe(true);

    const controller = new AbortController();
    const aborted = route.waitForTurnCompletion({ timeoutMs: 100, signal: controller.signal });
    controller.abort("test");
    await expect(aborted).resolves.toBe(false);

    const released = route.waitForTurnCompletion({ timeoutMs: 100 });
    route.release();
    await expect(released).resolves.toBe(false);
  });

  it("watches one exact native turn without reserving its thread", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const watch = router.watchNativeTurnCompletion({
      threadId: "thread-native-watch",
      turnId: "turn-target",
      timeoutMs: 100,
    });
    const settled = vi.fn();
    void watch.completion.then(settled);

    const route = router.reserveThread({
      threadId: "thread-native-watch",
      onNotification: vi.fn(),
    });
    route.release();
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-native-watch",
        turn: { id: "turn-other", status: "completed" },
      },
    });
    await settleInput();
    expect(settled).not.toHaveBeenCalled();

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-native-watch",
        turn: { id: "turn-target", status: "completed" },
      },
    });
    await expect(watch.completion).resolves.toBe(true);
  });

  it("treats an exact non-retry error as native turn termination", async () => {
    const harness = createHarness();
    const watch = getCodexAppServerTurnRouter(harness.client).watchNativeTurnCompletion({
      threadId: "thread-native-error",
      turnId: "turn-native-error",
      timeoutMs: 100,
    });
    const settled = vi.fn();
    void watch.completion.then(settled);

    harness.send({
      method: "error",
      params: {
        threadId: "thread-native-error",
        turnId: "turn-native-error",
        error: { message: "retrying" },
        willRetry: true,
      },
    });
    await settleInput();
    expect(settled).not.toHaveBeenCalled();

    harness.send({
      method: "error",
      params: {
        threadId: "thread-native-error",
        turnId: "turn-native-error",
        error: { message: "review setup failed" },
        willRetry: false,
      },
    });
    await expect(watch.completion).resolves.toBe(true);
  });

  it("refreshes native turn idle timeout on exact progress", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const watch = getCodexAppServerTurnRouter(harness.client).watchNativeTurnCompletion({
      threadId: "thread-native-progress",
      turnId: "turn-native-progress",
      timeoutMs: 1_000,
    });
    const settled = vi.fn();
    void watch.completion.then(settled);

    await vi.advanceTimersByTimeAsync(900);
    harness.send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-native-progress",
        turnId: "turn-native-progress",
        delta: "working",
      },
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(settled).not.toHaveBeenCalled();

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-native-progress",
        turn: { id: "turn-native-progress", status: "completed" },
      },
    });
    await expect(watch.completion).resolves.toBe(true);
  });

  it("cancels a detached native-turn completion watch", async () => {
    const harness = createHarness();
    const watch = getCodexAppServerTurnRouter(harness.client).watchNativeTurnCompletion({
      threadId: "thread-native-cancel",
      turnId: "turn-native-cancel",
      timeoutMs: 100,
    });

    watch.cancel();

    await expect(watch.completion).resolves.toBe(false);
  });

  it("settles detached native-turn watches on timeout and client close", async () => {
    const timeoutHarness = createHarness();
    const timedOut = getCodexAppServerTurnRouter(timeoutHarness.client).watchNativeTurnCompletion({
      threadId: "thread-native-timeout",
      turnId: "turn-native-timeout",
      timeoutMs: 1,
    });
    await expect(timedOut.completion).resolves.toBe(false);

    const closeHarness = createHarness();
    const closed = getCodexAppServerTurnRouter(closeHarness.client).watchNativeTurnCompletion({
      threadId: "thread-native-close",
      turnId: "turn-native-close",
      timeoutMs: 100,
    });
    closeHarness.client.close();
    await expect(closed.completion).resolves.toBe(false);
  });

  it("releases pending requests and removes routes on cleanup", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const notificationHandler = vi.fn();
    const requestHandler = vi.fn(() => ({ decision: "accept" }));
    const route = router.reserveThread({
      threadId: "thread-release",
      onNotification: notificationHandler,
      onRequest: requestHandler,
    });
    route.armTurn();
    harness.send({
      id: "request-release",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-release",
        turnId: "turn-release",
        itemId: "item-1",
      },
    });
    await settleInput();

    route.release();
    harness.send({
      method: "item/started",
      params: { threadId: "thread-release", turnId: "turn-release" },
    });

    expect(await waitForResponse(harness, "request-release")).toEqual({
      id: "request-release",
      result: { decision: "decline" },
    });
    expect(notificationHandler).not.toHaveBeenCalled();
    expect(requestHandler).not.toHaveBeenCalled();

    let finishActiveRequest!: (result: { decision: string }) => void;
    const activeResult = new Promise<{ decision: string }>((resolve) => {
      finishActiveRequest = resolve;
    });
    let failActiveRequest!: (error: Error) => void;
    const rejectedActiveResult = new Promise<{ decision: string }>((_resolve, reject) => {
      failActiveRequest = reject;
    });
    const activeHandler = vi.fn((request: { id: number | string }) =>
      request.id === "request-active-reject" ? rejectedActiveResult : activeResult,
    );
    const activeRoute = router.reserveThread({
      threadId: "thread-active",
      onRequest: activeHandler,
    });
    activeRoute.armTurn();
    await activeRoute.bindTurn("turn-active");
    harness.send({
      id: "request-active",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-active",
        turnId: "turn-active",
        itemId: "item-2",
      },
    });
    harness.send({
      id: "request-active-reject",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-active",
        turnId: "turn-active",
        itemId: "item-3",
      },
    });
    await vi.waitFor(() => expect(activeHandler).toHaveBeenCalledTimes(2));

    activeRoute.release();
    finishActiveRequest({ decision: "accept" });
    failActiveRequest(new Error("stale request failure"));

    expect(await waitForResponse(harness, "request-active")).toEqual({
      id: "request-active",
      result: { decision: "decline" },
    });
    expect(await waitForResponse(harness, "request-active-reject")).toEqual({
      id: "request-active-reject",
      result: { decision: "decline" },
    });

    const closingRoute = router.reserveThread({
      threadId: "thread-close",
      onRequest: requestHandler,
    });
    harness.client.close();

    await expect(closingRoute.bindTurn("turn-close")).rejects.toThrow("turn router closed");
    expect(closingRoute.signal.aborted).toBe(true);
    expect(closingRoute.signal.reason).toEqual(new Error("codex app-server turn router closed"));
    expect(() =>
      router.reserveThread({ threadId: "thread-late", onRequest: requestHandler }),
    ).toThrow("turn router is closed");
  });

  it("releases dormant waiters and aborts the reservation", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const route = router.reserveThread({ threadId: "thread-dormant-release" });
    harness.send({
      id: "request-dormant-release",
      method: "item/tool/call",
      params: { threadId: "thread-dormant-release", turnId: "turn-1" },
    });
    await settleInput();

    route.release();

    expect(route.signal.aborted).toBe(true);
    expect(route.signal.reason).toEqual(new Error("codex app-server thread route is released"));
    await expect(route.activate({ onRequest: vi.fn() })).rejects.toThrow(
      "thread route is released",
    );
    await expect(route.bindTurn("turn-1")).rejects.toThrow("thread route is released");
    expect(await waitForResponse(harness, "request-dormant-release")).toEqual({
      id: "request-dormant-release",
      result: {
        contentItems: [
          {
            type: "inputText",
            text: "OpenClaw did not register a handler for this app-server tool call.",
          },
        ],
        success: false,
      },
    });
  });

  it("fails and removes a route when its pre-bind buffer is full", async () => {
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const route = router.reserveThread({
      threadId: "thread-overflow",
      onNotification: vi.fn(),
    });
    route.armTurn();
    for (let index = 0; index <= 256; index += 1) {
      harness.send({
        method: "item/started",
        params: { threadId: "thread-overflow", turnId: "turn-overflow" },
      });
    }
    await settleInput();

    await expect(route.bindTurn("turn-overflow")).rejects.toThrow(
      "pre-bind notification buffer exceeded 256 entries",
    );
    expect(() =>
      router.reserveThread({
        threadId: "thread-overflow",
        onNotification: vi.fn(),
      }),
    ).not.toThrow();
  });
});

async function waitForResponse(harness: ClientHarness, id: number | string): Promise<WireResponse> {
  let response: WireResponse | undefined;
  await vi.waitFor(() => {
    response = harness.writes
      .map((write) => JSON.parse(write) as WireResponse)
      .find((candidate) => candidate.id === id);
    expect(response).toBeDefined();
  });
  if (!response) {
    throw new Error(`missing app-server response for ${id}`);
  }
  return response;
}

async function settleInput(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
