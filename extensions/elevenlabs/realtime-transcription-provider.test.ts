import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import {
  __testing,
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

    expect(resolved).toMatchObject({
      apiKey: "eleven-key",
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "vad",
      languageCode: "en",
    });
  });

  it("builds an ElevenLabs realtime websocket URL", () => {
    const url = __testing.toElevenLabsRealtimeWsUrl({
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
