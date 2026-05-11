import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGradiumSpeechProvider } from "./speech-provider.js";

describe("gradium speech provider", () => {
  installPinnedHostnameTestHooks();

  const provider = buildGradiumSpeechProvider();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports configured when GRADIUM_API_KEY is set", () => {
    const original = process.env.GRADIUM_API_KEY;
    try {
      process.env.GRADIUM_API_KEY = "gsk_test";
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 5_000 })).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.GRADIUM_API_KEY;
      } else {
        process.env.GRADIUM_API_KEY = original;
      }
    }
  });

  it("reports not configured when no key is available", () => {
    const original = process.env.GRADIUM_API_KEY;
    try {
      delete process.env.GRADIUM_API_KEY;
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 5_000 })).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env.GRADIUM_API_KEY = original;
      }
    }
  });

  it("synthesizes audio via the Gradium TTS endpoint", async () => {
    const audioData = Buffer.from("wav-audio-data");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.synthesize({
      text: "OpenClaw test",
      cfg: {} as never,
      providerConfig: { apiKey: "gsk_test123" },
      target: "audio-file",
      timeoutMs: 30_000,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.gradium.ai/api/post/speech/tts");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("gsk_test123");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "OpenClaw test",
      voice_id: "YTpq7expH9539ERJ",
      only_audio: true,
      output_format: "wav",
      json_config: '{"padding_bonus":0}',
    });
    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.voiceCompatible).toBe(false);
    expect(result.audioBuffer).toEqual(audioData);
  });

  it("uses opus and voiceCompatible for voice-note target", async () => {
    const audioData = Buffer.from("opus-audio-data");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.synthesize({
      text: "Voice note test",
      cfg: {} as never,
      providerConfig: { apiKey: "gsk_test123" },
      target: "voice-note",
      timeoutMs: 30_000,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).output_format).toBe("opus");
    expect(result.outputFormat).toBe("opus");
    expect(result.fileExtension).toBe(".opus");
    expect(result.voiceCompatible).toBe(true);
    expect(result.audioBuffer).toEqual(audioData);
  });

  it("uses ulaw_8000 for telephony synthesis", async () => {
    const audioData = Buffer.from("ulaw-audio-data");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioData, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const synthesizeTelephony = provider.synthesizeTelephony;
    if (!synthesizeTelephony) {
      throw new Error("Expected Gradium provider synthesizeTelephony");
    }

    const result = await synthesizeTelephony({
      text: "Telephony test",
      cfg: {} as never,
      providerConfig: { apiKey: "gsk_test123", voiceId: "default-voice" },
      providerOverrides: { voiceId: "override-voice" },
      timeoutMs: 30_000,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Telephony test",
      voice_id: "override-voice",
      only_audio: true,
      output_format: "ulaw_8000",
      json_config: '{"padding_bonus":0}',
    });
    expect(result.outputFormat).toBe("ulaw_8000");
    expect(result.sampleRate).toBe(8_000);
    expect(result.audioBuffer).toEqual(audioData);
  });

  it("throws when no API key is available", async () => {
    const original = process.env.GRADIUM_API_KEY;
    try {
      delete process.env.GRADIUM_API_KEY;
      await expect(
        provider.synthesize({
          text: "test",
          cfg: {} as never,
          providerConfig: {},
          target: "audio-file",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("Gradium API key missing");
    } finally {
      if (original !== undefined) {
        process.env.GRADIUM_API_KEY = original;
      }
    }
  });
});
