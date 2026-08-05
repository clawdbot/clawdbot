// Qqbot tests cover gateway connection close/disconnect status behavior.
import { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAdapters } from "../adapter/index.js";
import { stopBackgroundTokenRefresh } from "../messaging/sender.js";
import { flushRefIndex } from "../ref/store.js";
import { flushKnownUsers } from "../session/known-users.js";
import { GatewayEvent, GatewayOp, MAX_RECONNECT_ATTEMPTS } from "./constants.js";
import { GatewayConnection } from "./gateway-connection.js";
import { QQBotIngressAdmissionError, type QQBotIngressMonitor } from "./ingress.js";
import type { GatewayAccount, GatewayPluginRuntime } from "./types.js";

const createQQWSClientMock = vi.hoisted(() => vi.fn());

vi.mock("./ws-client.js", () => ({
  createQQWSClient: createQQWSClientMock,
}));

vi.mock("../messaging/sender.js", () => ({
  getAccessToken: vi.fn(async () => "test-token"),
  getGatewayUrl: vi.fn(async () => "wss://mock-gateway"),
  getPluginUserAgent: vi.fn(() => "test-agent"),
  startBackgroundTokenRefresh: vi.fn(),
  stopBackgroundTokenRefresh: vi.fn(),
  clearTokenCache: vi.fn(),
}));

