import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  __testing,
  buildMistralRealtimeTranscriptionProvider,
} from "./realtime-transcription-provider.js";

describe("buildMistralRealtimeTranscriptionProvider", () => {
  afterEach(() => {
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

    expect(resolved).toMatchObject({
      apiKey: "mistral-key",
      model: "voxtral-mini-transcribe-realtime-2602",
      encoding: "pcm_mulaw",
      sampleRate: 8000,
      targetStreamingDelayMs: 240,
    });
  });

  it("builds a Mistral realtime websocket URL", () => {
    const url = __testing.toMistralRealtimeWsUrl({
      apiKey: "mistral-key",
      baseUrl: "https://api.mistral.ai/v1",
      model: "voxtral-mini-transcribe-realtime-2602",
      providerConfig: {},
      sampleRate: 8000,
      encoding: "pcm_mulaw",
      targetStreamingDelayMs: 800,
    });

    expect(url).toContain("wss://api.mistral.ai/v1/audio/transcriptions/realtime?");
    expect(url).toContain("model=voxtral-mini-transcribe-realtime-2602");
    expect(url).toContain("target_streaming_delay_ms=800");
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("MISTRAL_API_KEY", "");
    const provider = buildMistralRealtimeTranscriptionProvider();
    expect(() => provider.createSession({ providerConfig: {} })).toThrow("Mistral API key missing");
  });
});
