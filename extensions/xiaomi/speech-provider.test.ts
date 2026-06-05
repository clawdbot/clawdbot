// Xiaomi tests cover speech provider plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
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
      expect(provider.models).toContain("mimo-v2.5-tts-voicedesign");
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
      expect(config).toEqual({
        apiKey: undefined,
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

    it("accepts generic model and speaker voice aliases", () => {
      const config = provider.resolveConfig!({
        rawConfig: {
          providers: {
            xiaomi: {
              modelId: "mimo-v2.5-tts-voicedesign",
              speakerVoice: "Chloe",
            },
          },
        },
        cfg: {} as never,
        timeoutMs: 30000,
      });

      expect(config.model).toBe("mimo-v2.5-tts-voicedesign");
      expect(config.voice).toBe("Chloe");
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
      vi.unstubAllGlobals();
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
      const [url, init] = mockFetch.mock.calls[0] ?? [];
      expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
      expect(init?.headers).toEqual({
        "api-key": "sk-test",
        "Content-Type": "application/json",
      });
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("mimo-v2-tts");
      expect(body.messages).toEqual([
        { role: "user", content: "Bright." },
        { role: "assistant", content: "Hello from OpenClaw." },
      ]);
      expect(body.audio).toEqual({ format: "mp3", voice: "default_en" });
      expect(transcodeAudioBufferToOpusMock).not.toHaveBeenCalled();
    });

    it("omits voice and uses configured style for Xiaomi voice design models", async () => {
      const audio = Buffer.from("fake-wav-audio").toString("base64");
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
          modelId: "mimo-v2.5-tts-voicedesign",
          speakerVoice: "Chloe",
          format: "wav",
          style: "Warm, bright, natural voice.",
        },
        target: "audio-file",
        timeoutMs: 30000,
      });

      expect(result.outputFormat).toBe("wav");
      expect(result.fileExtension).toBe(".wav");
      expect(result.voiceCompatible).toBe(false);
      expect(result.audioBuffer.toString()).toBe("fake-wav-audio");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] ?? [];
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("mimo-v2.5-tts-voicedesign");
      expect(body.messages).toEqual([
        { role: "user", content: "Warm, bright, natural voice." },
        { role: "assistant", content: "Hello from OpenClaw." },
      ]);
      expect(body.audio).toEqual({ format: "wav" });
    });

    it("uses a default style for Xiaomi voice design models", async () => {
      const audio = Buffer.from("fake-mp3-audio").toString("base64");
      const mockFetch = vi.mocked(globalThis.fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { audio: { data: audio } } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await provider.synthesize({
        text: "Hello from OpenClaw.",
        cfg: {} as never,
        providerConfig: {
          apiKey: "sk-test",
          model: "mimo-v2.5-tts-voicedesign",
        },
        target: "audio-file",
        timeoutMs: 30000,
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] ?? [];
      const body = JSON.parse(init!.body as string);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]?.role).toBe("user");
      expect(body.messages[0]?.content).toContain("natural");
      expect(body.messages[1]).toEqual({
        role: "assistant",
        content: "Hello from OpenClaw.",
      });
      expect(body.audio).toEqual({ format: "mp3" });
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

    it("transcodes Xiaomi voice design output to Opus for voice-note targets", async () => {
      const audio = Buffer.from("fake-wav-audio").toString("base64");
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
        providerConfig: {
          apiKey: "sk-test",
          model: "mimo-v2.5-tts-voicedesign",
          format: "wav",
        },
        target: "voice-note",
        timeoutMs: 30000,
      });

      expect(result.outputFormat).toBe("opus");
      expect(result.fileExtension).toBe(".opus");
      expect(result.voiceCompatible).toBe(true);
      expect(result.audioBuffer.toString()).toBe("fake-opus-audio");
      expect(transcodeAudioBufferToOpusMock).toHaveBeenCalledWith({
        audioBuffer: Buffer.from("fake-wav-audio"),
        inputExtension: "wav",
        tempPrefix: "tts-xiaomi-",
        timeoutMs: 30000,
      });
      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
      const body = JSON.parse(init!.body as string);
      expect(body.audio).toEqual({ format: "wav" });
    });

    it("caps oversized TTS request timeouts before scheduling or fetching", async () => {
      const audio = Buffer.from("fake-mp3-audio").toString("base64");
      const timeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
      const clearTimeoutSpy = vi
        .spyOn(globalThis, "clearTimeout")
        .mockImplementation(() => undefined);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { audio: { data: audio } } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      try {
        await provider.synthesize({
          text: "Hello from OpenClaw.",
          cfg: {} as never,
          providerConfig: { apiKey: "sk-test" },
          target: "audio-file",
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
        });

        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      } finally {
        timeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
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
        if (savedKey === undefined) {
          delete process.env.XIAOMI_API_KEY;
        } else {
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
