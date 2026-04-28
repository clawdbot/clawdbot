import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  buildDeepgramRealtimeTranscriptionProvider,
} from "./realtime-transcription-provider.js";

describe("buildDeepgramRealtimeTranscriptionProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes nested provider config", () => {
    const provider = buildDeepgramRealtimeTranscriptionProvider();
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

    expect(resolved).toMatchObject({
      apiKey: "dg-key",
      model: "nova-3",
      encoding: "mulaw",
      sampleRate: 8000,
      interimResults: true,
      endpointingMs: 500,
      language: "en-US",
    });
  });

  it("builds a Deepgram listen websocket URL", () => {
    const url = __testing.toDeepgramRealtimeWsUrl({
      apiKey: "dg-key",
      baseUrl: "https://api.deepgram.com/v1",
      model: "nova-3",
      providerConfig: {},
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 800,
    });

    expect(url).toContain("wss://api.deepgram.com/v1/listen?");
    expect(url).toContain("model=nova-3");
    expect(url).toContain("encoding=mulaw");
    expect(url).toContain("sample_rate=8000");
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    const provider = buildDeepgramRealtimeTranscriptionProvider();
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(
      "Deepgram API key missing",
    );
  });
});
