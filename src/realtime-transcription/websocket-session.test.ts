import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { createRealtimeTranscriptionWebSocketSession } from "./websocket-session.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function createRealtimeServer(params?: {
  closeOnConnection?: boolean;
  initialEvent?: unknown;
  onUpgrade?: (headers: Record<string, string | string[] | undefined>) => void;
  onBinary?: (payload: Buffer) => void;
  onText?: (payload: unknown) => void;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup = async () => {
    for (const ws of clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
  return arg;
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

    await expect(session.connect()).rejects.toThrow(
      "test realtime transcription connection timeout",
    );
    expect(session.isConnected()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    const timeoutError = requireFirstMockArg(onError, "connect timeout error");
    expect(timeoutError).toBeInstanceOf(Error);
    expect(timeoutError.message).toBe("test realtime transcription connection timeout");
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
});
