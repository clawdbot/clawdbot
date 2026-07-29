// Elevenlabs tests cover realtime transcription provider plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

async function createRealtimeServer(onRequest: (url: URL) => void) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const clients = new Set<WebSocket>();
  server.on("upgrade", (request, socket, head) => {
    onRequest(new URL(request.url ?? "/", "http://127.0.0.1"));
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => {
        clients.delete(ws);
      });
      ws.send(JSON.stringify({ message_type: "session_started" }));
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
