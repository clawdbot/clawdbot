import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { buildXaiRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function createRealtimeSttServer(params?: {
  onRequest?: (url: URL) => void;
  onBinary?: (audio: Buffer) => void;
  initialEvent?: unknown;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const done = vi.fn();
  let resolveDone: (() => void) | undefined;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    params?.onRequest?.(url);
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.send(JSON.stringify(params?.initialEvent ?? { type: "transcript.created" }));
      ws.on("message", (data, isBinary) => {
        const buffer = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        if (isBinary) {
          params?.onBinary?.(buffer);
          ws.send(
            JSON.stringify({
              type: "transcript.partial",
              text: "hello openclaw",
              is_final: false,
              speech_final: false,
            }),
          );
          ws.send(
            JSON.stringify({
              type: "transcript.partial",
              text: "hello openclaw final",
              is_final: true,
              speech_final: true,
            }),
          );
          return;
        }
        const event = JSON.parse(buffer.toString()) as { type?: string };
        if (event.type === "audio.done") {
          ws.send(JSON.stringify({ type: "transcript.done", text: "hello openclaw final" }));
          done();
          resolveDone?.();
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanup = async () => {
    for (const ws of clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, done, donePromise };
}

function requireFirstErrorArg(mock: ReturnType<typeof vi.fn>, label: string): Error {
  const [call] = mock.mock.calls;
  if (!call || !(call[0] instanceof Error)) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

describe("xai realtime transcription provider", () => {
  it("normalizes provider config for voice-call streaming", () => {
    const provider = buildXaiRealtimeTranscriptionProvider();

    expect(
      provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: {
          providers: {
            xai: {
              apiKey: "xai-test-key",
              baseUrl: "https://api.x.ai/v1",
              sampleRate: 24000,
              encoding: "pcm",
              interimResults: false,
              endpointingMs: 500,
              language: "en",
            },
          },
        },
      }),
    ).toEqual({
      apiKey: "xai-test-key",
      baseUrl: "https://api.x.ai/v1",
      sampleRate: 24000,
      encoding: "pcm",
      interimResults: false,
      endpointingMs: 500,
      language: "en",
    });
  });

  it("streams raw binary audio and maps partial and final transcript events", async () => {
    const binaryFrames: Buffer[] = [];
    const requestUrls: URL[] = [];
    const server = await createRealtimeSttServer({
      onRequest: (url) => requestUrls.push(url),
      onBinary: (audio) => binaryFrames.push(audio),
    });
    const provider = buildXaiRealtimeTranscriptionProvider();
    const onPartial = vi.fn();
    let resolveFinalTranscript: (() => void) | undefined;
    const finalTranscript = new Promise<void>((resolve) => {
      resolveFinalTranscript = resolve;
    });
    const onTranscript = vi.fn((text: string) => {
      if (text === "hello openclaw final") {
        resolveFinalTranscript?.();
      }
    });
    const onSpeechStart = vi.fn();

    const session = provider.createSession({
      providerConfig: {
        apiKey: "xai-test-key",
        baseUrl: server.baseUrl,
        sampleRate: 24000,
        encoding: "pcm",
        endpointingMs: 500,
      },
      onPartial,
      onTranscript,
      onSpeechStart,
    });

    session.sendAudio(Buffer.from("queued-before-ready"));
    await session.connect();
    session.sendAudio(Buffer.from("after-ready"));
    await finalTranscript;
    session.close();
    await server.donePromise;

    expect(requestUrls[0]?.pathname).toBe("/v1/stt");
    expect(requestUrls[0]?.searchParams.get("sample_rate")).toBe("24000");
    expect(requestUrls[0]?.searchParams.get("encoding")).toBe("pcm");
    expect(requestUrls[0]?.searchParams.get("interim_results")).toBe("true");
    expect(requestUrls[0]?.searchParams.get("endpointing")).toBe("500");
    expect(Buffer.concat(binaryFrames).toString()).toContain("queued-before-ready");
    expect(Buffer.concat(binaryFrames).toString()).toContain("after-ready");
    expect(onSpeechStart).toHaveBeenCalled();
    expect(onPartial).toHaveBeenCalledWith("hello openclaw");
  });

  it("rejects setup errors before the stream is ready", async () => {
    const server = await createRealtimeSttServer({
      initialEvent: {
        type: "error",
        error: {
          message: "Streaming ASR unavailable",
        },
      },
    });
    const provider = buildXaiRealtimeTranscriptionProvider();
    const onError = vi.fn();

    const session = provider.createSession({
      providerConfig: {
        apiKey: "xai-test-key",
        baseUrl: server.baseUrl,
      },
      onError,
    });

    await expect(session.connect()).rejects.toThrow("Streaming ASR unavailable");
    expect(session.isConnected()).toBe(false);
    const error = requireFirstErrorArg(onError, "xAI realtime setup error callback");
    expect(error.message).toBe("Streaming ASR unavailable");
  });

  it("accepts xAI realtime aliases", () => {
    const provider = buildXaiRealtimeTranscriptionProvider();
    expect(provider.aliases).toContain("xai-realtime");
    expect(provider.aliases).toContain("grok-stt-streaming");
  });
});