vi.mock("../session/session-store.js", () => ({
  loadSession: vi.fn(() => undefined),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("../session/known-users.js", () => ({
  recordKnownUser: vi.fn(),
  flushKnownUsers: vi.fn(),
}));

vi.mock("../ref/store.js", () => ({
  flushRefIndex: vi.fn(),
}));

vi.mock("../commands/slash-command-handler.js", () => ({
  trySlashCommand: vi.fn(async () => "enqueue"),
}));

class FakeWebSocket extends EventEmitter {
  readyState = 3; // CLOSED — keeps cleanup() from re-entering close()
  close = vi.fn();
  terminate = vi.fn();
  send = vi.fn();
}

function createNoopIngressMonitor() {
  return {
    receive: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
  };
}

function makeAccount(): GatewayAccount {
  return {
    accountId: "test-account",
    appId: "test-app",
    clientSecret: "test-secret",
    markdownSupport: false,
    config: {},
  };
}

async function startConnection(params: {
  onDisconnected?: (info: unknown) => void;
  onError?: (error: Error) => void;
  createIngressMonitor?: () => QQBotIngressMonitor;
}) {
  const ws = new FakeWebSocket();
  createQQWSClientMock.mockResolvedValue(ws);
  const controller = new AbortController();
  const connection = new GatewayConnection({
    account: makeAccount(),
    abortSignal: controller.signal,
    cfg: {},
    runtime: {} as GatewayPluginRuntime,
    adapters: {} as EngineAdapters,
    handleMessage: async () => {},
    createIngressMonitor: createNoopIngressMonitor,
    ...(params.createIngressMonitor ? { createIngressMonitor: params.createIngressMonitor } : {}),
    onDisconnected: params.onDisconnected,
    onError: params.onError,
  });
  const started = connection.start();
  await vi.waitFor(() => {
    expect(createQQWSClientMock).toHaveBeenCalled();
  });
  return { ws, controller, started };
}

describe("GatewayConnection disconnect status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createQQWSClientMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reports a fatal disconnect when the close code says the bot is banned", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    ws.emit("close", 4915, Buffer.from(""));

    expect(onDisconnected).toHaveBeenCalledWith({ reason: "banned", fatal: true });
    controller.abort();
    await started;
  });

  it("reports a non-fatal disconnect on a transient close before reconnecting", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    ws.emit("close", 1006, Buffer.from(""));

    expect(onDisconnected).toHaveBeenCalledWith({ reason: "close code 1006", fatal: false });
    controller.abort();
    await started;
  });

  it("reports a fatal disconnect when reconnect attempts are exhausted", async () => {
    const onDisconnected = vi.fn();
    const sockets = Array.from({ length: MAX_RECONNECT_ATTEMPTS + 1 }, () => new FakeWebSocket());
    let socketIndex = 0;
    createQQWSClientMock.mockImplementation(async () => sockets[socketIndex++]);
    const controller = new AbortController();
    const connection = new GatewayConnection({
      account: makeAccount(),
      abortSignal: controller.signal,
      cfg: {},
      runtime: {} as GatewayPluginRuntime,
      adapters: {} as EngineAdapters,
      handleMessage: async () => {},
      createIngressMonitor: createNoopIngressMonitor,
      onDisconnected,
    });
    const started = connection.start();
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(1);
    });

    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      expectDefined(sockets[attempt], `QQBot socket ${attempt}`).emit(
        "close",
        1006,
        Buffer.from(""),
      );
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => {
        expect(createQQWSClientMock).toHaveBeenCalledTimes(attempt + 2);
      });
    }
    expectDefined(sockets[MAX_RECONNECT_ATTEMPTS], "final QQBot socket").emit(
      "close",
      1006,
      Buffer.from(""),
    );

    expect(onDisconnected).toHaveBeenCalledWith({
      reason: "reconnect attempts exhausted",
      fatal: true,
    });
    controller.abort();
    await started;
  });

  it("ignores a stale close from a superseded socket after a server-driven reconnect", async () => {
    const onDisconnected = vi.fn();
    const staleWs = new FakeWebSocket();
    const replacementWs = new FakeWebSocket();
    createQQWSClientMock.mockResolvedValueOnce(staleWs).mockResolvedValueOnce(replacementWs);
    const controller = new AbortController();
    const connection = new GatewayConnection({
      account: makeAccount(),
      abortSignal: controller.signal,
      cfg: {},
      runtime: {} as GatewayPluginRuntime,
      adapters: {} as EngineAdapters,
      handleMessage: async () => {},
      createIngressMonitor: createNoopIngressMonitor,
      onDisconnected,
    });
    const started = connection.start();
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(1);
    });

    // Server asks for a reconnect: the old socket is torn down and a
    // replacement is scheduled, then becomes live.
    staleWs.emit("open");
    staleWs.emit("message", JSON.stringify({ op: 7 }));
    await vi.waitFor(() => {
      expect(onDisconnected).toHaveBeenCalledWith({
        reason: "server requested reconnect",
        fatal: false,
      });
    });
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(2);
    });
    replacementWs.emit("open");

    // The superseded socket's close arrives late; it must not regress
    // the live replacement's status.
    staleWs.emit("close", 1000, Buffer.from(""));

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    controller.abort();
    await started;
  });

  it("ignores a stale close while a server-driven reconnect is pending", async () => {
    const onDisconnected = vi.fn();
    const staleWs = new FakeWebSocket();
    const replacementWs = new FakeWebSocket();
    createQQWSClientMock.mockResolvedValueOnce(staleWs).mockResolvedValueOnce(replacementWs);
    const controller = new AbortController();
    const connection = new GatewayConnection({
      account: makeAccount(),
      abortSignal: controller.signal,
      cfg: {},
      runtime: {} as GatewayPluginRuntime,
      adapters: {} as EngineAdapters,
      handleMessage: async () => {},
      createIngressMonitor: createNoopIngressMonitor,
      onDisconnected,
    });
    const started = connection.start();
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(1);
    });

    staleWs.emit("open");
    staleWs.emit("message", JSON.stringify({ op: 7 }));
    await vi.waitFor(() => {
      expect(onDisconnected).toHaveBeenCalledWith({
        reason: "server requested reconnect",
        fatal: false,
      });
    });
    staleWs.emit("close", 1006, Buffer.from(""));

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.waitFor(() => {
      expect(createQQWSClientMock).toHaveBeenCalledTimes(2);
    });

    controller.abort();
    await started;
  });

  it("reports a disconnect when the server invalidates the session", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    ws.emit("open");
    ws.emit("message", JSON.stringify({ op: 9, d: false }));

    await vi.waitFor(() => {
      expect(onDisconnected).toHaveBeenCalledWith({
        reason: "session invalidated",
        fatal: false,
      });
    });

    controller.abort();
    await started;
  });

  it("does not report a disconnect for the close caused by an intentional abort", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    controller.abort();
    ws.emit("close", 1000, Buffer.from(""));

    expect(onDisconnected).not.toHaveBeenCalled();
    await started;
  });

  it("continues shutdown cleanup and rejects when one cleanup step fails", async () => {
    const cleanupError = new Error("ingress stop failed");
    const stop = vi.fn(async () => {
      throw cleanupError;
    });
    const { controller, started } = await startConnection({
      createIngressMonitor: () => ({
        receive: vi.fn(async () => {}),
        stop,
        waitForIdle: vi.fn(async () => {}),
      }),
    });

    controller.abort();

    await expect(started).rejects.toBe(cleanupError);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopBackgroundTokenRefresh).toHaveBeenCalledWith("test-app");
    expect(flushKnownUsers).toHaveBeenCalledTimes(1);
    expect(flushRefIndex).toHaveBeenCalledTimes(1);
  });

  it("observes shutdown rejection while the initial connection is pending", async () => {
    vi.useRealTimers();
    const cleanupError = new Error("ingress stop failed");
    const ws = new FakeWebSocket();
    let resolveSocket!: (socket: FakeWebSocket) => void;
    createQQWSClientMock.mockReturnValue(
      new Promise<FakeWebSocket>((resolve) => {
        resolveSocket = resolve;
      }),
    );
    const controller = new AbortController();
    const connection = new GatewayConnection({
      account: makeAccount(),
      abortSignal: controller.signal,
      cfg: {},
      runtime: {} as GatewayPluginRuntime,
      adapters: {} as EngineAdapters,
      handleMessage: async () => {},
      createIngressMonitor: () => ({
        receive: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          throw cleanupError;
        }),
        waitForIdle: vi.fn(async () => {}),
      }),
    });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const started = connection.start();
      await vi.waitFor(() => expect(createQQWSClientMock).toHaveBeenCalledTimes(1));

      controller.abort();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(unhandledRejections).toStrictEqual([]);
      resolveSocket(ws);
      await expect(started).rejects.toBe(cleanupError);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("terminates the socket when durable admission fails closed", async () => {
    const admissionError = new QQBotIngressAdmissionError("sqlite unavailable");
    const receive = vi.fn(async () => {
      throw admissionError;
    });
    const onError = vi.fn();
    const { ws, controller, started } = await startConnection({
      onError,
      createIngressMonitor: () => ({
        receive,
        stop: vi.fn(async () => {}),
        waitForIdle: vi.fn(async () => {}),
      }),
    });

    const event = JSON.stringify({
      op: GatewayOp.DISPATCH,
      t: GatewayEvent.C2C_MESSAGE_CREATE,
      d: {
        id: "message-1",
        content: "hello",
        timestamp: "2026-07-18T12:00:00Z",
        author: { user_openid: "user-1" },
      },
    });
    ws.emit("message", event);
    ws.emit("message", event);

    await vi.waitFor(() => expect(ws.terminate).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(receive).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(admissionError);
    controller.abort();
    await started;
  });
});

