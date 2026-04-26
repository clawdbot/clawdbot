import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcodeAudioBufferToOpusMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: transcodeAudioBufferToOpusMock,
}));

import { buildXiaomiSpeechProvider } from "./speech-provider.js";

describe("buildXiaomiSpeechProvider", () => {
  const provider = buildXiaomiSpeechProvider();

  describe("metadata", () => {
    it("registers Xiaomi MiMo as a speech provider", () => {
      expect(provider.id).toBe("xiaomi");
      expect(provider.aliases).toContain("mimo");
      expect(provider.models).toContain("mimo-v2.5-tts");
      expect(provider.models).toContain("mimo-v2-tts");
      expect(provider.voices).toContain("mimo_default");
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

    it("returns false when no apiKey is available", () => {
      delete process.env.XIAOMI_API_KEY;
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30000 })).toBe(false);
    });

    it("returns true when XIAOMI_API_KEY env var is set", () => {
      process.env.XIAOMI_API_KEY = "sk-env";
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30000 })).toBe(true);
    });
  });

  describe("resolveConfig", () => {
    it("reads providers.xiaomi settings", () => {
      const config = provider.resolveConfig!({
        rawConfig: {
          providers: {
            xiaomi: {
              baseUrl: "https://example.com/v1/",
              model: "mimo-v2-tts",
              voice: "default_en",
              format: "wav",
              style: "Bright and fast.",
            },
          },
        },
        cfg: {} as never,
        timeoutMs: 30000,
      });
      expect(config).toMatchObject({
        baseUrl: "https://example.com/v1",
        model: "mimo-v2-tts",
        voice: "default_en",
        format: "wav",
        style: "Bright and fast.",
      });
    });

    it("accepts the mimo provider config alias", () => {
      const config = provider.resolveConfig!({
        rawConfig: { providers: { mimo: { voiceId: "default_zh" } } },
        cfg: {} as never,
        timeoutMs: 30000,
      });
      expect(config.voice).toBe("default_zh");
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

    it("handles voice, model, style, and format tokens", () => {
      expect(provider.parseDirectiveToken!({ key: "voice", value: "default_en", policy })).toEqual({
        handled: true,
        overrides: { voice: "default_en" },
      });
      expect(provider.parseDirectiveToken!({ key: "model", value: "mimo-v2-tts", policy })).toEqual(
        { handled: true, overrides: { model: "mimo-v2-tts" } },
      );
      expect(provider.parseDirectiveToken!({ key: "style", value: "whispered", policy })).toEqual({
        handled: true,
        overrides: { style: "whispered" },
      });
      expect(provider.parseDirectiveToken!({ key: "format", value: "wav", policy })).toEqual({
        handled: true,
        overrides: { format: "wav" },
      });
    });

    it("warns on invalid format", () => {
      const result = provider.parseDirectiveToken!({ key: "format", value: "ogg", policy });
      expect(result.handled).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("synthesize", () => {
    const savedFetch = globalThis.fetch;

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
      transcodeAudioBufferToOpusMock.mockReset();
    });

    afterEach(() => {
      globalThis.fetch = savedFetch;
      vi.restoreAllMocks();
    });

    it("makes the Xiaomi chat completions TTS call and decodes audio", async () => {
      const audio = Buffer.from("fake-mp3-audio").toString("base64");
      const mockFetch = vi.mocked(globalThis.fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { audio: { data: audio } } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await provider.synthesize({
        text: "Hello from OpenClaw.",
        cfg: {} as never,
        providerConfig: {
          apiKey: "sk-test",
          model: "mimo-v2-tts",
          voice: "default_en",
          style: "Bright.",
        },
        target: "audio-file",
        timeoutMs: 30000,
      });

      expect(result.outputFormat).toBe("mp3");
      expect(result.fileExtension).toBe(".mp3");
      expect(result.voiceCompatible).toBe(false);
      expect(result.audioBuffer.toString()).toBe("fake-mp3-audio");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
      expect(init?.headers).toMatchObject({ "api-key": "sk-test" });
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("mimo-v2-tts");
      expect(body.messages).toEqual([
        { role: "user", content: "Bright." },
        { role: "assistant", content: "Hello from OpenClaw." },
      ]);
      expect(body.audio).toEqual({ format: "mp3", voice: "default_en" });
      expect(transcodeAudioBufferToOpusMock).not.toHaveBeenCalled();
    });

    it("transcodes Xiaomi output to Opus for voice-note targets", async () => {
      const audio = Buffer.from("fake-mp3-audio").toString("base64");
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { audio: { data: audio } } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      transcodeAudioBufferToOpusMock.mockResolvedValueOnce(Buffer.from("fake-opus-audio"));

      const result = await provider.synthesize({
        text: "Hello from OpenClaw.",
        cfg: {} as never,
        providerConfig: { apiKey: "sk-test" },
        target: "voice-note",
        timeoutMs: 30000,
      });

      expect(result.outputFormat).toBe("opus");
      expect(result.fileExtension).toBe(".opus");
      expect(result.voiceCompatible).toBe(true);
      expect(result.audioBuffer.toString()).toBe("fake-opus-audio");
      expect(transcodeAudioBufferToOpusMock).toHaveBeenCalledWith({
        audioBuffer: Buffer.from("fake-mp3-audio"),
        inputExtension: "mp3",
        tempPrefix: "tts-xiaomi-",
        timeoutMs: 30000,
      });
    });

    it("throws when API key is missing", async () => {
      const savedKey = process.env.XIAOMI_API_KEY;
      delete process.env.XIAOMI_API_KEY;
      try {
        await expect(
          provider.synthesize({
            text: "Test",
            cfg: {} as never,
            providerConfig: {},
            target: "audio-file",
            timeoutMs: 30000,
          }),
        ).rejects.toThrow("Xiaomi API key missing");
      } finally {
        if (savedKey) {
          process.env.XIAOMI_API_KEY = savedKey;
        }
      }
    });

    it("throws when the API response has no audio data", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: {} }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await expect(
        provider.synthesize({
          text: "Test",
          cfg: {} as never,
          providerConfig: { apiKey: "sk-test" },
          target: "audio-file",
          timeoutMs: 30000,
        }),
      ).rejects.toThrow("Xiaomi TTS API returned no audio data");
    });
  });
});
