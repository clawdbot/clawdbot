import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const transcodeAudioBufferToOpusMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: transcodeAudioBufferToOpusMock,
}));

const {
  assertOkOrThrowProviderErrorMock,
  postJsonRequestMock,
  resolveProviderHttpRequestConfigMock,
} = getProviderHttpMocks();

let buildGoogleSpeechProvider: typeof import("./speech-provider.js").buildGoogleSpeechProvider;
let __testing: typeof import("./speech-provider.js").__testing;

beforeAll(async () => {
  ({ buildGoogleSpeechProvider, __testing } = await import("./speech-provider.js"));
});

installProviderHttpMockCleanup();

function googleTtsResponse(pcm = Buffer.from([1, 0, 2, 0])) {
  return {
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
  };
}

function installGoogleTtsRequestMock(pcm = Buffer.from([1, 0, 2, 0])) {
  postJsonRequestMock.mockResolvedValue({
    response: googleTtsResponse(pcm),
    release: vi.fn(async () => {}),
  });
  return postJsonRequestMock;
}

describe("Google speech provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    transcodeAudioBufferToOpusMock.mockReset();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/media-runtime");
    vi.resetModules();
  });

  it("synthesizes Gemini PCM as WAV and preserves audio tags in the request text", async () => {
    const requestMock = installGoogleTtsRequestMock();
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

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent",
        body: {
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
        },
        fetchFn: fetch,
        pinDns: false,
        timeoutMs: 12_345,
      }),
    );
    const request = requestMock.mock.calls[0]?.[0] as { headers?: HeadersInit };
    expect(new Headers(request.headers).get("x-goog-api-key")).toBe("google-test-key");
    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.voiceCompatible).toBe(false);
    expect(result.audioBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.audioBuffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(result.audioBuffer.readUInt32LE(24)).toBe(__testing.GOOGLE_TTS_SAMPLE_RATE);
    expect(result.audioBuffer.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(transcodeAudioBufferToOpusMock).not.toHaveBeenCalled();
  });

  it("transcodes Gemini PCM to Opus for voice-note targets", async () => {
    installGoogleTtsRequestMock(Buffer.from([5, 0, 6, 0]));
    transcodeAudioBufferToOpusMock.mockResolvedValueOnce(Buffer.from("google-opus"));
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesize({
      text: "Send this as a voice note.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
      },
      target: "voice-note",
      timeoutMs: 12_000,
    });

    expect(result).toEqual({
      audioBuffer: Buffer.from("google-opus"),
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });
    expect(transcodeAudioBufferToOpusMock).toHaveBeenCalledWith({
      audioBuffer: expect.any(Buffer),
      inputExtension: "wav",
      tempPrefix: "tts-google-",
      timeoutMs: 12_000,
    });
    const [{ audioBuffer }] = transcodeAudioBufferToOpusMock.mock.calls[0];
    expect(audioBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(audioBuffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
  });

  it("advertises all documented Gemini TTS-capable models", () => {
    const provider = buildGoogleSpeechProvider();

    expect(provider.models).toEqual(__testing.GOOGLE_TTS_MODELS);
  });

  it("renders deterministic audio-profile-v1 prompts without generating tags", async () => {
    const provider = buildGoogleSpeechProvider();

    const prepared = await provider.prepareSynthesis?.({
      text: "[whispers] The door is open.",
      cfg: {},
      providerConfig: {
        promptTemplate: "audio-profile-v1",
        personaPrompt: "Keep a close-mic feel.",
      },
      persona: {
        id: "alfred",
        label: "Alfred",
        prompt: {
          profile: "A brilliant British butler.",
          scene: "A quiet late-night study.",
          sampleContext: "The speaker is answering a trusted operator.",
          style: "Refined and lightly amused.",
          accent: "British English.",
          pacing: "Measured.",
          constraints: ["Do not read configuration values aloud."],
        },
      },
      target: "audio-file",
      timeoutMs: 1_000,
    });

    expect(prepared?.text).toBe(
      [
        "Synthesize speech from the TRANSCRIPT section only. Use the other sections only",
        "as performance direction. Do not read section titles, notes, labels, or",
        "configuration aloud.",
        "",
        "# AUDIO PROFILE: Alfred",
        "A brilliant British butler.",
        "",
        "## THE SCENE",
        "A quiet late-night study.",
        "",
        "### DIRECTOR'S NOTES",
        "Style: Refined and lightly amused.",
        "Accent: British English.",
        "Pacing: Measured.",
        "Constraints:",
        "- Do not read configuration values aloud.",
        "Provider notes:",
        "Keep a close-mic feel.",
        "",
        "### SAMPLE CONTEXT",
        "The speaker is answering a trusted operator.",
        "",
        "### TRANSCRIPT",
        "[whispers] The door is open.",
      ].join("\n"),
    );
  });

  it("does not wrap an OpenClaw audio-profile-v1 prompt twice", async () => {
    const provider = buildGoogleSpeechProvider();
    const text = [
      "Synthesize speech from the TRANSCRIPT section only. Use the other sections only",
      "as performance direction. Do not read section titles, notes, labels, or",
      "configuration aloud.",
      "",
      "# AUDIO PROFILE: Alfred",
      "A brilliant British butler.",
      "",
      "### TRANSCRIPT",
      "Hello.",
    ].join("\n");

    const prepared = await provider.prepareSynthesis?.({
      text,
      cfg: {},
      providerConfig: {
        promptTemplate: "audio-profile-v1",
      },
      persona: {
        id: "alfred",
        label: "Alfred",
        prompt: {
          profile: "A brilliant British butler.",
        },
      },
      target: "audio-file",
      timeoutMs: 1_000,
    });

    expect(prepared).toBeUndefined();
  });

  it("retries once when Gemini returns no audio payload", async () => {
    const pcm = Buffer.from([5, 0, 6, 0]);
    const requestSequence = vi
      .fn()
      .mockResolvedValueOnce({
        response: {
          ok: true,
          json: async () => ({ candidates: [{ content: { parts: [{ text: "not audio" }] } }] }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: googleTtsResponse(pcm),
        release: vi.fn(async () => {}),
      });
    postJsonRequestMock.mockImplementation(requestSequence);
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesize({
      text: "Retry this.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
      },
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(requestSequence).toHaveBeenCalledTimes(2);
    expect(result.audioBuffer.subarray(44)).toEqual(pcm);
  });

  it("retries once when Gemini TTS fetch aborts", async () => {
    const pcm = Buffer.from([7, 0, 8, 0]);
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    const requestSequence = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        response: googleTtsResponse(pcm),
        release: vi.fn(async () => {}),
      });
    postJsonRequestMock.mockImplementation(requestSequence);
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesize({
      text: "Retry aborted fetch.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
      },
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(requestSequence).toHaveBeenCalledTimes(2);
    expect(result.audioBuffer.subarray(44)).toEqual(pcm);
  });

  it("does not retry non-transient Gemini TTS request failures", async () => {
    const requestSequence = vi.fn().mockRejectedValueOnce(new Error("invalid request"));
    postJsonRequestMock.mockImplementation(requestSequence);
    const provider = buildGoogleSpeechProvider();

    await expect(
      provider.synthesize({
        text: "Do not retry this.",
        cfg: {},
        providerConfig: {
          apiKey: "google-test-key",
        },
        target: "audio-file",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("invalid request");

    expect(requestSequence).toHaveBeenCalledTimes(1);
  });

  it("falls back to GEMINI_API_KEY and configured Google API base URL", async () => {
    vi.stubEnv("GEMINI_API_KEY", "env-google-key");
    const requestMock = installGoogleTtsRequestMock();
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

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent",
      }),
    );
    const request = requestMock.mock.calls[0]?.[0] as { headers?: HeadersInit };
    expect(new Headers(request.headers).get("x-goog-api-key")).toBe("env-google-key");
  });

  it("can reuse a configured Google model-provider API key without auth profiles", async () => {
    const requestMock = installGoogleTtsRequestMock();
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

    const request = requestMock.mock.calls[0]?.[0] as { headers?: HeadersInit };
    expect(new Headers(request.headers).get("x-goog-api-key")).toBe("model-provider-google-key");
  });

  it("returns Gemini PCM directly for telephony synthesis", async () => {
    const pcm = Buffer.from([3, 0, 4, 0]);
    installGoogleTtsRequestMock(pcm);
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesizeTelephony?.({
      text: "Phone call audio.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
        model: "google/gemini-3.1-flash-tts",
        voice: "Kore",
        audioProfile: "Speak calmly.",
        speakerName: "Default speaker",
      },
      providerOverrides: {
        model: "google/gemini-3.1-pro-tts",
        voiceName: "Puck",
        audioProfile: "Speak brightly.",
        speakerName: "Override speaker",
      },
      timeoutMs: 5_000,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-tts:generateContent",
        body: expect.objectContaining({
          contents: [
            {
              role: "user",
              parts: [
                { text: "Speak brightly.\n\nSpeaker name: Override speaker\n\nPhone call audio." },
              ],
            },
          ],
          generationConfig: expect.objectContaining({
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Puck",
                },
              },
            },
          }),
        }),
      }),
    );
    expect(result).toEqual({
      audioBuffer: pcm,
      outputFormat: "pcm",
      sampleRate: 24_000,
    });
  });

  it("prepends configured Gemini TTS profile text", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await provider.synthesize({
      text: "Status update starts now.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
        audioProfile: "Speak professionally with a calm executive tone.",
        speakerName: "Alex",
      },
      target: "audio-file",
      timeoutMs: 10_000,
    });

    expect(requestMock.mock.calls[0]?.[0].body).toMatchObject({
      contents: [
        {
          parts: [
            {
              text:
                "Speak professionally with a calm executive tone.\n\n" +
                "Speaker name: Alex\n\n" +
                "Status update starts now.",
            },
          ],
        },
      ],
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
              audioProfile: "Speak warmly.",
              speakerName: "Narrator",
            },
          },
        },
        timeoutMs: 1,
      }),
    ).toEqual({
      apiKey: "configured-key",
      audioProfile: "Speak warmly.",
      baseUrl: undefined,
      model: "gemini-3.1-flash-tts-preview",
      speakerName: "Narrator",
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

  it("formats Google TTS HTTP errors with provider details", async () => {
    assertOkOrThrowProviderErrorMock.mockRejectedValue(
      new Error(
        "Google TTS failed (429): Quota exceeded [code=RESOURCE_EXHAUSTED] [request_id=google_req_123]",
      ),
    );
    postJsonRequestMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          error: {
            message: "Quota exceeded",
            status: "RESOURCE_EXHAUSTED",
          },
        }),
        {
          status: 429,
          headers: { "x-request-id": "google_req_123" },
        },
      ),
      release: vi.fn(async () => {}),
    });
    const provider = buildGoogleSpeechProvider();

    await expect(
      provider.synthesize({
        text: "Read this plainly.",
        cfg: {},
        providerConfig: { apiKey: "google-test-key" },
        target: "audio-file",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(
      "Google TTS failed (429): Quota exceeded [code=RESOURCE_EXHAUSTED] [request_id=google_req_123]",
    );
  });

  it("honors configured private-network opt-in for Google TTS", async () => {
    installGoogleTtsRequestMock();

    const provider = buildGoogleSpeechProvider();
    await provider.synthesize({
      text: "hello",
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
      providerConfig: { apiKey: "google-test-key" },
      target: "audio-file",
      timeoutMs: 12_345,
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
        request: expect.objectContaining({ allowPrivateNetwork: true }),
      }),
    );
  });

  it("honors configured private-network opt-in for Google telephony TTS", async () => {
    installGoogleTtsRequestMock();

    const provider = buildGoogleSpeechProvider();
    await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
      providerConfig: { apiKey: "google-test-key" },
      timeoutMs: 12_345,
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
        request: expect.objectContaining({ allowPrivateNetwork: true }),
      }),
    );
  });
});
