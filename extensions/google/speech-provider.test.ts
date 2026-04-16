import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGoogleSpeechProvider, __testing } from "./speech-provider.js";

function installGoogleTtsFetchMock(pcm = Buffer.from([1, 0, 2, 0])) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/L16;codec=pcm;rate=24000",
                  data: pcm.toString("base64"),
                },
              },
            ],
          },
        },
      ],
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Google speech provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("synthesizes Gemini PCM as WAV and preserves audio tags in the request text", async () => {
    const fetchMock = installGoogleTtsFetchMock();
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesize({
      text: "[whispers] The door is open.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
        model: "google/gemini-3.1-flash-tts",
        voiceName: "Puck",
      },
      target: "audio-file",
      timeoutMs: 12_345,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: "[whispers] The door is open." }],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Puck",
                },
              },
            },
          },
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("google-test-key");
    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.voiceCompatible).toBe(false);
    expect(result.audioBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.audioBuffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(result.audioBuffer.readUInt32LE(24)).toBe(__testing.GOOGLE_TTS_SAMPLE_RATE);
    expect(result.audioBuffer.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
  });

  it("falls back to GEMINI_API_KEY and configured Google API base URL", async () => {
    vi.stubEnv("GEMINI_API_KEY", "env-google-key");
    const fetchMock = installGoogleTtsFetchMock();
    const provider = buildGoogleSpeechProvider();

    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 1 })).toBe(true);

    await provider.synthesize({
      text: "Read this plainly.",
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
              models: [],
            },
          },
        },
      },
      providerConfig: {},
      target: "voice-note",
      timeoutMs: 10_000,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent",
      expect.any(Object),
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("env-google-key");
  });

  it("can reuse a configured Google model-provider API key without auth profiles", async () => {
    const fetchMock = installGoogleTtsFetchMock();
    const provider = buildGoogleSpeechProvider();
    const cfg = {
      models: {
        providers: {
          google: {
            apiKey: "model-provider-google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [],
          },
        },
      },
    };

    expect(provider.isConfigured({ cfg, providerConfig: {}, timeoutMs: 1 })).toBe(true);

    await provider.synthesize({
      text: "Use the configured model provider key.",
      cfg,
      providerConfig: {},
      target: "audio-file",
      timeoutMs: 10_000,
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("model-provider-google-key");
  });

  it("returns Gemini PCM directly for telephony synthesis", async () => {
    const pcm = Buffer.from([3, 0, 4, 0]);
    installGoogleTtsFetchMock(pcm);
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesizeTelephony?.({
      text: "Phone call audio.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
        voice: "Kore",
      },
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      audioBuffer: pcm,
      outputFormat: "pcm",
      sampleRate: 24_000,
    });
  });

  it("resolves provider config and directive overrides", () => {
    const provider = buildGoogleSpeechProvider();

    expect(
      provider.resolveConfig?.({
        cfg: {},
        rawConfig: {
          providers: {
            google: {
              apiKey: "configured-key",
              model: "google/gemini-3.1-flash-tts-preview",
              voice: "Leda",
            },
          },
        },
        timeoutMs: 1,
      }),
    ).toEqual({
      apiKey: "configured-key",
      baseUrl: undefined,
      model: "gemini-3.1-flash-tts-preview",
      voiceName: "Leda",
    });

    expect(
      provider.parseDirectiveToken?.({
        key: "google_voice",
        value: "Aoede",
        policy: {
          enabled: true,
          allowText: true,
          allowProvider: true,
          allowVoice: true,
          allowModelId: true,
          allowVoiceSettings: true,
          allowNormalization: true,
          allowSeed: true,
        },
      }),
    ).toEqual({
      handled: true,
      overrides: {
        voiceName: "Aoede",
      },
    });

    expect(
      provider.parseDirectiveToken?.({
        key: "google_model",
        value: "gemini-3.1-flash-tts-preview",
        policy: {
          enabled: true,
          allowText: true,
          allowProvider: true,
          allowVoice: true,
          allowModelId: true,
          allowVoiceSettings: true,
          allowNormalization: true,
          allowSeed: true,
        },
      }),
    ).toEqual({
      handled: true,
      overrides: {
        model: "gemini-3.1-flash-tts-preview",
      },
    });
  });

  it("lists Gemini prebuilt TTS voices", async () => {
    const provider = buildGoogleSpeechProvider();

    await expect(provider.listVoices?.({ providerConfig: {} })).resolves.toEqual(
      expect.arrayContaining([
        { id: "Kore", name: "Kore" },
        { id: "Puck", name: "Puck" },
      ]),
    );
  });
});
