// Mattermost tests cover monitor websocket plugin behavior.
import { once } from "node:events";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { RuntimeEnv } from "../../runtime-api.js";
import {
  createMattermostConnectOnce,
  type MattermostWebSocketFactory,
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

class FakeWebSocket implements ReturnType<MattermostWebSocketFactory> {
  public readonly sent: string[] = [];
  public pingCalls = 0;
  public closeCalls = 0;
  public terminateCalls = 0;
  private openListeners: Array<() => void> = [];
  private messageListeners: Array<(data: Buffer) => void | Promise<void>> = [];
  private pongListeners: Array<(data: Buffer) => void> = [];
  private closeListeners: Array<(code: number, reason: Buffer) => void> = [];
  private errorListeners: Array<(err: unknown) => void> = [];

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void | Promise<void>): void;
  on(event: "pong", listener: (data: Buffer) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  on(event: "open" | "message" | "pong" | "close" | "error", listener: unknown): void {
    if (event === "open") {
      this.openListeners.push(listener as () => void);
      return;
    }
    if (event === "message") {
      this.messageListeners.push(listener as (data: Buffer) => void | Promise<void>);
      return;
    }
    if (event === "pong") {
      this.pongListeners.push(listener as (data: Buffer) => void);
      return;
    }
    if (event === "close") {
      this.closeListeners.push(listener as (code: number, reason: Buffer) => void);
      return;
    }
    this.errorListeners.push(listener as (err: unknown) => void);
  }

  ping(): void {
    this.pingCalls++;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
  }

  terminate(): void {
    this.terminateCalls++;
  }

  emitOpen(): void {
    for (const listener of this.openListeners) {
      listener();
    }
  }

  emitMessage(data: Buffer): void {
    for (const listener of this.messageListeners) {
      void listener(data);
    }
  }

  emitPong(data = Buffer.alloc(0)): void {
    for (const listener of this.pongListeners) {
      listener(data);
    }
  }

  emitClose(code: number, reason = ""): void {
    const buffer = Buffer.from(reason, "utf8");
    for (const listener of this.closeListeners) {
      listener(code, buffer);
    }
  }

  emitError(err: unknown): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}

const testRuntime = (): RuntimeEnv =>
  ({
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  }) as RuntimeEnv;

async function startStalledWebSocketHandshakeServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => {
    accepted.push(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of accepted) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe("mattermost websocket monitor", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("rejects when websocket closes before open", async () => {
    const socket = new FakeWebSocket();
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
    });

    queueMicrotask(() => {
      socket.emitClose(1006, "connection refused");
    });

    let failure: unknown;
    try {
      await connectOnce();
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toMatchObject({
      name: "WebSocketClosedBeforeOpenError",
      code: 1006,
      reason: "connection refused",
    });
    expect((failure as Error).message).toBe("websocket closed before open (code 1006)");
  });

  it("retries when first attempt errors before open and next attempt succeeds", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const sockets: FakeWebSocket[] = [];

    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      onPosted: async () => {},
      statusSink: (patch) => {
        patches.push(patch as Record<string, unknown>);
      },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        const attempt = sockets.length;
        sockets.push(socket);
        queueMicrotask(() => {
          if (attempt === 0) {
            socket.emitError(new Error("boom"));
            socket.emitClose(1006, "connection refused");
            return;
          }
          socket.emitOpen();
          socket.emitClose(1000);
        });
        return socket;
      },
    });

    const firstAttempt = connectOnce();
    await expect(firstAttempt).rejects.toMatchObject({ name: "WebSocketClosedBeforeOpenError" });

    await connectOnce();

    expect(sockets).toHaveLength(2);
    const firstSocket = expectDefined(sockets[0], "first Mattermost socket");
    const secondSocket = expectDefined(sockets[1], "second Mattermost socket");
    expect(firstSocket.closeCalls).toBe(1);
    expect(secondSocket.sent).toHaveLength(1);
    expect(JSON.parse(expectDefined(secondSocket.sent[0], "Mattermost auth payload"))).toEqual({
      action: "authentication_challenge",
      data: { token: "token" },
      seq: 1,
    });
    expect(countMatching(patches, (patch) => patch.connected === true)).toBe(1);
    expect(countMatching(patches, (patch) => patch.connected === false)).toBe(2);
  });

  it("accepts large valid post envelopes and rejects oversized websocket payloads", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP websocket server address");
    }

    const quotedCardBody = '"'.repeat(380_000);
    const largeProps = { cards: [{ body: quotedCardBody }] };
    const largePostEnvelope = JSON.stringify({
      event: "posted",
      data: {
        post: JSON.stringify({
          id: "post-large",
          message: "large Mattermost integration post",
          props: largeProps,
        }),
      },
    });
    expect(JSON.stringify(largeProps).length).toBeLessThan(800_000);
    expect(Buffer.byteLength(largePostEnvelope)).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(largePostEnvelope)).toBeLessThan(16 * 1024 * 1024);

    const runtime = testRuntime();
    const onPosted = vi.fn(async () => {});
    server.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            event: "posted",
            data: {
              post: JSON.stringify({
                id: "post-1",
                message: "normal Mattermost post",
              }),
            },
          }),
        );
        socket.send(largePostEnvelope);
        socket.send(Buffer.alloc(16 * 1024 * 1024 + 1, 0x78));
      });
    });

    try {
      await createMattermostConnectOnce({
        wsUrl: `ws://127.0.0.1:${address.port}`,
        botToken: "token",
        runtime,
        nextSeq: () => 1,
        onPosted,
      })();
    } finally {
      server.close();
      await once(server, "close");
    }

    expect(onPosted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "post-1", message: "normal Mattermost post" }),
      expect.any(Object),
    );
    expect(onPosted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "post-large", props: largeProps }),
      expect.any(Object),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Max payload size exceeded"),
    );
  });

  it("dispatches reaction events to the reaction handler", async () => {
    const socket = new FakeWebSocket();
    const onPosted = vi.fn(async () => {});
    const onReaction = vi.fn(async (payload) => payload);
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted,
      onReaction,
      webSocketFactory: () => socket,
    });

    const connected = connectOnce();
    queueMicrotask(() => {
      socket.emitOpen();
      socket.emitMessage(
        Buffer.from(
          JSON.stringify({
            event: "reaction_added",
            data: {
              reaction: JSON.stringify({
                user_id: "user-1",
                post_id: "post-1",
                emoji_name: "thumbsup",
              }),
            },
          }),
        ),
      );
      socket.emitClose(1000);
    });

    await connected;

    expect(onReaction).toHaveBeenCalledTimes(1);
    expect(onPosted).not.toHaveBeenCalled();
    const reaction = JSON.stringify({
      user_id: "user-1",
      post_id: "post-1",
      emoji_name: "thumbsup",
    });
    const payload = onReaction.mock.calls.at(0)?.[0];
    expect(payload).toEqual({
      event: "reaction_added",
      data: { reaction },
    });
  });

  it("terminates when bot update_at changes (disable/enable cycle)", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const runtime = testRuntime();
    let updateAt = 1000;
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime,
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
      getBotUpdateAt: async () => updateAt,
      healthCheckIntervalMs: 100,
    });

    const connected = connectOnce();
    socket.emitOpen();

    // Let initial getBotUpdateAt resolve
    await vi.advanceTimersByTimeAsync(0);

    // update_at unchanged — no terminate
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.terminateCalls).toBe(0);

    // Simulate disable/enable — update_at changes
    updateAt = 2000;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.terminateCalls).toBe(1);
    expect(runtime.log).toHaveBeenCalledWith(
      "mattermost: bot account updated (update_at changed: 1000 → 2000) — reconnecting",
    );

    socket.emitClose(1006);
    await connected;
    vi.useRealTimers();
  });

  it("keeps connection alive when update_at stays the same", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
      getBotUpdateAt: async () => 1000,
      healthCheckIntervalMs: 100,
    });

    const connected = connectOnce();
    socket.emitOpen();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(socket.terminateCalls).toBe(0);

    socket.emitClose(1000);
    await connected;
    vi.useRealTimers();
  });

  it("continues protocol keepalive when Mattermost responds with pong", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
      pingIntervalMs: 100,
      pongTimeoutMs: 25,
    });

    const connected = connectOnce();
    socket.emitOpen();

    await vi.advanceTimersByTimeAsync(100);
    expect(socket.pingCalls).toBe(1);

    socket.emitPong();
    await vi.advanceTimersByTimeAsync(25);
    expect(socket.terminateCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(75);
    expect(socket.pingCalls).toBe(2);

    socket.emitClose(1000);
    await connected;
    vi.useRealTimers();
  });

  it("terminates silent websocket drops when Mattermost misses pong timeout", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const runtime = testRuntime();
    let pollCount = 0;
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime,
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
      getBotUpdateAt: async () => {
        pollCount++;
        return 1000;
      },
      healthCheckIntervalMs: 100,
      pingIntervalMs: 50,
      pongTimeoutMs: 25,
    });

    const connected = connectOnce();
    socket.emitOpen();

    await vi.advanceTimersByTimeAsync(0);
    expect(pollCount).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(socket.pingCalls).toBe(1);
    expect(socket.terminateCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(25);
    expect(socket.terminateCalls).toBe(1);
    expect(runtime.error).toHaveBeenCalledWith("mattermost websocket pong timeout — reconnecting");

    await vi.advanceTimersByTimeAsync(500);
    expect(socket.pingCalls).toBe(1);
    expect(pollCount).toBe(1);

    socket.emitClose(1006);
    await connected;
    vi.useRealTimers();
  });

  it("does not terminate when getBotUpdateAt throws", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const runtime = testRuntime();
    let shouldThrow = false;
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime,
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
      getBotUpdateAt: async () => {
        if (shouldThrow) {
          throw new Error("network error");
        }
        return 1000;
      },
      healthCheckIntervalMs: 100,
    });

    const connected = connectOnce();
    socket.emitOpen();

    await vi.advanceTimersByTimeAsync(0);

    // API error — should log but not terminate
    shouldThrow = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.terminateCalls).toBe(0);
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: health check error: Error: network error",
    );

    socket.emitClose(1000);
    await connected;
    vi.useRealTimers();
  });

  it("keeps polling when the initial getBotUpdateAt call fails", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const runtime = testRuntime();
    const responses: Array<number | Error> = [new Error("network error"), 1000, 2000];
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime,
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
      getBotUpdateAt: async () => {
        const next = responses.shift();
        if (next instanceof Error) {
          throw next;
        }
        return next ?? 2000;
      },
      healthCheckIntervalMs: 100,
    });

    const connected = connectOnce();
    socket.emitOpen();

    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: failed to get initial update_at: Error: network error",
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(socket.terminateCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(socket.terminateCalls).toBe(1);
    expect(runtime.log).toHaveBeenCalledWith(
      "mattermost: bot account updated (update_at changed: 1000 → 2000) — reconnecting",
    );

    socket.emitClose(1006);
    await connected;
    vi.useRealTimers();
  });

  it("does not overlap health checks when a prior poll is still running", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const resolvers: Array<(value: number) => void> = [];
    let pollCount = 0;
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: () => socket,
      getBotUpdateAt: async () => {
        pollCount++;
        return await new Promise<number>((resolve) => {
          resolvers.push(resolve);
        });
      },
      healthCheckIntervalMs: 100,
    });

    const connected = connectOnce();
    socket.emitOpen();

    await vi.advanceTimersByTimeAsync(0);
    expect(pollCount).toBe(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(pollCount).toBe(1);

    resolvers[0]?.(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(pollCount).toBe(2);

    socket.emitClose(1000);
    await connected;
    vi.useRealTimers();
  });

  it("passes bounded payload and handshake options to the websocket factory", async () => {
    const socket = new FakeWebSocket();
    let clientOptions: Parameters<MattermostWebSocketFactory>[1] | undefined;
    const connectOnce = createMattermostConnectOnce({
      wsUrl: "wss://example.invalid/api/v4/websocket",
      botToken: "token",
      runtime: testRuntime(),
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: (_url, options) => {
        clientOptions = options;
        queueMicrotask(() => socket.emitClose(1006));
        return socket;
      },
    });

    await expect(connectOnce()).rejects.toMatchObject({
      name: "WebSocketClosedBeforeOpenError",
    });
    expect(clientOptions).toEqual({
      handshakeTimeout: 30_000,
      maxPayload: 16 * 1024 * 1024,
    });
  });

  it("fails connect when the websocket handshake never completes", async () => {
    const stalledServer = await startStalledWebSocketHandshakeServer();

    try {
      const connectOnce = createMattermostConnectOnce({
        wsUrl: stalledServer.url,
        botToken: "token",
        runtime: testRuntime(),
        nextSeq: () => 1,
        onPosted: async () => {},
        webSocketFactory: (url, options) =>
          new WebSocket(url, {
            ...options,
            handshakeTimeout: 200,
          }) as ReturnType<MattermostWebSocketFactory>,
      });

      const outcome = await connectOnce().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        // ws surfaces handshake timeout as error then close-before-open (1006).
        expect(outcome.error).toMatchObject({ name: "WebSocketClosedBeforeOpenError" });
        console.log(
          `[mattermost handshake proof] timed_out=true name=${
            outcome.error instanceof Error ? outcome.error.name : typeof outcome.error
          } message=${
            outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
          }`,
        );
      }
    } finally {
      await stalledServer.close();
    }
  });

  it("returns control to reconnect after a stalled handshake", async () => {
    const stalledServer = await startStalledWebSocketHandshakeServer();

    const runtime = testRuntime();
    const reconnectDelays: number[] = [];
    const connectErrors: string[] = [];
    const connectOnce = createMattermostConnectOnce({
      wsUrl: stalledServer.url,
      botToken: "token",
      runtime,
      nextSeq: () => 1,
      onPosted: async () => {},
      webSocketFactory: (url, options) =>
        new WebSocket(url, {
          ...options,
          handshakeTimeout: 200,
        }) as ReturnType<MattermostWebSocketFactory>,
    });

    try {
      await runWithReconnect(connectOnce, {
        initialDelayMs: 50,
        maxDelayMs: 50,
        jitterRatio: 0,
        shouldReconnect: ({ attempt }) => attempt < 1,
        onError: (err) => {
          connectErrors.push(err instanceof Error ? err.name : String(err));
        },
        onReconnect: (delayMs) => {
          reconnectDelays.push(delayMs);
        },
      });

      // attempt 0 times out → reconnect; attempt 1 times out → stop.
      expect(connectErrors).toEqual([
        "WebSocketClosedBeforeOpenError",
        "WebSocketClosedBeforeOpenError",
      ]);
      expect(reconnectDelays).toEqual([50]);
      console.log(
        `[mattermost handshake reconnect proof] timeout_then_reconnect=true errors=${connectErrors.join(",")} reconnect_delays_ms=${reconnectDelays.join(",")}`,
      );
    } finally {
      await stalledServer.close();
    }
  });
});
