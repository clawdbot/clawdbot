// Inworld tests cover speech provider plugin behavior.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { inworldTTSMock, listInworldVoicesMock } = vi.hoisted(() => ({
  inworldTTSMock: vi.fn(),
  listInworldVoicesMock: vi.fn(),
}));

vi.mock("./tts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tts.js")>();
  return {
    ...actual,
    inworldTTS: inworldTTSMock,
    listInworldVoices: listInworldVoicesMock,
  };
});

import { buildInworldSpeechProvider } from "./speech-provider.js";

afterAll(() => {
  vi.doUnmock("./tts.js");
  vi.resetModules();
});

describe("buildInworldSpeechProvider", () => {
  afterEach(() => {
    inworldTTSMock.mockReset();
    listInworldVoicesMock.mockReset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports configured when INWORLD_API_KEY env var is set", () => {
    vi.stubEnv("INWORLD_API_KEY", "test-key");
    const provider = buildInworldSpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: {},
        timeoutMs: 30_000,
      }),
    ).toBe(true);
  });

  it("reports configured when providerConfig apiKey is set", () => {
    vi.stubEnv("INWORLD_API_KEY", "");
    const provider = buildInworldSpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "config-key" },
        timeoutMs: 30_000,
      }),
    ).toBe(true);
  });

  it("reports not configured when no key is available", () => {
    vi.stubEnv("INWORLD_API_KEY", "");
    const provider = buildInworldSpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: {},
        timeoutMs: 30_000,
      }),
    ).toBe(false);
  });

  it("rejects blank API keys across every request entrypoint", async () => {
    vi.stubEnv("INWORLD_API_KEY", "   ");
    const provider = buildInworldSpeechProvider();
    const listVoices = provider.listVoices;
    const synthesizeTelephony = provider.synthesizeTelephony;
    if (!listVoices || !synthesizeTelephony) {
      throw new Error("expected Inworld voice listing and telephony synthesis");
    }

    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "   " },
        timeoutMs: 30_000,
      }),
    ).toBe(false);

    await expect(
      listVoices({
        providerConfig: {},
        apiKey: "   ",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("Inworld API key missing");
    await expect(
      provider.synthesize({
        text: "test",
        cfg: {} as never,
        providerConfig: {},
        target: "audio-file",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("Inworld API key missing");
    await expect(
      synthesizeTelephony({
        text: "test",
        cfg: {} as never,
        providerConfig: {},
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("Inworld API key missing");

    expect(listInworldVoicesMock).not.toHaveBeenCalled();
    expect(inworldTTSMock).not.toHaveBeenCalled();
  });

  it("has correct provider metadata", () => {
    const provider = buildInworldSpeechProvider();
    expect(provider.id).toBe("inworld");
    expect(provider.label).toBe("Inworld");
    expect(provider.autoSelectOrder).toBe(30);
    expect(provider.models).toContain("inworld-tts-1.5-max");
    expect(provider.models).toContain("inworld-tts-1.5-mini");
  });

  it("forwards the core-resolved voice-list timeout", async () => {
    const provider = buildInworldSpeechProvider();

    await provider.listVoices?.({
      providerConfig: { apiKey: "test-key" },
      timeoutMs: 30_000,
    });

    expect(listInworldVoicesMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-key", timeoutMs: 30_000 }),
    );
  });

  it("normalizes provider-owned speech config from raw provider config", () => {
    const provider = buildInworldSpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          inworld: {
            apiKey: "basic-key",
            baseUrl: "https://custom.inworld.example.com/",
            voiceId: "Ashley",
            modelId: "inworld-tts-1.5-mini",
            temperature: 0.8,
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "basic-key",
      baseUrl: "https://custom.inworld.example.com",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      temperature: 0.8,
    });
  });

  it("parses Inworld TTS directive overrides", () => {
    const provider = buildInworldSpeechProvider();
    const policy = {
      enabled: true,
      allowText: true,
      allowProvider: true,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    };

    const parseDirectiveToken = provider.parseDirectiveToken;
    expect(parseDirectiveToken).toBeTypeOf("function");
    if (!parseDirectiveToken) {
      throw new Error("expected Inworld directive parser");
    }

    expect(parseDirectiveToken({ key: "voice", value: "Ashley", policy })).toEqual({
      handled: true,
      overrides: { voiceId: "Ashley" },
    });
    expect(
      parseDirectiveToken({
        key: "model",
        value: "inworld-tts-1.5-mini",
        policy,
      }),
    ).toEqual({
      handled: true,
      overrides: { modelId: "inworld-tts-1.5-mini" },
    });
    expect(parseDirectiveToken({ key: "temperature", value: "0.7", policy })).toEqual({
      handled: true,
      overrides: { temperature: 0.7 },
    });
  });

  it("warns on invalid directive temperature", () => {
    const provider = buildInworldSpeechProvider();
    expect(
      provider.parseDirectiveToken?.({
        key: "temperature",
        value: "3",
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
      warnings: ['invalid Inworld temperature "3"'],
    });
  });

  it("warns on non-decimal directive temperature", () => {
    const provider = buildInworldSpeechProvider();
    expect(
      provider.parseDirectiveToken?.({
        key: "temperature",
        value: "0x1",
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
      warnings: ['invalid Inworld temperature "0x1"'],
    });
  });

  it("drops malformed temperature values before synthesis", async () => {
    inworldTTSMock.mockResolvedValueOnce(Buffer.from("audio"));
    const provider = buildInworldSpeechProvider();

    await provider.synthesize?.({
      text: "Hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "key",
        voiceId: "Sarah",
        modelId: "inworld-tts-1.5-max",
        temperature: 0,
      },
      providerOverrides: { temperature: 3 },
      target: "audio-file",
      timeoutMs: 30_000,
    });

    expect(inworldTTSMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ temperature: expect.any(Number) }),
    );
  });

  it("synthesizes voice-note targets with native OGG_OPUS output", async () => {
    inworldTTSMock.mockResolvedValueOnce(Buffer.from("opus"));
    const provider = buildInworldSpeechProvider();

    const result = await provider.synthesize?.({
      text: "Hello",
      cfg: {} as never,
      providerConfig: { apiKey: "key", voiceId: "Sarah", modelId: "inworld-tts-1.5-max" },
      providerOverrides: { voice: "Ashley", model: "inworld-tts-1.5-mini", temperature: 0.6 },
      target: "voice-note",
      timeoutMs: 30_000,
    });

    expect(inworldTTSMock).toHaveBeenCalledWith({
      text: "Hello",
      apiKey: "key",
      baseUrl: "https://api.inworld.ai",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      audioEncoding: "OGG_OPUS",
      temperature: 0.6,
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from("opus"),
      outputFormat: "ogg_opus",
      fileExtension: ".ogg",
      voiceCompatible: true,
    });
  });

  it("synthesizes telephony PCM at 22050 Hz", async () => {
    inworldTTSMock.mockResolvedValueOnce(Buffer.from("pcm"));
    const provider = buildInworldSpeechProvider();

    const result = await provider.synthesizeTelephony?.({
      text: "Hello",
      cfg: {} as never,
      providerConfig: { apiKey: "key", voiceId: "Sarah", modelId: "inworld-tts-1.5-max" },
      providerOverrides: { voice: "Ashley", model: "inworld-tts-1.5-mini", temperature: 0.6 },
      timeoutMs: 30_000,
    });

    expect(inworldTTSMock).toHaveBeenCalledWith({
      text: "Hello",
      apiKey: "key",
      baseUrl: "https://api.inworld.ai",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      audioEncoding: "PCM",
      sampleRateHertz: 22_050,
      temperature: 0.6,
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from("pcm"),
      outputFormat: "pcm",
      sampleRate: 22_050,
    });
  });
});
