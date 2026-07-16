import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime-api.js";
import {
  createMattermostConnectOnce,
  type MattermostWebSocketLike,
  WebSocketClosedBeforeOpenError,
} from "./monitor-websocket.js";

class FakeWebSocket implements MattermostWebSocketLike {
  public readonly sent: string[] = [];
  public closeCalls = 0;
  public terminateCalls = 0;
  private openListeners: Array<() => void> = [];
  private messageListeners: Array<(data: Buffer) => void | Promise<void>> = [];
  private closeListeners: Array<(code: number, reason: Buffer) => void> = [];
  private errorListeners: Array<(err: unknown) => void> = [];

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void | Promise<void>): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  on(event: "open" | "message" | "close" | "error", listener: unknown): void {
    if (event === "open") {
      this.openListeners.push(listener as () => void);
      return;
    }
    if (event === "message") {
      this.messageListeners.push(listener as (data: Buffer) => void | Promise<void>);
      return;
    }
    if (event === "close") {
      this.closeListeners.push(listener as (code: number, reason: Buffer) => void);
      return;
    }
    this.errorListeners.push(listener as (err: unknown) => void);
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

    const failure = connectOnce();
    await expect(failure).rejects.toBeInstanceOf(WebSocketClosedBeforeOpenError);
    await expect(failure).rejects.toMatchObject({
      message: "websocket closed before open (code 1006)",
    });
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
    await expect(firstAttempt).rejects.toBeInstanceOf(WebSocketClosedBeforeOpenError);

    await connectOnce();

    expect(sockets).toHaveLength(2);
    expect(sockets[0].closeCalls).toBe(1);
    expect(sockets[1].sent).toHaveLength(1);
    expect(JSON.parse(sockets[1].sent[0])).toMatchObject({
      action: "authentication_challenge",
      data: { token: "token" },
      seq: 1,
    });
    expect(patches.some((patch) => patch.connected === true)).toBe(true);
    expect(patches.filter((patch) => patch.connected === false)).toHaveLength(2);
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
    const payload = onReaction.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      event: "reaction_added",
      data: {
        reaction: JSON.stringify({
          user_id: "user-1",
          post_id: "post-1",
          emoji_name: "thumbsup",
        }),
      },
    });
    expect(payload.data?.reaction).toBe(
      JSON.stringify({
        user_id: "user-1",
        post_id: "post-1",
        emoji_name: "thumbsup",
      }),
    );
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
});
