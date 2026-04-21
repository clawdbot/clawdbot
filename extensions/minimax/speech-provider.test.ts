import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMinimaxSpeechProvider } from "./speech-provider.js";

describe("buildMinimaxSpeechProvider", () => {
  const provider = buildMinimaxSpeechProvider();

  describe("metadata", () => {
    it("has correct id and label", () => {
      expect(provider.id).toBe("minimax");
      expect(provider.label).toBe("MiniMax");
    });

    it("has autoSelectOrder 40", () => {
      expect(provider.autoSelectOrder).toBe(40);
    });

    it("exposes models and voices", () => {
      expect(provider.models).toContain("speech-2.8-hd");
      expect(provider.voices).toContain("English_expressive_narrator");
    });
  });

  describe("isConfigured", () => {
    const savedEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it("returns true when apiKey is in provider config", () => {
      expect(
        provider.isConfigured({ providerConfig: { apiKey: "sk-test" }, timeoutMs: 30000 }),
      ).toBe(true);
    });

    it("returns false when no apiKey anywhere", () => {
      delete process.env.MINIMAX_API_KEY;
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30000 })).toBe(false);
    });

    it("returns true when MINIMAX_API_KEY env var is set", () => {
      process.env.MINIMAX_API_KEY = "sk-env";
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30000 })).toBe(true);
    });
  });

  describe("resolveConfig", () => {
    const savedEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it("returns defaults when rawConfig is empty", () => {
      delete process.env.MINIMAX_API_HOST;
      delete process.env.MINIMAX_TTS_MODEL;
      delete process.env.MINIMAX_TTS_VOICE_ID;
      const config = provider.resolveConfig!({ rawConfig: {}, cfg: {} as never, timeoutMs: 30000 });
      expect(config.baseUrl).toBe("https://api.minimax.io");
      expect(config.model).toBe("speech-2.8-hd");
      expect(config.voiceId).toBe("English_expressive_narrator");
    });

    it("reads from providers.minimax in rawConfig", () => {
      const config = provider.resolveConfig!({
        rawConfig: {
          providers: {
            minimax: {
              baseUrl: "https://custom.api.com",
              model: "speech-01-240228",
              voiceId: "Chinese (Mandarin)_Warm_Girl",
              speed: 1.5,
              vol: 2.0,
              pitch: 3,
            },
          },
        },
        cfg: {} as never,
        timeoutMs: 30000,
      });
      expect(config.baseUrl).toBe("https://custom.api.com");
      expect(config.model).toBe("speech-01-240228");
      expect(config.voiceId).toBe("Chinese (Mandarin)_Warm_Girl");
      expect(config.speed).toBe(1.5);
      expect(config.vol).toBe(2.0);
      expect(config.pitch).toBe(3);
    });

    it("keeps trusted MINIMAX_API_HOST fallback for TTS baseUrl", () => {
      process.env.MINIMAX_API_HOST = "https://env.api.com";
      process.env.MINIMAX_TTS_MODEL = "speech-01-240228";
      process.env.MINIMAX_TTS_VOICE_ID = "Chinese (Mandarin)_Gentle_Boy";
      const config = provider.resolveConfig!({ rawConfig: {}, cfg: {} as never, timeoutMs: 30000 });
      expect(config.baseUrl).toBe("https://env.api.com");
      expect(config.model).toBe("speech-01-240228");
      expect(config.voiceId).toBe("Chinese (Mandarin)_Gentle_Boy");
    });
  });

  describe("parseDirectiveToken", () => {
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

    it("handles voice key", () => {
      const result = provider.parseDirectiveToken!({
        key: "voice",
        value: "Chinese (Mandarin)_Warm_Girl",
        policy,
      });
      expect(result.handled).toBe(true);
      expect(result.overrides?.voiceId).toBe("Chinese (Mandarin)_Warm_Girl");
    });

    it("handles voiceid key", () => {
      const result = provider.parseDirectiveToken!({ key: "voiceid", value: "test_voice", policy });
      expect(result.handled).toBe(true);
      expect(result.overrides?.voiceId).toBe("test_voice");
    });

    it("handles model key", () => {
      const result = provider.parseDirectiveToken!({
        key: "model",
        value: "speech-01-240228",
        policy,
      });
      expect(result.handled).toBe(true);
      expect(result.overrides?.model).toBe("speech-01-240228");
    });

    it("handles speed key with valid value", () => {
      const result = provider.parseDirectiveToken!({ key: "speed", value: "1.5", policy });
      expect(result.handled).toBe(true);
      expect(result.overrides?.speed).toBe(1.5);
    });

    it("warns on invalid speed", () => {
      const result = provider.parseDirectiveToken!({ key: "speed", value: "5.0", policy });
      expect(result.handled).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.overrides).toBeUndefined();
    });

    it("handles vol key", () => {
      const result = provider.parseDirectiveToken!({ key: "vol", value: "3", policy });
      expect(result.handled).toBe(true);
      expect(result.overrides?.vol).toBe(3);
    });

    it("warns on vol=0 (exclusive minimum)", () => {
      const result = provider.parseDirectiveToken!({ key: "vol", value: "0", policy });
      expect(result.handled).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });

    it("handles volume alias", () => {
      const result = provider.parseDirectiveToken!({ key: "volume", value: "5", policy });
      expect(result.handled).toBe(true);
      expect(result.overrides?.vol).toBe(5);
    });

    it("handles pitch key", () => {
      const result = provider.parseDirectiveToken!({ key: "pitch", value: "-3", policy });
      expect(result.handled).toBe(true);
      expect(result.overrides?.pitch).toBe(-3);
    });

    it("warns on out-of-range pitch", () => {
      const result = provider.parseDirectiveToken!({ key: "pitch", value: "20", policy });
      expect(result.handled).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });

    it("returns handled=false for unknown keys", () => {
      const result = provider.parseDirectiveToken!({
        key: "unknown_key",
        value: "whatever",
        policy,
      });
      expect(result.handled).toBe(false);
    });

    it("suppresses voice when policy disallows it", () => {
      const result = provider.parseDirectiveToken!({
        key: "voice",
        value: "test",
        policy: { ...policy, allowVoice: false },
      });
      expect(result.handled).toBe(true);
      expect(result.overrides).toBeUndefined();
    });

    it("suppresses model when policy disallows it", () => {
      const result = provider.parseDirectiveToken!({
        key: "model",
        value: "test",
        policy: { ...policy, allowModelId: false },
      });
      expect(result.handled).toBe(true);
      expect(result.overrides).toBeUndefined();
    });
  });

  describe("synthesize", () => {
    const savedFetch = globalThis.fetch;

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      globalThis.fetch = savedFetch;
      vi.restoreAllMocks();
    });

    it("makes correct API call and decodes hex response", async () => {
      const hexAudio = Buffer.from("fake-audio-data").toString("hex");
      const mockFetch = vi.mocked(globalThis.fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { audio: hexAudio } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await provider.synthesize({
        text: "Hello world",
        cfg: {} as never,
        providerConfig: { apiKey: "sk-test", baseUrl: "https://api.minimaxi.com" },
        target: "audio-file",
        timeoutMs: 30000,
      });

      expect(result.outputFormat).toBe("mp3");
      expect(result.fileExtension).toBe(".mp3");
      expect(result.voiceCompatible).toBe(false);
      expect(result.audioBuffer.toString()).toBe("fake-audio-data");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.minimaxi.com/v1/t2a_v2");
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("speech-2.8-hd");
      expect(body.text).toBe("Hello world");
      expect(body.voice_setting.voice_id).toBe("English_expressive_narrator");
    });

    it("applies overrides", async () => {
      const hexAudio = Buffer.from("audio").toString("hex");
      const mockFetch = vi.mocked(globalThis.fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { audio: hexAudio } }), { status: 200 }),
      );

      await provider.synthesize({
        text: "Test",
        cfg: {} as never,
        providerConfig: { apiKey: "sk-test" },
        providerOverrides: { model: "speech-01-240228", voiceId: "custom_voice", speed: 1.5 },
        target: "audio-file",
        timeoutMs: 30000,
      });

      const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);
      expect(body.model).toBe("speech-01-240228");
      expect(body.voice_setting.voice_id).toBe("custom_voice");
      expect(body.voice_setting.speed).toBe(1.5);
    });

    it("throws when API key is missing", async () => {
      const savedKey = process.env.MINIMAX_API_KEY;
      delete process.env.MINIMAX_API_KEY;
      try {
        await expect(
          provider.synthesize({
            text: "Test",
            cfg: {} as never,
            providerConfig: {},
            target: "audio-file",
            timeoutMs: 30000,
          }),
        ).rejects.toThrow("MiniMax API key missing");
      } finally {
        if (savedKey) {
          process.env.MINIMAX_API_KEY = savedKey;
        }
      }
    });

    it("throws on API error with response body", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );
      await expect(
        provider.synthesize({
          text: "Test",
          cfg: {} as never,
          providerConfig: { apiKey: "sk-test" },
          target: "audio-file",
          timeoutMs: 30000,
        }),
      ).rejects.toThrow("MiniMax TTS API error (401): Unauthorized");
    });
  });

  describe("listVoices", () => {
    it("returns known voices", async () => {
      const voices = await provider.listVoices!({} as never);
      expect(voices.length).toBeGreaterThan(0);
      expect(voices[0].id).toBe("English_expressive_narrator");
    });
  });
});
