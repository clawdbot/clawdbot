import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { azureSpeechTTSMock, listAzureSpeechVoicesMock } = vi.hoisted(() => ({
  azureSpeechTTSMock: vi.fn(async () => Buffer.from("audio-bytes")),
  listAzureSpeechVoicesMock: vi.fn(async () => [{ id: "en-US-JennyNeural", name: "Jenny" }]),
}));

vi.mock("./tts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tts.js")>();
  return {
    ...actual,
    azureSpeechTTS: azureSpeechTTSMock,
    listAzureSpeechVoices: listAzureSpeechVoicesMock,
  };
});

import { buildAzureSpeechProvider } from "./speech-provider.js";

describe("buildAzureSpeechProvider", () => {
  const originalEnv = {
    AZURE_SPEECH_KEY: process.env.AZURE_SPEECH_KEY,
    AZURE_SPEECH_API_KEY: process.env.AZURE_SPEECH_API_KEY,
    AZURE_SPEECH_REGION: process.env.AZURE_SPEECH_REGION,
    AZURE_SPEECH_ENDPOINT: process.env.AZURE_SPEECH_ENDPOINT,
    SPEECH_KEY: process.env.SPEECH_KEY,
    SPEECH_REGION: process.env.SPEECH_REGION,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    azureSpeechTTSMock.mockClear();
    listAzureSpeechVoicesMock.mockClear();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./tts.js");
    vi.resetModules();
  });

  it("reports configured only when key plus region or endpoint is available", () => {
    const provider = buildAzureSpeechProvider();
    delete process.env.AZURE_SPEECH_KEY;
    delete process.env.AZURE_SPEECH_API_KEY;
    delete process.env.SPEECH_KEY;
    delete process.env.AZURE_SPEECH_REGION;
    delete process.env.SPEECH_REGION;
    delete process.env.AZURE_SPEECH_ENDPOINT;

    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30_000 })).toBe(false);
    expect(provider.isConfigured({ providerConfig: { apiKey: "key" }, timeoutMs: 30_000 })).toBe(
      false,
    );
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "key", region: "eastus" },
        timeoutMs: 30_000,
      }),
    ).toBe(true);

    process.env.AZURE_SPEECH_KEY = "env-key";
    process.env.AZURE_SPEECH_REGION = "eastus";
    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30_000 })).toBe(true);
  });

  it("normalizes provider-owned config under canonical and alias keys", () => {
    const provider = buildAzureSpeechProvider();
    const canonical = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          "azure-speech": {
            apiKey: "key",
            region: "eastus",
            voice: "en-US-AriaNeural",
            lang: "en-US",
          },
        },
      },
    });
    const alias = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          azure: {
            apiKey: "alias-key",
            endpoint: "https://westus.tts.speech.microsoft.com/cognitiveservices/v1",
          },
        },
      },
    });

    expect(canonical).toEqual(
      expect.objectContaining({
        apiKey: "key",
        region: "eastus",
        baseUrl: "https://eastus.tts.speech.microsoft.com",
        voice: "en-US-AriaNeural",
      }),
    );
    expect(alias).toEqual(
      expect.objectContaining({
        apiKey: "alias-key",
        endpoint: "https://westus.tts.speech.microsoft.com/cognitiveservices/v1",
        baseUrl: "https://westus.tts.speech.microsoft.com",
      }),
    );
  });

  it("parses provider-specific TTS directives", () => {
    const provider = buildAzureSpeechProvider();
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

    expect(provider.parseDirectiveToken?.({ key: "azure_voice", value: "v", policy })).toEqual({
      handled: true,
      overrides: { voice: "v" },
    });
    expect(provider.parseDirectiveToken?.({ key: "azure_lang", value: "en-US", policy })).toEqual({
      handled: true,
      overrides: { lang: "en-US" },
    });
    expect(
      provider.parseDirectiveToken?.({ key: "azure_output_format", value: "ogg", policy }),
    ).toEqual({
      handled: true,
      overrides: { outputFormat: "ogg" },
    });
  });

  it("uses native Ogg/Opus for voice-note output", async () => {
    const provider = buildAzureSpeechProvider();
    const result = await provider.synthesize({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "key",
        region: "eastus",
        voice: "en-US-JennyNeural",
      },
      providerOverrides: {
        voice: "en-US-AriaNeural",
        lang: "en-US",
      },
      target: "voice-note",
      timeoutMs: 30_000,
    });

    expect(azureSpeechTTSMock).toHaveBeenCalledWith({
      text: "hello",
      apiKey: "key",
      baseUrl: "https://eastus.tts.speech.microsoft.com",
      endpoint: undefined,
      region: "eastus",
      voice: "en-US-AriaNeural",
      lang: "en-US",
      outputFormat: "ogg-24khz-16bit-mono-opus",
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from("audio-bytes"),
      outputFormat: "ogg-24khz-16bit-mono-opus",
      fileExtension: ".ogg",
      voiceCompatible: true,
    });
  });

  it("honors voice and language overrides for telephony output", async () => {
    const provider = buildAzureSpeechProvider();
    const result = await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        apiKey: "key",
        region: "eastus",
        voice: "en-US-JennyNeural",
        lang: "en-US",
      },
      providerOverrides: {
        voice: "en-US-AriaNeural",
        lang: "es-US",
      },
      timeoutMs: 30_000,
    });

    expect(azureSpeechTTSMock).toHaveBeenCalledWith({
      text: "hello",
      apiKey: "key",
      baseUrl: "https://eastus.tts.speech.microsoft.com",
      endpoint: undefined,
      region: "eastus",
      voice: "en-US-AriaNeural",
      lang: "es-US",
      outputFormat: "raw-8khz-8bit-mono-mulaw",
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from("audio-bytes"),
      outputFormat: "raw-8khz-8bit-mono-mulaw",
      sampleRate: 8_000,
    });
  });

  it("lists voices through config or explicit request auth", async () => {
    const provider = buildAzureSpeechProvider();
    const voices = await provider.listVoices?.({
      providerConfig: { apiKey: "key", region: "eastus" },
    });

    expect(voices).toEqual([{ id: "en-US-JennyNeural", name: "Jenny" }]);
    expect(listAzureSpeechVoicesMock).toHaveBeenCalledWith({
      apiKey: "key",
      baseUrl: "https://eastus.tts.speech.microsoft.com",
      endpoint: undefined,
      region: "eastus",
      timeoutMs: undefined,
    });
  });
});
