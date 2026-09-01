// Elevenlabs tests cover realtime transcription provider plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";

const { resolveElevenLabsApiKeyWithProfileFallbackMock } = vi.hoisted(() => ({
  resolveElevenLabsApiKeyWithProfileFallbackMock: vi.fn(),
}));

vi.mock("./config-api.js", () => ({
  resolveElevenLabsApiKeyWithProfileFallback: resolveElevenLabsApiKeyWithProfileFallbackMock,
}));

import { buildElevenLabsRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

let cleanup: (() => Promise<void>) | undefined;

async function createRealtimeServer(
  onRequest: (url: URL) => void,
  options?: {
    initialEvent?: Record<string, unknown>;
    events?: readonly Record<string, unknown>[];
    eventsByConnection?: readonly (readonly Record<string, unknown>[])[];
    closeAfterEvents?: boolean;
  },
) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const clients = new Set<WebSocket>();
  let connectionCount = 0;
  server.on("upgrade", (request, socket, head) => {
    onRequest(new URL(request.url ?? "/", "http://127.0.0.1"));
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => {
        clients.delete(ws);
      });
      ws.send(JSON.stringify(options?.initialEvent ?? { message_type: "session_started" }));
      const events = options?.eventsByConnection?.[connectionCount] ?? options?.events ?? [];
      connectionCount += 1;
      for (const event of events) {
        ws.send(JSON.stringify(event));
      }
      if (options?.closeAfterEvents) {
        ws.close();
      }
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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("buildElevenLabsRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
    resolveElevenLabsApiKeyWithProfileFallbackMock.mockReset();
  });

  it("normalizes nested provider config", () => {
    const provider = buildElevenLabsRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          elevenlabs: {
            apiKey: "eleven-key",
            model_id: "scribe_v2_realtime",
            audio_format: "ulaw_8000",
            sample_rate: "8000",
            commit_strategy: "vad",
            language: "en",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "eleven-key",
      baseUrl: undefined,
      modelId: undefined,
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "vad",
      languageCode: "en",
      vadSilenceThresholdSecs: undefined,
      vadThreshold: undefined,
      minSpeechDurationMs: undefined,
      minSilenceDurationMs: undefined,
    });
  });

  it("drops malformed numeric realtime config values", () => {
    const provider = buildElevenLabsRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          elevenlabs: {
            sample_rate: "8000.5",
            vad_silence_threshold_secs: "999",
            vad_threshold: "0",
            min_speech_duration_ms: "0",
            min_silence_duration_ms: "10.5",
          },
        },
      },
    });

    expect(resolved).toMatchObject({
      sampleRate: undefined,
      vadSilenceThresholdSecs: undefined,
      vadThreshold: undefined,
      minSpeechDurationMs: undefined,
      minSilenceDurationMs: undefined,
    });
  });

  it("keeps realtime VAD numeric config inside provider ranges", () => {
    const provider = buildElevenLabsRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          elevenlabs: {
            sample_rate: "8000",
            vad_silence_threshold_secs: "3",
            vad_threshold: "0.9",
            min_speech_duration_ms: "50",
            min_silence_duration_ms: "2000",
          },
        },
      },
    });

    expect(resolved).toMatchObject({
      sampleRate: 8000,
      vadSilenceThresholdSecs: 3,
      vadThreshold: 0.9,
      minSpeechDurationMs: 50,
      minSilenceDurationMs: 2000,
    });
  });

  it("connects through the public session boundary with the configured URL params", async () => {
    const requests: URL[] = [];
    const baseUrl = await createRealtimeServer((url) => requests.push(url));
    const session = buildElevenLabsRealtimeTranscriptionProvider().createSession({
      providerConfig: {
        apiKey: "fixture-value",
        baseUrl,
        modelId: "scribe_v2_realtime",
        audioFormat: "ulaw_8000",
        sampleRate: 8000,
        commitStrategy: "vad",
        languageCode: "en",
      },
    });

    await session.connect();
    session.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/speech-to-text/realtime");
    expect(requests[0]?.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(requests[0]?.searchParams.get("audio_format")).toBe("ulaw_8000");
    expect(requests[0]?.searchParams.get("commit_strategy")).toBe("vad");
    expect(requests[0]?.searchParams.get("language_code")).toBe("en");
  });

  it.each([
    ["rate_limited", "rate limit exceeded"],
    ["quota_exceeded", "quota exhausted"],
    ["queue_overflow", "provider queue is full"],
    ["commit_throttled", "commit was throttled"],
  ])("reports the ready-state %s provider error exactly once", async (messageType, message) => {
    const baseUrl = await createRealtimeServer(() => undefined, {
      events: [{ message_type: messageType, error: message }],
    });
    const errorReceived = createDeferred<Error>();
    const onError = vi.fn(errorReceived.resolve);
    const session = buildElevenLabsRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onError,
    });

    try {
      await session.connect();
      await vi.waitFor(() => errorReceived.promise);
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }));
    } finally {
      session.close();
    }
  });

  it("rejects pre-ready provider errors with their original actionable detail", async () => {
    const message = "rate limit exceeded; retry after account reset";
    const baseUrl = await createRealtimeServer(() => undefined, {
      initialEvent: { message_type: "rate_limited", error: message },
      closeAfterEvents: true,
    });
    const onError = vi.fn();
    const session = buildElevenLabsRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onError,
    });

    await expect(session.connect()).rejects.toThrow(message);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }));
  });

  it("preserves legacy named provider errors without a structured error field", async () => {
    const message = "legacy provider rejected the input";
    const baseUrl = await createRealtimeServer(() => undefined, {
      events: [{ message_type: "input_error", message }],
    });
    const errorReceived = createDeferred<Error>();
    const onError = vi.fn(errorReceived.resolve);
    const session = buildElevenLabsRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onError,
    });

    try {
      await session.connect();
      await vi.waitFor(() => errorReceived.promise);
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }));
    } finally {
      session.close();
    }
  });

  it("keeps ordinary partial and committed transcripts outside error dispatch", async () => {
    const baseUrl = await createRealtimeServer(() => undefined, {
      events: [
        { message_type: "partial_transcript", text: "hello" },
        { message_type: "committed_transcript", text: "hello there" },
      ],
    });
    const onError = vi.fn();
    const onPartial = vi.fn();
    const transcriptReceived = createDeferred<string>();
    const onTranscript = vi.fn(transcriptReceived.resolve);
    const session = buildElevenLabsRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onError,
      onPartial,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => transcriptReceived.promise);
      expect(onPartial).toHaveBeenCalledExactlyOnceWith("hello");
      expect(onTranscript).toHaveBeenCalledExactlyOnceWith("hello there");
      expect(onError).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it.each([
    {
      name: "delivers identical committed words from separate speech turns",
      events: [
        { message_type: "partial_transcript", text: "yes" },
        { message_type: "committed_transcript", text: "yes" },
        { message_type: "partial_transcript", text: "yes" },
        { message_type: "committed_transcript", text: "yes" },
      ],
      transcripts: ["yes", "yes"],
    },
    {
      name: "treats adjacent identical committed transcripts as separate segments",
      events: [
        { message_type: "committed_transcript", text: "yes" },
        { message_type: "committed_transcript", text: "yes" },
      ],
      transcripts: ["yes", "yes"],
    },
    {
      name: "suppresses a matching timestamp companion for the same committed segment",
      events: [
        { message_type: "committed_transcript", text: "yes" },
        { message_type: "committed_transcript_with_timestamps", text: "yes" },
      ],
      transcripts: ["yes"],
    },
    {
      name: "consumes the timestamp companion at most once",
      events: [
        { message_type: "committed_transcript", text: "yes" },
        { message_type: "committed_transcript_with_timestamps", text: "yes" },
        { message_type: "committed_transcript_with_timestamps", text: "yes" },
      ],
      transcripts: ["yes", "yes"],
    },
    {
      name: "preserves identical consecutive timestamp-only segments",
      events: [
        { message_type: "committed_transcript_with_timestamps", text: "yes" },
        { message_type: "committed_transcript_with_timestamps", text: "yes" },
      ],
      transcripts: ["yes", "yes"],
    },
    {
      name: "emits a timestamp-only segment without an earlier plain commit",
      events: [{ message_type: "committed_transcript_with_timestamps", text: "yes" }],
      transcripts: ["yes"],
    },
    {
      name: "does not suppress a timestamp transcript that differs from its commit",
      events: [
        { message_type: "committed_transcript", text: "yes" },
        { message_type: "committed_transcript_with_timestamps", text: "no" },
      ],
      transcripts: ["yes", "no"],
    },
    {
      name: "preserves a delayed timestamp companion across an interleaved partial",
      events: [
        { message_type: "committed_transcript", text: "yes" },
        { message_type: "partial_transcript", text: "next turn" },
        { message_type: "committed_transcript_with_timestamps", text: "yes" },
        { message_type: "committed_transcript", text: "yes" },
        { message_type: "committed_transcript_with_timestamps", text: "yes" },
      ],
      transcripts: ["yes", "yes"],
    },
    {
      name: "keeps timestamp companions attached to alternating committed segments",
      events: [
        { message_type: "committed_transcript", text: "yes" },
        { message_type: "committed_transcript_with_timestamps", text: "yes" },
        { message_type: "committed_transcript", text: "no" },
        { message_type: "committed_transcript_with_timestamps", text: "no" },
        { message_type: "committed_transcript", text: "yes" },
        { message_type: "committed_transcript_with_timestamps", text: "yes" },
      ],
      transcripts: ["yes", "no", "yes"],
    },
  ])("$name", async ({ events, transcripts }) => {
    const deliveryMarker = "transcript frames delivered";
    const baseUrl = await createRealtimeServer(() => undefined, {
      events: [...events, { message_type: "partial_transcript", text: deliveryMarker }],
    });
    const onError = vi.fn();
    const framesDelivered = createDeferred<void>();
    const onPartial = vi.fn((text: string) => {
      if (text === deliveryMarker) {
        framesDelivered.resolve();
      }
    });
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const session = buildElevenLabsRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onError,
      onPartial,
      onSpeechStart,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => framesDelivered.promise);
      expect(onPartial).toHaveBeenCalledWith(deliveryMarker);
      expect(onTranscript.mock.calls.map(([text]) => text)).toEqual(transcripts);
      expect(onError).not.toHaveBeenCalled();
      expect(onSpeechStart).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it("does not suppress a timestamp-only transcript from a replacement session", async () => {
    const firstMarker = "first session delivered";
    const secondMarker = "replacement session delivered";
    const baseUrl = await createRealtimeServer(() => undefined, {
      eventsByConnection: [
        [
          { message_type: "committed_transcript", text: "yes" },
          { message_type: "partial_transcript", text: firstMarker },
        ],
        [
          { message_type: "committed_transcript_with_timestamps", text: "yes" },
          { message_type: "partial_transcript", text: secondMarker },
        ],
      ],
    });
    const firstSessionDelivered = createDeferred<void>();
    const replacementSessionDelivered = createDeferred<void>();
    const onPartial = vi.fn((text: string) => {
      if (text === firstMarker) {
        firstSessionDelivered.resolve();
      } else if (text === secondMarker) {
        replacementSessionDelivered.resolve();
      }
    });
    const onTranscript = vi.fn();
    const session = buildElevenLabsRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "fixture-value", baseUrl },
      onPartial,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => firstSessionDelivered.promise);
      expect(onPartial).toHaveBeenCalledWith(firstMarker);
      expect(onTranscript).toHaveBeenCalledExactlyOnceWith("yes");

      await session.connect();
      await vi.waitFor(() => replacementSessionDelivered.promise);
      expect(onPartial).toHaveBeenCalledWith(secondMarker);
      expect(onTranscript.mock.calls).toEqual([["yes"], ["yes"]]);
    } finally {
      session.close();
    }
  });

  it("rejects whitespace-only environment keys before session creation", () => {
    resolveElevenLabsApiKeyWithProfileFallbackMock.mockReturnValue(null);
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    vi.stubEnv("XI_API_KEY", "   ");
    const provider = buildElevenLabsRealtimeTranscriptionProvider();

    expect(provider.isConfigured({ cfg: {} as OpenClawConfig, providerConfig: {} })).toBe(false);
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(
      "ElevenLabs API key missing",
    );
  });
});
