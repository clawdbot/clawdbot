// Elevenlabs tests cover realtime transcription provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  testing,
  buildElevenLabsRealtimeTranscriptionProvider,
} from "./realtime-transcription-provider.js";

describe("buildElevenLabsRealtimeTranscriptionProvider", () => {
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

  it("builds an ElevenLabs realtime websocket URL", () => {
    const url = testing.toElevenLabsRealtimeWsUrl({
      apiKey: "eleven-key",
      baseUrl: "https://api.elevenlabs.io",
      providerConfig: {},
      modelId: "scribe_v2_realtime",
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "vad",
      languageCode: "en",
    });

    expect(url).toContain("wss://api.elevenlabs.io/v1/speech-to-text/realtime?");
    expect(url).toContain("model_id=scribe_v2_realtime");
    expect(url).toContain("audio_format=ulaw_8000");
    expect(url).toContain("commit_strategy=vad");
    expect(url).toContain("language_code=en");
  });
});
