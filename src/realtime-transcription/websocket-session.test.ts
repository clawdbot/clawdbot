// Realtime transcription websocket tests cover websocket session lifecycle.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { createRealtimeTranscriptionWebSocketSession } from "./websocket-session.js";

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanup?.();
  cleanup = undefined;
});

async function createRealtimeServer(params?: {
  closeOnConnection?: boolean;
  initialEvent?: unknown;
  initialText?: string;
  onConnection?: (ws: WebSocket) => void;
  onUpgrade?: (headers: Record<string, string | string[] | undefined>) => void;
  onBinary?: (payload: Buffer) => void;
  onText?: (payload: unknown) => void;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const clients = new Set<WebSocket>();

  server.on("upgrade", (request, socket, head) => {
    params?.onUpgrade?.(request.headers);
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      if (params?.closeOnConnection) {
        ws.close(1011, "setup failed");
        return;
      }
      if (params?.initialEvent) {
        ws.send(JSON.stringify(params.initialEvent));
      }
      if (params?.initialText) {
        ws.send(params.initialText);
      }
      params?.onConnection?.(ws);
      ws.on("message", (data, isBinary) => {
        const buffer = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        if (isBinary) {
          params?.onBinary?.(buffer);
          return;
        }
        params?.onText?.(JSON.parse(buffer.toString()));
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup = async () => {
    for (const ws of clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  const port = (server.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}` };
}

function createSignal() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  if (!resolve) {
    throw new Error("Expected frame signal resolver to be initialized");
  }
  return { promise, resolve };
}

function requireFirstMockArg<T>(mock: { mock: { calls: T[][] } }, label: string): T {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  return expectDefined(arg, "arg test invariant");
}

describe("createRealtimeTranscriptionWebSocketSession", () => {
  it("flushes queued binary audio after an open-ready connection", async () => {
    const frames: Buffer[] = [];
    const framesReady = createSignal();
    const server = await createRealtimeServer({
      onBinary: (payload) => {
        frames.push(payload);
        if (Buffer.concat(frames).toString() === "queuedafter") {
          framesReady.resolve();
        }
      },
    });
    const session = createRealtimeTranscriptionWebSocketSession({
      providerId: "test",
      callbacks: {},
      url: server.url,
      readyOnOpen: true,
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    session.sendAudio(Buffer.from("queued"));
    await session.connect();
    session.sendAudio(Buffer.from("after"));
    await framesReady.promise;
    expect(Buffer.concat(frames).toString()).toBe("queuedafter");
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("lets providers mark ready after a JSON handshake", async () => {
    const frames: unknown[] = [];
    const framesReady = createSignal();
    const server = await createRealtimeServer({
      initialEvent: { type: "session.created" },
      onText: (payload) => {
        frames.push(payload);
        if (frames.length === 2) {
          framesReady.resolve();
        }
      },
    });
    const session = createRealtimeTranscriptionWebSocketSession<{ type?: string }>({
      providerId: "test",
      callbacks: {},
      url: server.url,
      onMessage: (event, transport) => {
        if (event.type === "session.created") {
          transport.sendJson({ type: "session.update" });
          transport.markReady();
        }
      },
      sendAudio: (audio, transport) => {
        transport.sendJson({ type: "input_audio.append", audio: audio.toString("base64") });
      },
    });

    session.sendAudio(Buffer.from("queued"));
    await session.connect();
    await framesReady.promise;
    expect(frames).toEqual([
      { type: "session.update" },
      { type: "input_audio.append", audio: Buffer.from("queued").toString("base64") },
    ]);
    session.close();
  });

  it("resolves async URLs and headers before opening the socket", async () => {
    const seenAuthHeaders: Array<string | string[] | undefined> = [];
    const server = await createRealtimeServer({
      onUpgrade: (headers) => {
        seenAuthHeaders.push(headers.authorization);
      },
    });
    const session = createRealtimeTranscriptionWebSocketSession({
      providerId: "test",
      callbacks: {},
      url: async () => server.url,
      headers: async () => ({ Authorization: "Bearer resolved-token" }),
      readyOnOpen: true,
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    await session.connect();

    expect(seenAuthHeaders).toEqual(["Bearer resolved-token"]);
    session.close();
  });

  it("applies the connect timeout while resolving async connection details", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const session = createRealtimeTranscriptionWebSocketSession({
      providerId: "test",
      callbacks: { onError },
      url: () => new Promise<string>(() => {}),
      connectTimeoutMs: 10,
      connectTimeoutMessage: "test realtime transcription connection timeout",
      readyOnOpen: true,
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    try {
      const connecting = session.connect();
      const timeoutAssertion = expect(connecting).rejects.toThrow(
        "test realtime transcription connection timeout",
      );
      await vi.advanceTimersByTimeAsync(10);

      await timeoutAssertion;
      expect(session.isConnected()).toBe(false);
      expect(onError).toHaveBeenCalledTimes(1);
      const timeoutError = requireFirstMockArg(onError, "connect timeout error");
      expect(timeoutError).toBeInstanceOf(Error);
      expect(timeoutError.message).toBe("test realtime transcription connection timeout");
    } finally {
      session.close();
      vi.useRealTimers();
    }
  });

  it("preserves connect failures when the error callback throws", async () => {
    vi.useFakeTimers();
    const previousDebugProxyEnabled = process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    const onError = vi.fn((_error: Error) => {
      throw new Error("error observer failed");
    });
    const session = createRealtimeTranscriptionWebSocketSession({
      providerId: "test",
      callbacks: { onError },
      url: () => new Promise<string>(() => {}),
      connectTimeoutMs: 10,
      connectTimeoutMessage: "test realtime transcription connection timeout",
      readyOnOpen: true,
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    try {
      const connecting = session.connect();
      const timeoutAssertion = expect(connecting).rejects.toThrow(
        "test realtime transcription connection timeout",
      );
      await vi.advanceTimersByTimeAsync(10);

      await timeoutAssertion;
      expect(session.isConnected()).toBe(false);
      expect(onError).toHaveBeenCalledTimes(1);
      const timeoutError = requireFirstMockArg(onError, "connect timeout error");
      expect(timeoutError).toBeInstanceOf(Error);
      expect(timeoutError.message).toBe("test realtime transcription connection timeout");
    } finally {
      session.close();
      if (previousDebugProxyEnabled === undefined) {
        delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
      } else {
        process.env.OPENCLAW_DEBUG_PROXY_ENABLED = previousDebugProxyEnabled;
      }
      vi.useRealTimers();
    }
  });

  it("does not open a socket when closed while async connection resolves", async () => {
    const seenAuthHeaders: Array<string | string[] | undefined> = [];
    let resolveUrl!: (url: string) => void;
    const url = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const server = await createRealtimeServer({
      onUpgrade: (headers) => {
        seenAuthHeaders.push(headers.authorization);
      },
    });
    const session = createRealtimeTranscriptionWebSocketSession({
      providerId: "test",
      callbacks: {},
      url: () => url,
      headers: async () => ({ Authorization: "Bearer resolved-token" }),
      readyOnOpen: true,
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    const connecting = session.connect();
    session.close();
    resolveUrl(server.url);
    await connecting;

    expect(seenAuthHeaders).toEqual([]);
    expect(session.isConnected()).toBe(false);
  });

  it("rejects provider setup errors before ready", async () => {
    const server = await createRealtimeServer({ initialEvent: { type: "error", message: "nope" } });
    const onError = vi.fn();
    const session = createRealtimeTranscriptionWebSocketSession<{
      type?: string;
      message?: string;
    }>({
      providerId: "test",
      callbacks: { onError },
      url: server.url,
      onMessage: (event, transport) => {
        if (!transport.isReady() && event.type === "error") {
          transport.failConnect(new Error(event.message));
        }
      },
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    await expect(session.connect()).rejects.toThrow("nope");
    expect(session.isConnected()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    const setupError = requireFirstMockArg(onError, "provider setup error");
    expect(setupError).toBeInstanceOf(Error);
    expect(setupError.message).toBe("nope");
  });

  it("reports malformed websocket JSON with an owned parser error", async () => {
    const server = await createRealtimeServer({ initialText: "{not json" });
    const onError = vi.fn();
    const session = createRealtimeTranscriptionWebSocketSession({
      providerId: "test",
      callbacks: { onError },
      url: server.url,
      readyOnOpen: true,
      onMessage: () => {
        throw new Error("malformed payload should not reach provider handler");
      },
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    await session.connect();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    const parseError = requireFirstMockArg(onError, "malformed websocket json error");
    expect(parseError).toBeInstanceOf(Error);
    expect(parseError.message).toBe("Realtime transcription websocket received malformed JSON.");
    session.close();
  });

  it("keeps error callback failures inside websocket message dispatch", async () => {
    const server = await createRealtimeServer({ initialText: "{not json" });
    const onError = vi.fn((_error: Error) => {
      throw new Error("error observer failed");
    });
    const session = createRealtimeTranscriptionWebSocketSession({
      providerId: "test",
      callbacks: { onError },
      url: server.url,
      readyOnOpen: true,
      onMessage: () => {
        throw new Error("malformed payload should not reach provider handler");
      },
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    await session.connect();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    const parseError = requireFirstMockArg(onError, "malformed websocket json error");
    expect(parseError).toBeInstanceOf(Error);
    expect(parseError.message).toBe("Realtime transcription websocket received malformed JSON.");
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("reports pre-ready closes separately from connection timeouts", async () => {
    const server = await createRealtimeServer({ closeOnConnection: true });
    const onError = vi.fn();
    const session = createRealtimeTranscriptionWebSocketSession({
      providerId: "test",
      callbacks: { onError },
      url: server.url,
      connectTimeoutMessage: "test realtime transcription connection timeout",
      connectClosedBeforeReadyMessage: "test realtime transcription connection closed before ready",
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    await expect(session.connect()).rejects.toThrow(
      "test realtime transcription connection closed before ready",
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const closeError = requireFirstMockArg(onError, "pre-ready close error");
    expect(closeError).toBeInstanceOf(Error);
    expect(closeError.message).toBe("test realtime transcription connection closed before ready");
  });

  it("stops reconnecting after repeated ready-then-close flaps", async () => {
    const onError = vi.fn();
    let openCount = 0;
    const server = await createRealtimeServer({
      initialEvent: { type: "session.created" },
      onConnection: (ws) => {
        openCount += 1;
        setTimeout(() => ws.close(1011, "flap"), 1);
      },
    });
    const session = createRealtimeTranscriptionWebSocketSession<{ type?: string }>({
      providerId: "test",
      callbacks: { onError },
      url: server.url,
      maxReconnectAttempts: 3,
      reconnectDelayMs: 5,
      onMessage: (event, transport) => {
        if (event.type === "session.created") {
          transport.markReady();
        }
      },
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    await session.connect();
    await vi.waitFor(
      () => {
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "test realtime transcription reconnect limit reached",
          }),
        );
      },
      { timeout: 1000 },
    );
    expect(openCount).toBe(4);
    session.close();
  });

  it("refreshes the reconnect budget after a stable ready connection", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const connections: WebSocket[] = [];
    const onError = vi.fn();
    const server = await createRealtimeServer({
      initialEvent: { type: "session.created" },
      onConnection: (ws) => connections.push(ws),
    });
    const session = createRealtimeTranscriptionWebSocketSession<{ type?: string }>({
      providerId: "test",
      callbacks: { onError },
      url: server.url,
      maxReconnectAttempts: 1,
      reconnectDelayMs: 5,
      onMessage: (event, transport) => {
        if (event.type === "session.created") {
          transport.markReady();
        }
      },
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    await session.connect();
    connections[0]?.close(1011, "first flap");
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    await vi.waitFor(() => expect(session.isConnected()).toBe(true));

    now = 30_000;
    connections[1]?.close(1011, "stable disconnect");
    await vi.waitFor(() => expect(connections).toHaveLength(3));
    await vi.waitFor(() => expect(session.isConnected()).toBe(true));

    connections[2]?.close(1011, "second flap");
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "test realtime transcription reconnect limit reached",
        }),
      );
    });
    expect(connections).toHaveLength(3);
    session.close();
  });

  it("delivers a legitimate large inbound message below the payload cap", async () => {
    // Well above any real transcript message yet far under the 16 MiB cap: proves
    // the bound does not reject legitimate large provider traffic.
    const largeText = "x".repeat(2 * 1024 * 1024);
    const server = await createRealtimeServer({
      initialEvent: { type: "transcript", text: largeText },
    });
    const onMessage = vi.fn();
    const session = createRealtimeTranscriptionWebSocketSession<{ type?: string; text?: string }>({
      providerId: "test",
      callbacks: {},
      url: server.url,
      readyOnOpen: true,
      onMessage,
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    await session.connect();
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledTimes(1);
    });
    const event = requireFirstMockArg(onMessage, "large inbound message");
    expect(event).toEqual({ type: "transcript", text: largeText });
    session.close();
  });

  it("drops an oversized inbound message before it reaches the provider parser", async () => {
    // ws rejects a message above maxPayload with an error + 1009 close, so an
    // oversized upstream message never reaches onMessage/JSON parse.
    const oversized = "x".repeat(16 * 1024 * 1024 + 1);
    const server = await createRealtimeServer({ initialText: oversized });
    const onError = vi.fn();
    const onMessage = vi.fn(() => {
      throw new Error("oversized frame should not reach provider handler");
    });
    const session = createRealtimeTranscriptionWebSocketSession({
      providerId: "test",
      callbacks: { onError },
      url: server.url,
      readyOnOpen: true,
      onMessage,
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    await session.connect();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(onMessage).not.toHaveBeenCalled();
    const overflowError = requireFirstMockArg(onError, "oversized inbound message error");
    expect(overflowError).toBeInstanceOf(Error);
    expect(overflowError).toHaveProperty("code", "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
    expect(overflowError.message).toMatch(/max payload/i);
    session.close();
  });
});
