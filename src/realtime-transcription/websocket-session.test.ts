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
  onBinary?: (payload: Buffer) => void;
  onText?: (payload: unknown) => void;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on("upgrade", (request, socket, head) => {
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

describe("createRealtimeTranscriptionWebSocketSession", () => {
  it("flushes queued binary audio after an open-ready connection", async () => {
    const frames: Buffer[] = [];
    let resolveFrames!: () => void;
    const framesReady = new Promise<void>((resolve) => {
      resolveFrames = resolve;
    });
    const server = await createRealtimeServer({
      onBinary: (payload) => {
        frames.push(payload);
        if (Buffer.concat(frames).toString() === "queuedafter") {
          resolveFrames();
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
    await framesReady;
    expect(Buffer.concat(frames).toString()).toBe("queuedafter");
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("lets providers mark ready after a JSON handshake", async () => {
    const frames: unknown[] = [];
    let resolveFrames!: () => void;
    const framesReady = new Promise<void>((resolve) => {
      resolveFrames = resolve;
    });
    const server = await createRealtimeServer({
      initialEvent: { type: "session.created" },
      onText: (payload) => {
        frames.push(payload);
        if (frames.length === 2) {
          resolveFrames();
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
    await framesReady;
    expect(frames).toEqual([
      { type: "session.update" },
      { type: "input_audio.append", audio: Buffer.from("queued").toString("base64") },
    ]);
    session.close();
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
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
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
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: "test realtime transcription connection closed before ready",
    });
  });
});
