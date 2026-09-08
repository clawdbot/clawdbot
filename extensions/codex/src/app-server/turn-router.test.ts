import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { JsonValue } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter, type CodexAppServerServerRequest } from "./turn-router.js";
import { settleInput, waitForResponse, type WireResponse } from "./turn-router.test-support.js";

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

  it("records receipt synchronously and drains accepted work before release", async () => {
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
    route.release();
  });

  it("drain resolves after release while a handler is blocked and routing waiters are pending", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const handler = vi.fn(() => new Promise<void>(() => {}));
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-release-tail",
      onNotification: handler,
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
    const binding = expect(route.bindTurn("turn-release-tail")).rejects.toThrow(
      "thread route is released",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();
    const result = Promise.race([
      Promise.all([route.drain(), binding]).then(() => "drained"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still blocked"), 1);
      }),
    ]);

    route.release();
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toBe("drained");
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
});
