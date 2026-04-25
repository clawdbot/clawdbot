import type { IncomingMessage } from "node:http";
import net from "node:net";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { MediaStreamHandler, sanitizeLogText } from "./media-stream.js";
import {
  connectWs,
  startUpgradeWsServer,
  waitForClose,
  withTimeout,
} from "./websocket-test-support.js";

const createStubSession = (): RealtimeTranscriptionSession => ({
  connect: async () => {},
  sendAudio: () => {},
  close: () => {},
  isConnected: () => true,
});

const createStubSttProvider = (): RealtimeTranscriptionProviderPlugin =>
  ({
    createSession: () => createStubSession(),
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
  }) as unknown as RealtimeTranscriptionProviderPlugin;

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const startWsServer = async (
  handler: MediaStreamHandler,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> =>
  startUpgradeWsServer({
    urlPath: "/voice/stream",
    onUpgrade: (request, socket, head) => {
      handler.handleUpgrade(request, socket, head);
    },
  });

describe("MediaStreamHandler TTS queue", () => {
  it("serializes TTS playback and resolves in order", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });
    const started: number[] = [];
    const finished: number[] = [];

    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const first = handler.queueTts("stream-1", async () => {
      started.push(1);
      await firstGate;
      finished.push(1);
    });
    const second = handler.queueTts("stream-1", async () => {
      started.push(2);
      finished.push(2);
    });

    await flush();
    expect(started).toEqual([1]);

    resolveFirst();
    await first;
    await second;

    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([1, 2]);
  });

  it("cancels active playback and clears queued items", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });

    let queuedRan = false;
    const started: string[] = [];

    const active = handler.queueTts("stream-1", async (signal) => {
      started.push("active");
      await waitForAbort(signal);
    });
    const queued = handler.queueTts("stream-1", async () => {
      queuedRan = true;
    });

    await flush();
    expect(started).toEqual(["active"]);

    handler.clearTtsQueue("stream-1");
    await active;
    await withTimeout(queued);
    await flush();

    expect(queuedRan).toBe(false);
  });

  it("resolves pending queued playback during stream teardown", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });

    let queuedRan = false;
    const active = handler.queueTts("stream-1", async (signal) => {
      await waitForAbort(signal);
    });
    const queued = handler.queueTts("stream-1", async () => {
      queuedRan = true;
    });

    await flush();
    (
      handler as unknown as {
        clearTtsState(streamSid: string): void;
      }
    ).clearTtsState("stream-1");

    await withTimeout(active);
    await withTimeout(queued);
    expect(queuedRan).toBe(false);
  });
});

