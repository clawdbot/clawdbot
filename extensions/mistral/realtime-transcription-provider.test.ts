// Mistral tests cover realtime transcription provider plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { buildMistralRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

let cleanup: (() => Promise<void>) | undefined;

async function createRealtimeServer(
  onRequest: (url: URL) => void,
  transcriptionEvents: readonly Record<string, unknown>[] = [],
  eventsByConnection?: readonly (readonly Record<string, unknown>[])[],
) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const clients = new Set<WebSocket>();
  let connectionCount = 0;
  server.on("upgrade", (request, socket, head) => {
    onRequest(new URL(request.url ?? "/", "http://127.0.0.1"));
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connectionIndex = connectionCount++;
      clients.add(ws);
      ws.on("close", () => {
        clients.delete(ws);
      });
      ws.on("message", (data) => {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        const message = JSON.parse(bytes.toString("utf8")) as { type?: unknown };
        if (message.type === "session.update") {
          for (const event of eventsByConnection?.[connectionIndex] ?? transcriptionEvents) {
            ws.send(JSON.stringify(event));
          }
          if (eventsByConnection && connectionIndex === 0) {
            setTimeout(() => ws.terminate(), 10);
          }
        }
      });
      ws.send(JSON.stringify({ type: "session.created" }));
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
      wss.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe("buildMistralRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it("normalizes nested provider config", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          mistral: {
            apiKey: "mistral-key",
            model: "voxtral-mini-transcribe-realtime-2602",
            encoding: "g711_ulaw",
            sample_rate: "8000",
            target_streaming_delay_ms: "240",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "mistral-key",
      baseUrl: undefined,
      model: "voxtral-mini-transcribe-realtime-2602",
      encoding: "pcm_mulaw",
      sampleRate: 8000,
      targetStreamingDelayMs: 240,
    });
  });

  it("normalizes pasted API key artifacts for realtime auth headers", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          mistral: {
            apiKey: "  sk-\r\nmistral│  ",
          },
        },
      },
    });

    expect(resolved?.apiKey).toBe("sk-mistral");
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("MISTRAL_API_KEY", "");
    const provider = buildMistralRealtimeTranscriptionProvider();
    expect(() => provider.createSession({ providerConfig: {} })).toThrow("Mistral API key missing");
  });

  it("connects through the public session boundary with the configured URL params", async () => {
    const requests: URL[] = [];
    const baseUrl = await createRealtimeServer((url) => requests.push(url));
    const session = buildMistralRealtimeTranscriptionProvider().createSession({
      providerConfig: {
        apiKey: "fixture-value",
        baseUrl,
        model: "voxtral-mini-transcribe-realtime-2602",
        sampleRate: 8000,
        encoding: "pcm_mulaw",
        targetStreamingDelayMs: 800,
      },
    });

    await session.connect();
    session.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/audio/transcriptions/realtime");
    expect(requests[0]?.searchParams.get("model")).toBe("voxtral-mini-transcribe-realtime-2602");
    expect(requests[0]?.searchParams.get("target_streaming_delay_ms")).toBe("800");
  });

  it.each([
    {
      name: "delivers terminal-only transcription text",
      events: [{ type: "transcription.done", text: "final transcript" }],
      partials: [],
      transcripts: ["final transcript"],
    },
    {
      name: "prefers corrected final text over streamed deltas",
      events: [
        { type: "transcription.text.delta", text: "draft" },
        { type: "transcription.text.delta", text: " words" },
        { type: "transcription.done", text: "corrected final transcript" },
      ],
      partials: ["draft", "draft words"],
      transcripts: ["corrected final transcript"],
    },
    {
      name: "does not repeat an already emitted final segment",
      events: [
        { type: "transcription.text.delta", text: "draft" },
        { type: "transcription.segment", text: "final transcript", start: 0, end: 1 },
        { type: "transcription.done", text: "final transcript" },
      ],
      partials: ["draft"],
      transcripts: ["final transcript"],
    },
    {
      name: "delivers identical text from independently timed segments",
      events: [
        { type: "transcription.segment", text: "echo", start: 0, end: 1, speaker_id: "first" },
        { type: "transcription.segment", text: "echo", start: 1, end: 2, speaker_id: "second" },
        { type: "transcription.done", text: "echo echo" },
      ],
      partials: [],
      transcripts: ["echo", "echo"],
    },
    {
      name: "does not replay a terminal aggregate after multiple final segments",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.segment", text: "world", start: 1, end: 2 },
        { type: "transcription.done", text: "hello world" },
      ],
      partials: [],
      transcripts: ["hello", "world"],
    },
    {
      name: "flushes new deltas after a finalized segment without replaying its aggregate",
      events: [
        { type: "transcription.text.delta", text: "hello" },
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.text.delta", text: " new" },
        { type: "transcription.text.delta", text: " speech" },
        { type: "transcription.done", text: "hello new speech" },
      ],
      partials: ["hello", " new", " new speech"],
      transcripts: ["hello", " new speech"],
    },
    {
      name: "flushes new deltas after multiple finalized segments without replaying them",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.segment", text: "world", start: 1, end: 2 },
        { type: "transcription.text.delta", text: " again" },
        { type: "transcription.done", text: "hello world again" },
      ],
      partials: [" again"],
      transcripts: ["hello", "world", " again"],
    },
    {
      name: "does not finalize whitespace-only deltas after a final segment",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.text.delta", text: "  \t" },
        { type: "transcription.done", text: "hello  " },
      ],
      partials: ["  \t"],
      transcripts: ["hello"],
    },
    {
      name: "does not finalize a punctuation-only period delta after a final segment",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.text.delta", text: "." },
        { type: "transcription.done", text: "hello." },
      ],
      partials: ["."],
      transcripts: ["hello"],
    },
    {
      name: "does not finalize a punctuation-only comma delta after a final segment",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.text.delta", text: ", " },
        { type: "transcription.done", text: "hello," },
      ],
      partials: [", "],
      transcripts: ["hello"],
    },
    {
      name: "preserves multilingual speech with leading punctuation after a final segment",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.text.delta", text: ", 你好" },
        { type: "transcription.done", text: "hello, 你好" },
      ],
      partials: [", 你好"],
      transcripts: ["hello", ", 你好"],
    },
    {
      name: "preserves numeric speech after a final segment",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.text.delta", text: " 42" },
        { type: "transcription.done", text: "hello 42" },
      ],
      partials: [" 42"],
      transcripts: ["hello", " 42"],
    },
    {
      name: "does not replay terminal suffixes after final segments already own the stream",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.segment", text: "world", start: 1, end: 2 },
        { type: "transcription.done", text: "hello world again" },
      ],
      partials: [],
      transcripts: ["hello", "world"],
    },
    {
      name: "does not replay terminal corrections after final segments already own the stream",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.segment", text: "world", start: 1, end: 2 },
        { type: "transcription.done", text: "hello corrected world" },
      ],
      partials: [],
      transcripts: ["hello", "world"],
    },
    {
      name: "does not turn terminal sentence punctuation into a transcript",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.segment", text: "world", start: 1, end: 2 },
        { type: "transcription.done", text: "hello world." },
      ],
      partials: [],
      transcripts: ["hello", "world"],
    },
    {
      name: "does not turn terminal separator punctuation into a transcript",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.segment", text: "world", start: 1, end: 2 },
        { type: "transcription.done", text: "hello, world" },
      ],
      partials: [],
      transcripts: ["hello", "world"],
    },
    {
      name: "does not replay terminal whitespace normalization as a transcript",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.segment", text: "world", start: 1, end: 2 },
        { type: "transcription.done", text: "  hello\t\n  world  " },
      ],
      partials: [],
      transcripts: ["hello", "world"],
    },
    {
      name: "does not replay a rewritten terminal aggregate after final segments",
      events: [
        { type: "transcription.segment", text: "hello", start: 0, end: 1 },
        { type: "transcription.segment", text: "world", start: 1, end: 2 },
        { type: "transcription.done", text: "greetings earth" },
      ],
      partials: [],
      transcripts: ["hello", "world"],
    },
  ])("$name", async ({ events, partials, transcripts }) => {
    const baseUrl = await createRealtimeServer(() => {}, events);
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = buildMistralRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onPartial,
      onTranscript,
    });

    await session.connect();
    await vi.waitFor(() => {
      expect(onTranscript.mock.calls.map(([text]) => text)).toEqual(transcripts);
      expect(session.isConnected()).toBe(false);
    });

    expect(onPartial.mock.calls.map(([text]) => text)).toEqual(partials);
  });

  it.each([
    {
      name: "preserves the replacement session's terminal-only speech",
      firstEvents: [{ type: "transcription.segment", text: "earlier turn" }],
      secondEvents: [{ type: "transcription.done", text: "replacement final" }],
      partials: [],
    },
    {
      name: "does not mix the interrupted session's partial text into replacement speech",
      firstEvents: [
        { type: "transcription.segment", text: "earlier turn" },
        { type: "transcription.text.delta", text: "old fragment " },
      ],
      secondEvents: [
        { type: "transcription.text.delta", text: "new fragment" },
        { type: "transcription.done", text: "replacement final" },
      ],
      partials: ["old fragment ", "new fragment"],
    },
  ])("$name after a real provider reconnect", async ({ firstEvents, secondEvents, partials }) => {
    const requests: URL[] = [];
    const baseUrl = await createRealtimeServer(
      (url) => requests.push(url),
      [],
      [firstEvents, secondEvents],
    );
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const session = buildMistralRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onPartial,
      onTranscript,
      onError,
    });

    await session.connect();
    // Wait on the delivered transcripts, not just the socket close: the replacement
    // connection can close before its `transcription.done` reaches onTranscript.
    await vi.waitFor(
      () => {
        expect(requests).toHaveLength(2);
        expect(session.isConnected()).toBe(false);
        expect(onTranscript.mock.calls.map(([text]) => text)).toEqual([
          "earlier turn",
          "replacement final",
        ]);
      },
      { timeout: 3_000 },
    );

    expect(onPartial.mock.calls.map(([text]) => text)).toEqual(partials);
    expect(onError).not.toHaveBeenCalled();
  });

  it("tracks the in-progress transcript limit as aggregate UTF-8 bytes", async () => {
    const exactUtf8Limit = "🙂".repeat((256 * 1024) / 4);
    const splitSurrogatePrefix = "x".repeat(256 * 1024 - 4);
    const splitSurrogateTranscript = `${splitSurrogatePrefix}🙂`;
    const baseUrl = await createRealtimeServer(() => {}, [
      { type: "transcription.text.delta", text: exactUtf8Limit },
      { type: "transcription.segment", text: "first segment", start: 0, end: 1 },
      { type: "transcription.text.delta", text: `${splitSurrogatePrefix}\ud83d` },
      { type: "transcription.text.delta", text: "\ude42" },
      { type: "transcription.done" },
    ]);
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const session = buildMistralRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onError,
      onTranscript,
    });

    await session.connect();
    await vi.waitFor(() => {
      expect(onTranscript.mock.calls.map(([text]) => text)).toEqual([
        "first segment",
        splitSurrogateTranscript,
      ]);
      expect(session.isConnected()).toBe(false);
    });

    expect(onError).not.toHaveBeenCalled();
  });

  it("fails once and ignores late terminal events after 10,000 runaway deltas", async () => {
    const baseUrl = await createRealtimeServer(() => {}, [
      ...Array.from({ length: 10_000 }, () => ({
        type: "transcription.text.delta",
        text: "x".repeat(32),
      })),
      { type: "transcription.segment", text: "late segment", start: 0, end: 1 },
      { type: "transcription.done", text: "late done" },
    ]);
    let resolveError: (() => void) | undefined;
    const errorReceived = new Promise<void>((resolve) => {
      resolveError = resolve;
    });
    const onError = vi.fn(() => resolveError?.());
    const onTranscript = vi.fn();
    let lastPartialLength = 0;
    let partialCalls = 0;
    const session = buildMistralRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onError,
      onPartial: (partial) => {
        lastPartialLength = partial.length;
        partialCalls += 1;
      },
      onTranscript,
    });

    await session.connect();
    await errorReceived;
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message:
            "Mistral realtime transcription exceeded the 256 KiB in-progress transcript limit",
        }),
      );
      expect(session.isConnected()).toBe(false);
    });

    expect(partialCalls).toBe(8_192);
    expect(lastPartialLength).toBe(256 * 1024);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("makes a ready-state provider error terminal and ignores late events", async () => {
    const baseUrl = await createRealtimeServer(() => {}, [
      { type: "transcription.text.delta", text: "draft" },
      { type: "error", error: { message: "provider failed" } },
      { type: "transcription.text.delta", text: "x".repeat(256 * 1024 + 1) },
      { type: "transcription.segment", text: "late segment", start: 0, end: 1 },
      { type: "transcription.done", text: "late done" },
    ]);
    const onError = vi.fn(() => {
      throw new Error("observer failed");
    });
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = buildMistralRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onError,
      onPartial,
      onTranscript,
    });

    await session.connect();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "provider failed" }),
      );
      expect(session.isConnected()).toBe(false);
    });

    expect(onPartial).toHaveBeenCalledExactlyOnceWith("draft");
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
