import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { JsonValue } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter, type CodexAppServerServerRequest } from "./turn-router.js";
import { settleInput, waitForResponse } from "./turn-router.test-support.js";

const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;

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

  function createHarness(): ReturnType<typeof createClientHarness> {
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

  it("delivers global startup warnings to the next reserved thread", async () => {
    const harness = createHarness();
    const warning = {
      method: "configWarning",
      params: { summary: "Custom execution rules were not applied." },
    };
    harness.send(warning);
    const notifications = vi.fn();

    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-warnings",
      onNotification: notifications,
    });
    route.armTurn();
    await route.bindTurn("turn-warnings");

    await vi.waitFor(() =>
      expect(notifications).toHaveBeenCalledWith(warning, { threadId: "thread-warnings" }),
    );
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

    expect(notifications).toHaveBeenCalledTimes(2);
    expect(notifications).toHaveBeenCalledWith(
      {
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "active" } },
      },
      { threadId: "thread-1" },
    );
    expect(notifications).toHaveBeenCalledWith(
      { method: "configWarning", params: { message: "global" } },
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

  it("routes no-turn requests and preserves exact cancellation before release", async () => {
    const harness = createHarness();
    const handleRequest = (request: CodexAppServerServerRequest): JsonValue => {
      if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
        return { decision: "approved" };
      }
      return { action: "cancel", content: null, _meta: null };
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
      result: { action: "cancel", content: null, _meta: null },
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

  it("consumes buffered exact native completions and clears them when arming", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const route = router.reserveThread({
      threadId: "thread-native",
    });
    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-native", turn: { id: "turn-native", items: [] } },
    });
    await settleInput();
    await route.activate({ onNotification: vi.fn() });
    expect(route.observedNativeTurnId).toBe("turn-native");
    const completion = (turnId: string, timeoutMs: number) =>
      router.watchNativeTurnCompletion({ threadId: route.threadId, turnId, timeoutMs }).completion;
    await expect(completion("turn-native", 10)).resolves.toBe(true);
    await expect(completion("turn-native", 1)).resolves.toBe(false);

    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-native", turn: { id: "turn-stale", items: [] } },
    });
    await settleInput();
    route.armTurn();
    expect(route.observedNativeTurnId).toBeUndefined();
    await expect(completion("turn-stale", 1)).resolves.toBe(false);
    await route.cancelTurn();
  });

  it("keeps an observed active native turn exact across arm and stale completion", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const route = router.reserveThread({
      threadId: "thread-native-active",
      onNotification: vi.fn(),
    });
    harness.send({
      method: "turn/started",
      params: {
        threadId: "thread-native-active",
        turn: { id: "turn-compact", status: "inProgress" },
      },
    });
    await settleInput();

    route.armTurn();
    expect(route.observedNativeTurnId).toBe("turn-compact");
    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-native-active", turn: { id: "turn-stale", items: [] } },
    });
    await settleInput();
    expect(route.observedNativeTurnId).toBe("turn-compact");

    const completed = router.watchNativeTurnCompletion({
      threadId: "thread-native-active",
      turnId: "turn-compact",
      timeoutMs: 100,
    });
    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-native-active", turn: { id: "turn-compact", items: [] } },
    });
    await expect(completed.completion).resolves.toBe(true);
    await route.cancelTurn();
  });

  it("settles exact native-completion watchers on completion, abort, and route release", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const route = router.reserveThread({
      threadId: "thread-native-wait",
      onNotification: vi.fn(),
    });

    const completed = router.watchNativeTurnCompletion({
      threadId: "thread-native-wait",
      turnId: "turn-native",
      timeoutMs: 100,
    });
    harness.send({
      method: "turn/completed",
      params: { threadId: "thread-native-wait", turn: { id: "turn-native", items: [] } },
    });
    await expect(completed.completion).resolves.toBe(true);

    const controller = new AbortController();
    const aborted = router.watchNativeTurnCompletion({
      threadId: "thread-native-wait",
      turnId: "turn-aborted",
      timeoutMs: 100,
      signal: controller.signal,
    });
    controller.abort("test");
    await expect(aborted.completion).resolves.toBe(false);
    const alreadyAborted = router.watchNativeTurnCompletion({
      threadId: "thread-native-wait",
      turnId: "turn-aborted",
      timeoutMs: 100,
      signal: controller.signal,
    });
    await expect(alreadyAborted.completion).resolves.toBe(false);

    const released = router.watchNativeTurnCompletion({
      threadId: "thread-native-wait",
      turnId: "turn-released",
      timeoutMs: 100,
      signal: route.signal,
    });
    route.release();
    await expect(released.completion).resolves.toBe(false);
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

  it("waits for completed notification after an exact non-retry error", async () => {
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
    await settleInput();
    expect(settled).not.toHaveBeenCalled();

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-native-error",
        turn: { id: "turn-native-error", status: "failed" },
      },
    });
    await expect(watch.completion).resolves.toBe(true);
  });

  it("keeps a hard completion deadline despite exact-turn progress", async () => {
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
    await vi.advanceTimersByTimeAsync(101);
    await expect(watch.completion).resolves.toBe(false);
    expect(settled).toHaveBeenCalledWith(false);
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

    const activeHandler = vi.fn(
      (request: { id: number | string }, _scope: unknown, signal: AbortSignal) =>
        new Promise<{ decision: string }>((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              if (request.id === "request-active-reject") {
                reject(new Error("stale request failure"));
                return;
              }
              resolve({ decision: "accept" });
            },
            { once: true },
          );
        }),
    );
    const activeRoute = router.reserveThread({
      threadId: "thread-active",
      onRequest: activeHandler,
    });
    activeRoute.armTurn();
    await activeRoute.bindTurn("turn-active");
    for (const [id, itemId] of [
      ["request-active", "item-2"],
      ["request-active-reject", "item-3"],
    ]) {
      harness.send({
        id,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-active", turnId: "turn-active", itemId },
      });
    }
    await vi.waitFor(() => expect(activeHandler).toHaveBeenCalledTimes(2));
    const activeSignals = () => activeHandler.mock.calls.map((call) => call[2].aborted);
    expect(activeSignals()).toEqual([false, false]);

    activeRoute.release();
    expect(activeSignals()).toEqual([true, true]);

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
      onRequest: activeHandler,
    });
    closingRoute.armTurn();
    await closingRoute.bindTurn("turn-close");
    harness.send({
      id: "request-close",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-close", turnId: "turn-close", itemId: "item-4" },
    });
    await vi.waitFor(() => expect(activeHandler).toHaveBeenCalledTimes(3));
    harness.process.stderr.write("fatal transport detail\n");
    harness.process.emit("exit", 17, "SIGTERM");

    await expect(closingRoute.bindTurn("turn-close")).rejects.toThrow("turn router closed");
    expect(activeHandler.mock.calls[2]?.[2].aborted).toBe(true);
    expect(closingRoute.signal.aborted).toBe(true);
    expect(closingRoute.signal.reason).toEqual(
      new Error("codex app-server turn router closed", {
        cause: new Error(
          'codex app-server exited: code=17 signal=SIGTERM stderr="fatal transport detail"',
        ),
      }),
    );
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
