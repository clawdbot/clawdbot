// Deepgram tests cover realtime transcription provider plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type { RawData } from "ws";
import { WebSocketServer } from "ws";
import { buildDeepgramRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const transcriptionHost = { createRealtimeTranscriptionWebSocketSession };

let cleanup: (() => Promise<void>) | undefined;

async function createDeepgramRealtimeServer(params: {
  onRequest: (url: URL, headers: Record<string, string | string[] | undefined>) => void;
  onConnection?: (ws: WebSocket) => void;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const clients = new Set<WebSocket>();

  server.on("upgrade", (request, socket, head) => {
    params.onRequest(new URL(request.url ?? "/", "http://127.0.0.1"), request.headers);
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      params.onConnection?.(ws);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
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
  return { baseUrl: `http://127.0.0.1:${port}/deepgram/v1` };
}

function sendResult(
  ws: WebSocket,
  params: {
    text: string;
    isFinal?: boolean;
    speechFinal?: boolean;
    fromFinalize?: boolean;
  },
) {
  ws.send(
    JSON.stringify({
      type: "Results",
      channel: { alternatives: [{ transcript: params.text }] },
      is_final: params.isFinal ?? false,
      speech_final: params.speechFinal ?? false,
      from_finalize: params.fromFinalize ?? false,
    }),
  );
}

function parseClientMessage(data: RawData): Record<string, unknown> {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

describe("buildDeepgramRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it("normalizes nested provider config", () => {
    const provider = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost);
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          deepgram: {
            apiKey: "dg-key",
            model: "nova-3",
            encoding: "g711_ulaw",
            sample_rate: "8000",
            interim_results: "true",
            endpointing: "500",
            language: "en-US",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "dg-key",
      baseUrl: undefined,
      model: "nova-3",
      language: "en-US",
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 500,
    });
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    const provider = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost);
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(
      "Deepgram API key missing",
    );
  });

  it.each(["not a url", "ftp://files.example.com"])("rejects invalid endpoint %s", (baseUrl) => {
    const provider = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost);
    expect(() => provider.createSession({ providerConfig: { apiKey: "dg-key", baseUrl } })).toThrow(
      /^Invalid Deepgram baseUrl:/,
    );
  });

  it("validates the environment override", () => {
    vi.stubEnv("DEEPGRAM_BASE_URL", "not a url");
    const provider = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost);
    expect(() => provider.createSession({ providerConfig: { apiKey: "dg-key" } })).toThrow(
      "Invalid Deepgram baseUrl: value is not a valid URL",
    );
  });

  it("does not echo the configured URL in validation errors", () => {
    const rawMarker = "configured-value-marker";
    const nonHttp = `ftp://files.example.com/${rawMarker}`;
    const provider = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost);
    try {
      provider.createSession({ providerConfig: { apiKey: "dg-key", baseUrl: nonHttp } });
      throw new Error("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/unsupported scheme/);
      expect(message).not.toContain(rawMarker);
    }
  });

  it("connects through an explicit HTTP base URL over loopback WebSocket", async () => {
    const requests: Array<{
      url: URL;
      headers: Record<string, string | string[] | undefined>;
    }> = [];
    const server = await createDeepgramRealtimeServer({
      onRequest: (url, headers) => requests.push({ url, headers }),
    });
    const provider = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost);
    const session = provider.createSession({
      providerConfig: {
        apiKey: "dummy",
        baseUrl: server.baseUrl,
      },
    });

    await session.connect();
    session.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/deepgram/v1/listen");
    expect(requests[0]?.url.searchParams.get("model")).toBe("nova-3");
    expect(requests[0]?.url.searchParams.get("endpointing")).toBe("800");
    expect(requests[0]?.url.searchParams.has("utterance_end_ms")).toBe(false);
    expect(requests[0]?.headers.authorization).toBe("Token dummy");
  });

  it("buffers finalized segments until the utterance is complete", async () => {
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        sendResult(ws, { text: "hello", isFinal: true });
        sendResult(ws, { text: "world", isFinal: true, speechFinal: true });
      },
    });
    const onPartial = vi.fn();
    const transcriptReceived = createDeferred<string>();
    const onTranscript = vi.fn(transcriptReceived.resolve);
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 1000 },
      onPartial,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => transcriptReceived.promise);
      expect(onTranscript).toHaveBeenCalledWith("hello world");
    } finally {
      session.close();
    }

    expect(onPartial).toHaveBeenCalledWith("hello");
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("replaces the provisional tail with the text-bearing speech-final result", async () => {
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        sendResult(ws, { text: "hello" });
        sendResult(ws, { text: "hello", isFinal: true, speechFinal: true });
      },
    });
    const transcriptReceived = createDeferred<string>();
    const onTranscript = vi.fn(transcriptReceived.resolve);
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 1000 },
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => transcriptReceived.promise);
      expect(onTranscript).toHaveBeenCalledWith("hello");
    } finally {
      session.close();
    }

    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("does not promote a rejected provisional tail on an empty speech-final result", async () => {
    const deliveryMarker = "rejected-tail frames delivered";
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        sendResult(ws, { text: "delete everything" });
        sendResult(ws, { text: "", isFinal: true, speechFinal: true });
        ws.send(JSON.stringify({ type: "SpeechStarted" }));
        // An error marker observes delivery without creating another speech turn.
        ws.send(JSON.stringify({ type: "Error", message: deliveryMarker }));
      },
    });
    const onPartial = vi.fn();
    const onSpeechStart = vi.fn();
    const framesDelivered = createDeferred<void>();
    const onError = vi.fn((error: Error) => {
      if (error.message === deliveryMarker) {
        framesDelivered.resolve();
      }
    });
    const onTranscript = vi.fn();
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 1000 },
      onPartial,
      onError,
      onSpeechStart,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => framesDelivered.promise);
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: deliveryMarker }),
      );
      expect(onSpeechStart).toHaveBeenCalledTimes(2);
    } finally {
      session.close();
    }

    expect(onPartial).toHaveBeenCalledWith("delete everything");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("preserves identical transcripts from consecutive utterances", async () => {
    const deliveryMarker = "consecutive-utterance frames delivered";
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        sendResult(ws, { text: "yes", isFinal: true, speechFinal: true });
        sendResult(ws, { text: "yes", isFinal: true, speechFinal: true });
        ws.send(JSON.stringify({ type: "Error", message: deliveryMarker }));
      },
    });
    const onTranscript = vi.fn();
    const framesDelivered = createDeferred<void>();
    const onError = vi.fn((error: Error) => {
      if (error.message === deliveryMarker) {
        framesDelivered.resolve();
      }
    });
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 1000 },
      onTranscript,
      onError,
    });

    try {
      await session.connect();
      await vi.waitFor(() => framesDelivered.promise);
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: deliveryMarker }),
      );
      expect(onTranscript).toHaveBeenCalledTimes(2);
    } finally {
      session.close();
    }

    expect(onTranscript.mock.calls).toEqual([["yes"], ["yes"]]);
  });

  it("flushes finalized text returned after a client finalize request", async () => {
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        sendResult(ws, { text: "good", isFinal: true });
        sendResult(ws, { text: "bye" });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            sendResult(ws, {
              text: "bye",
              isFinal: true,
              fromFinalize: true,
            });
          }
        });
      },
    });
    const transcriptReceived = createDeferred<string>();
    const onTranscript = vi.fn(transcriptReceived.resolve);
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 10_000 },
      onTranscript,
    });

    try {
      await session.connect();
      session.close();
      await vi.waitFor(() => transcriptReceived.promise);
      expect(onTranscript).toHaveBeenCalledWith("good bye");
      expect(onTranscript).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
    }
  });

  it("flushes finalized text once when finalize produces no result", async () => {
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        sendResult(ws, { text: "good", isFinal: true });
        sendResult(ws, { text: "bye" });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
          }
        });
      },
    });
    const partialReceived = createDeferred<void>();
    const onPartial = vi.fn((text: string) => {
      if (text === "good bye") {
        partialReceived.resolve();
      }
    });
    const onTranscript = vi.fn();
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 10_000 },
      onPartial,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => partialReceived.promise);
      expect(onPartial).toHaveBeenCalledWith("good bye");
      vi.useFakeTimers();
      session.close();
      session.close();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(finalizeRequests).toBe(1);
      expect(onTranscript).toHaveBeenCalledTimes(1);
      expect(onTranscript).toHaveBeenCalledWith("good");
    } finally {
      if (vi.isFakeTimers()) {
        session.close();
      } else {
        // A failed observation can leave finalized text; close must own its fallback clock.
        vi.useFakeTimers();
        session.close();
        await vi.advanceTimersByTimeAsync(5_000).catch(() => undefined);
      }
    }
  });

  it("does not commit a turn on an utterance-end gap before speech-final", async () => {
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        sendResult(ws, { text: "still", isFinal: true });
        ws.send(JSON.stringify({ type: "UtteranceEnd" }));
        sendResult(ws, { text: "speaking", isFinal: true, speechFinal: true });
      },
    });
    const transcriptReceived = createDeferred<string>();
    const onTranscript = vi.fn(transcriptReceived.resolve);
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 25 },
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => transcriptReceived.promise);
      expect(onTranscript).toHaveBeenCalledWith("still speaking");
    } finally {
      session.close();
    }

    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("does not infer silence from a gap between provisional results", async () => {
    vi.useFakeTimers();
    let socket: WebSocket | undefined;
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        socket = ws;
        sendResult(ws, { text: "still speaking" });
      },
    });
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 25 },
      onPartial,
      onTranscript,
    });

    await session.connect();
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("still speaking"));
    await vi.advanceTimersByTimeAsync(350);
    expect(onTranscript).not.toHaveBeenCalled();

    sendResult(socket!, { text: "continuous speech", isFinal: true, speechFinal: true });
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("continuous speech"));
    session.close();
  });

  it("does not merge an interrupted turn into a reconnected provider stream", async () => {
    vi.useFakeTimers();
    let connectionCount = 0;
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        connectionCount += 1;
        if (connectionCount === 1) {
          sendResult(ws, { text: "old" });
          ws.close();
          return;
        }
        sendResult(ws, { text: "new", isFinal: true, speechFinal: true });
      },
    });
    const onTranscript = vi.fn();
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 10_000 },
      onTranscript,
    });

    await session.connect();
    // Observe the real socket close before advancing the provider's retry delay.
    await vi.waitFor(() => expect(session.isConnected()).toBe(false));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("new"), {
      timeout: 3000,
    });
    session.close();

    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("preserves finalized speech as a separate turn when the provider reconnects", async () => {
    vi.useFakeTimers();
    let connectionCount = 0;
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        connectionCount += 1;
        if (connectionCount === 1) {
          sendResult(ws, { text: "old", isFinal: true });
          ws.close();
          return;
        }
        sendResult(ws, { text: "new", isFinal: true, speechFinal: true });
      },
    });
    const onTranscript = vi.fn();
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 10_000 },
      onTranscript,
    });

    await session.connect();
    await vi.waitFor(() => expect(session.isConnected()).toBe(false));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    session.close();

    expect(onTranscript.mock.calls).toEqual([["old"], ["new"]]);
  });

  it("terminates instead of retaining an oversized utterance", async () => {
    const server = await createDeepgramRealtimeServer({
      onRequest: () => undefined,
      onConnection: (ws) => {
        sendResult(ws, { text: "x".repeat(256 * 1024), isFinal: true });
        sendResult(ws, { text: "y" });
      },
    });
    const errorReceived = createDeferred<Error>();
    const onError = vi.fn(errorReceived.resolve);
    const session = buildDeepgramRealtimeTranscriptionProvider(transcriptionHost).createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 1000 },
      onError,
    });

    try {
      await session.connect();
      await vi.waitFor(() => errorReceived.promise);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("retained transcript exceeded"),
        }),
      );
      expect(session.isConnected()).toBe(false);
    } finally {
      session.close();
    }
  });
});