describe("MediaStreamHandler security hardening", () => {
  it("fails sends and closes stream when buffered bytes already exceed the cap", () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 2 * 1024 * 1024,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    (
      handler as unknown as {
        sessions: Map<
          string,
          {
            callId: string;
            streamSid: string;
            ws: WebSocket;
            sttSession: RealtimeTranscriptionSession;
          }
        >;
      }
    ).sessions.set("MZ-backpressure", {
      callId: "CA-backpressure",
      streamSid: "MZ-backpressure",
      ws,
      sttSession: createStubSession(),
    });

    const result = handler.sendAudio("MZ-backpressure", Buffer.alloc(160, 0xff));

    expect(result.sent).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1013, "Backpressure: send buffer exceeded");
  });

  it("fails sends when buffered bytes exceed cap after enqueueing a frame", () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(() => {
        (
          ws as unknown as {
            bufferedAmount: number;
          }
        ).bufferedAmount = 2 * 1024 * 1024;
      }),
      close: vi.fn(),
    } as unknown as WebSocket;
    (
      handler as unknown as {
        sessions: Map<
          string,
          {
            callId: string;
            streamSid: string;
            ws: WebSocket;
            sttSession: RealtimeTranscriptionSession;
          }
        >;
      }
    ).sessions.set("MZ-overflow", {
      callId: "CA-overflow",
      streamSid: "MZ-overflow",
      ws,
      sttSession: createStubSession(),
    });

    const result = handler.sendMark("MZ-overflow", "mark-1");

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(false);
    expect(ws.close).toHaveBeenCalledWith(1013, "Backpressure: send buffer exceeded");
  });

  it("sanitizes websocket close reason before logging", () => {
    const reason = sanitizeLogText("forged\nline\r\tentry", 120);
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("\r");
    expect(reason).not.toContain("\t");
    expect(reason).toContain("forged line entry");
  });

  it("closes idle pre-start connections after timeout", async () => {
    const shouldAcceptStreamCalls: Array<{ callId: string; streamSid: string; token?: string }> =
      [];
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 40,
      shouldAcceptStream: (params) => {
        shouldAcceptStreamCalls.push(params);
        return true;
      },
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      const closed = await waitForClose(ws);

      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe("Start timeout");
      expect(shouldAcceptStreamCalls).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("enforces pending connection limits", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 5_000,
      maxPendingConnections: 1,
      maxPendingConnectionsPerIp: 1,
    });
    const server = await startWsServer(handler);

    try {
      const first = await connectWs(server.url);
      const second = await connectWs(server.url);
      const secondClosed = await waitForClose(second);

      expect(secondClosed.code).toBe(1013);
      expect(secondClosed.reason).toContain("Too many pending");
      expect(first.readyState).toBe(WebSocket.OPEN);

      first.close();
      await waitForClose(first);
    } finally {
      await server.close();
    }
  });

  it("uses resolved client IPs for per-IP pending limits", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 5_000,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 1,
      resolveClientIp: (request) => String(request.headers["x-forwarded-for"] ?? ""),
    });
    const server = await startWsServer(handler);

    try {
      const first = new WebSocket(server.url, {
        headers: { "x-forwarded-for": "198.51.100.10" },
      });
      await withTimeout(new Promise((resolve) => first.once("open", resolve)));

      const second = new WebSocket(server.url, {
        headers: { "x-forwarded-for": "203.0.113.20" },
      });
      await withTimeout(new Promise((resolve) => second.once("open", resolve)));

      expect(first.readyState).toBe(WebSocket.OPEN);
      expect(second.readyState).toBe(WebSocket.OPEN);

      const firstClosed = waitForClose(first);
      const secondClosed = waitForClose(second);
      first.close();
      second.close();
      await firstClosed;
      await secondClosed;
    } finally {
      await server.close();
    }
  });

  it("rejects upgrades when max connection cap is reached", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 5_000,
      maxConnections: 1,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });
    const server = await startWsServer(handler);

    try {
      const first = await connectWs(server.url);
      const secondError = await withTimeout(
        new Promise<Error>((resolve) => {
          const ws = new WebSocket(server.url);
          ws.once("error", (err) => resolve(err));
        }),
      );

      expect(secondError.message).toContain("Unexpected server response: 503");

      first.close();
      await waitForClose(first);
    } finally {
      await server.close();
    }
  });

  it("counts in-flight upgrades against the max connection cap", () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      maxConnections: 2,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });

    const fakeWss = {
      clients: new Set([{}]),
      handleUpgrade: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
    };
    let upgradeCallback: ((ws: WebSocket) => void) | null = null;
    fakeWss.handleUpgrade.mockImplementation(
      (
        _request: IncomingMessage,
        _socket: unknown,
        _head: Buffer,
        callback: (ws: WebSocket) => void,
      ) => {
        upgradeCallback = callback;
      },
    );

    (
      handler as unknown as {
        wss: typeof fakeWss;
      }
    ).wss = fakeWss;

    const firstSocket = {
      once: vi.fn(),
      removeListener: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
    };
    handler.handleUpgrade(
      { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
      firstSocket as never,
      Buffer.alloc(0),
    );

    const secondSocket = {
      once: vi.fn(),
      removeListener: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
    };
    handler.handleUpgrade(
      { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
      secondSocket as never,
      Buffer.alloc(0),
    );

    expect(fakeWss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(secondSocket.write).toHaveBeenCalledOnce();
    expect(secondSocket.destroy).toHaveBeenCalledOnce();

    expect(upgradeCallback).not.toBeNull();
    const completeUpgrade = upgradeCallback as ((ws: WebSocket) => void) | null;
    if (!completeUpgrade) {
      throw new Error("Expected upgrade callback to be registered");
    }
    completeUpgrade({} as WebSocket);
    expect(fakeWss.emit).toHaveBeenCalledWith(
      "connection",
      expect.anything(),
      expect.objectContaining({ socket: { remoteAddress: "127.0.0.1" } }),
    );
  });

  it("releases in-flight reservations when ws rejects a malformed upgrade before the callback", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 5_000,
      maxConnections: 1,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });
    const server = await startWsServer(handler);
    const serverUrl = new URL(server.url);

    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(
            { host: serverUrl.hostname, port: Number(serverUrl.port) },
            () => {
              socket.write(
                [
                  "GET /voice/stream HTTP/1.1",
                  `Host: ${serverUrl.host}`,
                  "Upgrade: websocket",
                  "Connection: Upgrade",
                  "Sec-WebSocket-Version: 13",
                  "",
                  "",
                ].join("\r\n"),
              );
            },
          );
          socket.once("error", reject);
          socket.once("data", () => {
            socket.end();
          });
          socket.once("close", () => resolve());
        }),
      );

      const ws = await connectWs(server.url);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await waitForClose(ws);
    } finally {
      await server.close();
    }
  });

  it("clears pending state after valid start", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 40,
      shouldAcceptStream: () => true,
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ123",
          start: { callSid: "CA123", customParameters: { token: "token-123" } },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
      await waitForClose(ws);
    } finally {
      await server.close();
    }
  });

  it("rejects oversized pre-start frames at the websocket maxPayload guard before validation runs", async () => {
    const shouldAcceptStreamCalls: Array<{ callId: string; streamSid: string; token?: string }> =
      [];
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 1_000,
      shouldAcceptStream: (params) => {
        shouldAcceptStreamCalls.push(params);
        return true;
      },
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-oversized",
          start: {
            callSid: "CA-oversized",
            customParameters: { token: "token-oversized", padding: "A".repeat(256 * 1024) },
          },
        }),
      );

      const closed = await waitForClose(ws);

      expect(closed.code).toBe(1009);
      expect(shouldAcceptStreamCalls).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