describe("GatewayConnection heartbeat liveness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createQQWSClientMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not terminate when heartbeats are ACKed within the interval", async () => {
    const { ws, controller, started } = await startConnection({});
    ws.readyState = 1; // OPEN so the heartbeat sender fires
    ws.emit("open");
    ws.emit("message", JSON.stringify({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } }));

    // Advance one interval, then deliver the ACK for that heartbeat.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"op":1'));
    ws.emit("message", JSON.stringify({ op: GatewayOp.HEARTBEAT_ACK }));
    await vi.advanceTimersByTimeAsync(10_000);
    ws.emit("message", JSON.stringify({ op: GatewayOp.HEARTBEAT_ACK }));

    expect(ws.terminate).not.toHaveBeenCalled();
    controller.abort();
    await started;
  });

  it("terminates a half-open connection whose heartbeats receive no ACK", async () => {
    // A connection that sends heartbeats but never receives Op 11 must be torn
    // down so handleClose → scheduleReconnect re-establishes delivery.
    const { ws, controller, started } = await startConnection({});
    ws.readyState = 1; // OPEN so the heartbeat sender fires
    ws.emit("open");
    ws.emit("message", JSON.stringify({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } }));

    // tick 1: sends heartbeat 1 (outstanding=1), no ACK.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"op":1'));
    // tick 2: sends heartbeat 2 (outstanding=2), no ACK.
    await vi.advanceTimersByTimeAsync(10_000);
    // tick 3: two unanswered sends → terminate.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(ws.terminate).toHaveBeenCalledTimes(1);
    controller.abort();
    await started;
  });

  it("clears an ACK that arrives while socketMessageTail is blocked by ingress", async () => {
    // Guards the pre-tail ACK path: even with a DISPATCH holding the serialized
    // queue open inside ingress.receive(), an Op 11 must still reset the counter.
    let releaseIngress!: () => void;
    const receive = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseIngress = resolve;
        }),
    );
    const { ws, controller, started } = await startConnection({
      createIngressMonitor: () => ({
        receive,
        stop: vi.fn(async () => {}),
        waitForIdle: vi.fn(async () => {}),
      }),
    });
    ws.readyState = 1; // OPEN
    ws.emit("open");
    ws.emit("message", JSON.stringify({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } }));

    // tick 1: send heartbeat 1.
    await vi.advanceTimersByTimeAsync(10_000);
    // A DISPATCH enters ingress.receive() and blocks the serialized queue.
    ws.emit(
      "message",
      JSON.stringify({
        op: GatewayOp.DISPATCH,
        t: GatewayEvent.C2C_MESSAGE_CREATE,
        d: {
          id: "m1",
          content: "hi",
          timestamp: "2026-07-18T12:00:00Z",
          author: { user_openid: "u1" },
        },
      }),
    );
    await vi.waitFor(() => expect(receive).toHaveBeenCalled());
    // tick 2: send heartbeat 2 while the queue is still blocked.
    await vi.advanceTimersByTimeAsync(10_000);
    // The ACK for heartbeat 1 arrives now — it must reset the counter despite the
    // blocked queue, or the next tick would falsely terminate a live socket.
    ws.emit("message", JSON.stringify({ op: GatewayOp.HEARTBEAT_ACK }));
    // tick 3: counter was reset, so this sends heartbeat 3 instead of terminating.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(ws.terminate).not.toHaveBeenCalled();
    releaseIngress();
    controller.abort();
    await started;
  });

  it("does not throw on a malformed null frame and keeps handling later frames", async () => {
    // A syntactically valid but non-object frame (JSON null) must not escape the
    // synchronous message listener as an uncaught exception.
    const { ws, controller, started } = await startConnection({});
    ws.readyState = 1; // OPEN
    ws.emit("open");
    ws.emit("message", JSON.stringify({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } }));
    // tick 1: send heartbeat 1 (outstanding=1).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"op":1'));

    // A syntactically valid but non-object frame (JSON null) must not escape the
    // synchronous message listener as an uncaught exception or terminate the socket.
    ws.emit("message", "null");
    await Promise.resolve();
    expect(ws.terminate).not.toHaveBeenCalled();

    // The ACK for heartbeat 1 still resets the counter after the malformed frame.
    ws.emit("message", JSON.stringify({ op: GatewayOp.HEARTBEAT_ACK }));
    await vi.advanceTimersByTimeAsync(10_000); // tick 2: pre-send 0 < 2 → send (outstanding=1)
    await vi.advanceTimersByTimeAsync(10_000); // tick 3: pre-send 1 < 2 → send (outstanding=2)
    expect(ws.terminate).not.toHaveBeenCalled();
    controller.abort();
    await started;
  });
});
