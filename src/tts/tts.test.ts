import { describe, expect, it, vi, beforeEach } from "vitest";

import { completeSimple } from "@mariozechner/pi-ai";

import { getApiKeyForModel } from "../agents/model-auth.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import * as tts from "./tts.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn((provider: string, modelId: string) => ({
    model: {
      provider,
      id: modelId,
      name: modelId,
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    },
    authStorage: { profiles: {} },
    modelRegistry: { find: vi.fn() },
  })),
}));

vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-api-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
}));

const { _test, resolveTtsConfig, maybeApplyTtsToPayload, getTtsProvider } = tts;

const {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  parseTtsDirectives,
  resolveModelOverridePolicy,
  summarizeText,
  resolveOutputFormat,
  resolveEdgeOutputFormat,
} = _test;

describe("tts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "Summary" }],
    });
  });

  describe("isValidVoiceId", () => {
    it("accepts valid ElevenLabs voice IDs", () => {
      expect(isValidVoiceId("pMsXgVXv3BLzUgSXRplE")).toBe(true);
      expect(isValidVoiceId("21m00Tcm4TlvDq8ikWAM")).toBe(true);
      expect(isValidVoiceId("EXAVITQu4vr4xnSDxMaL")).toBe(true);
    });

    it("accepts voice IDs of varying valid lengths", () => {
      expect(isValidVoiceId("a1b2c3d4e5")).toBe(true);
      expect(isValidVoiceId("a".repeat(40))).toBe(true);
    });

    it("rejects too short voice IDs", () => {
      expect(isValidVoiceId("")).toBe(false);
      expect(isValidVoiceId("abc")).toBe(false);
      expect(isValidVoiceId("123456789")).toBe(false);
    });

    it("rejects too long voice IDs", () => {
      expect(isValidVoiceId("a".repeat(41))).toBe(false);
      expect(isValidVoiceId("a".repeat(100))).toBe(false);
    });

    it("rejects voice IDs with invalid characters", () => {
      expect(isValidVoiceId("pMsXgVXv3BLz-gSXRplE")).toBe(false);
      expect(isValidVoiceId("pMsXgVXv3BLz_gSXRplE")).toBe(false);
      expect(isValidVoiceId("pMsXgVXv3BLz gSXRplE")).toBe(false);
      expect(isValidVoiceId("../../../etc/passwd")).toBe(false);
      expect(isValidVoiceId("voice?param=value")).toBe(false);
    });
  });

  describe("isValidOpenAIVoice", () => {
    it("accepts all valid OpenAI voices", () => {
      for (const voice of OPENAI_TTS_VOICES) {
        expect(isValidOpenAIVoice(voice)).toBe(true);
      }
    });

    it("rejects invalid voice names", () => {
      expect(isValidOpenAIVoice("invalid")).toBe(false);
      expect(isValidOpenAIVoice("")).toBe(false);
      expect(isValidOpenAIVoice("ALLOY")).toBe(false);
      expect(isValidOpenAIVoice("alloy ")).toBe(false);
      expect(isValidOpenAIVoice(" alloy")).toBe(false);
    });
  });

  describe("isValidOpenAIModel", () => {
    it("accepts supported models", () => {
      expect(isValidOpenAIModel("gpt-4o-mini-tts")).toBe(true);
      expect(isValidOpenAIModel("tts-1")).toBe(true);
      expect(isValidOpenAIModel("tts-1-hd")).toBe(true);
    });

    it("rejects unsupported models", () => {
      expect(isValidOpenAIModel("invalid")).toBe(false);
      expect(isValidOpenAIModel("")).toBe(false);
      expect(isValidOpenAIModel("gpt-4")).toBe(false);
    });
  });

  describe("OPENAI_TTS_MODELS", () => {
    it("contains supported models", () => {
      expect(OPENAI_TTS_MODELS).toContain("gpt-4o-mini-tts");
      expect(OPENAI_TTS_MODELS).toContain("tts-1");
      expect(OPENAI_TTS_MODELS).toContain("tts-1-hd");
      expect(OPENAI_TTS_MODELS).toHaveLength(3);
    });

    it("is a non-empty array", () => {
      expect(Array.isArray(OPENAI_TTS_MODELS)).toBe(true);
      expect(OPENAI_TTS_MODELS.length).toBeGreaterThan(0);
    });
  });

  describe("resolveOutputFormat", () => {
    it("uses Opus for Telegram", () => {
      const output = resolveOutputFormat("telegram");
      expect(output.openai).toBe("opus");
      expect(output.elevenlabs).toBe("opus_48000_64");
      expect(output.extension).toBe(".opus");
      expect(output.voiceCompatible).toBe(true);
    });

    it("uses MP3 for other channels", () => {
      const output = resolveOutputFormat("discord");
      expect(output.openai).toBe("mp3");
      expect(output.elevenlabs).toBe("mp3_44100_128");
      expect(output.extension).toBe(".mp3");
      expect(output.voiceCompatible).toBe(false);
    });
  });

  describe("resolveEdgeOutputFormat", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it("uses default output format when edge output format is not configured", () => {
      const config = resolveTtsConfig(baseCfg);
      expect(resolveEdgeOutputFormat(config)).toBe("audio-24khz-48kbitrate-mono-mp3");
    });

    it("uses configured output format when provided", () => {
      const config = resolveTtsConfig({
        ...baseCfg,
        messages: {
          tts: {
            edge: { outputFormat: "audio-24khz-96kbitrate-mono-mp3" },
          },
        },
      });
      expect(resolveEdgeOutputFormat(config)).toBe("audio-24khz-96kbitrate-mono-mp3");
    });
  });

  describe("parseTtsDirectives", () => {
    it("extracts overrides and strips directives when enabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input =
        "Hello [[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE stability=0.4 speed=1.1]] world\n\n" +
        "[[tts:text]](laughs) Read the song once more.[[/tts:text]]";
      const result = parseTtsDirectives(input, policy);

      expect(result.cleanedText).not.toContain("[[tts:");
      expect(result.ttsText).toBe("(laughs) Read the song once more.");
      expect(result.overrides.provider).toBe("elevenlabs");
      expect(result.overrides.elevenlabs?.voiceId).toBe("pMsXgVXv3BLzUgSXRplE");
      expect(result.overrides.elevenlabs?.voiceSettings?.stability).toBe(0.4);
      expect(result.overrides.elevenlabs?.voiceSettings?.speed).toBe(1.1);
    });

    it("accepts edge as provider override", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:provider=edge]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.provider).toBe("edge");
    });

    it("keeps text intact when overrides are disabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: false });
      const input = "Hello [[tts:voice=alloy]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.cleanedText).toBe(input);
      expect(result.overrides.provider).toBeUndefined();
    });
  });

  describe("summarizeText", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };
    const baseConfig = resolveTtsConfig(baseCfg);

    it("summarizes text and returns result with metrics", async () => {
      const mockSummary = "This is a summarized version of the text.";
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: mockSummary }],
      });

      const longText = "A".repeat(2000);
      const result = await summarizeText({
        text: longText,
        targetLength: 1500,
        cfg: baseCfg,
        config: baseConfig,
        timeoutMs: 30_000,
      });

      expect(result.summary).toBe(mockSummary);
      expect(result.inputLength).toBe(2000);
      expect(result.outputLength).toBe(mockSummary.length);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(completeSimple).toHaveBeenCalledTimes(1);
    });

    it("calls the summary model with the expected parameters", async () => {
      await summarizeText({
        text: "Long text to summarize",
        targetLength: 500,
        cfg: baseCfg,
        config: baseConfig,
        timeoutMs: 30_000,
      });

      const callArgs = vi.mocked(completeSimple).mock.calls[0];
      expect(callArgs?.[1]?.messages?.[0]?.role).toBe("user");
      expect(callArgs?.[2]?.maxTokens).toBe(250);
      expect(callArgs?.[2]?.temperature).toBe(0.3);
      expect(getApiKeyForModel).toHaveBeenCalledTimes(1);
    });

    it("uses summaryModel override when configured", async () => {
      const cfg = {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
        messages: { tts: { summaryModel: "openai/gpt-4.1-mini" } },
      };
      const config = resolveTtsConfig(cfg);
      await summarizeText({
        text: "Long text to summarize",
        targetLength: 500,
        cfg,
        config,
        timeoutMs: 30_000,
      });

      expect(resolveModel).toHaveBeenCalledWith("openai", "gpt-4.1-mini", undefined, cfg);
    });

    it("rejects targetLength below minimum (100)", async () => {
      await expect(
        summarizeText({
          text: "text",
          targetLength: 99,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow("Invalid targetLength: 99");
    });

    it("rejects targetLength above maximum (10000)", async () => {
      await expect(
        summarizeText({
          text: "text",
          targetLength: 10001,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow("Invalid targetLength: 10001");
    });

    it("accepts targetLength at boundaries", async () => {
      await expect(
        summarizeText({
          text: "text",
          targetLength: 100,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).resolves.toBeDefined();
      await expect(
        summarizeText({
          text: "text",
          targetLength: 10000,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).resolves.toBeDefined();
    });

    it("throws error when no summary is returned", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [],
      });

      await expect(
        summarizeText({
          text: "text",
          targetLength: 500,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow("No summary returned");
    });

    it("throws error when summary content is empty", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: "   " }],
      });

      await expect(
        summarizeText({
          text: "text",
          targetLength: 500,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow("No summary returned");
    });
  });

  describe("getTtsProvider", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    const restoreEnv = (snapshot: Record<string, string | undefined>) => {
      const keys = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "XI_API_KEY"] as const;
      for (const key of keys) {
        const value = snapshot[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    const withEnv = (env: Record<string, string | undefined>, run: () => void) => {
      const snapshot = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
        XI_API_KEY: process.env.XI_API_KEY,
      };
      try {
        for (const [key, value] of Object.entries(env)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        run();
      } finally {
        restoreEnv(snapshot);
      }
    };

    it("prefers OpenAI when no provider is configured and API key exists", () => {
      withEnv(
        {
          OPENAI_API_KEY: "test-openai-key",
          ELEVENLABS_API_KEY: undefined,
          XI_API_KEY: undefined,
        },
        () => {
          const config = resolveTtsConfig(baseCfg);
          const provider = getTtsProvider(config, "/tmp/tts-prefs-openai.json");
          expect(provider).toBe("openai");
        },
      );
    });

    it("prefers ElevenLabs when OpenAI is missing and ElevenLabs key exists", () => {
      withEnv(
        {
          OPENAI_API_KEY: undefined,
          ELEVENLABS_API_KEY: "test-elevenlabs-key",
          XI_API_KEY: undefined,
        },
        () => {
          const config = resolveTtsConfig(baseCfg);
          const provider = getTtsProvider(config, "/tmp/tts-prefs-elevenlabs.json");
          expect(provider).toBe("elevenlabs");
        },
      );
    });

    it("falls back to Edge when no API keys are present", () => {
      withEnv(
        {
          OPENAI_API_KEY: undefined,
          ELEVENLABS_API_KEY: undefined,
          XI_API_KEY: undefined,
        },
        () => {
          const config = resolveTtsConfig(baseCfg);
          const provider = getTtsProvider(config, "/tmp/tts-prefs-edge.json");
          expect(provider).toBe("edge");
        },
      );
    });
  });

  describe("maybeApplyTtsToPayload", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: {
        tts: {
          auto: "inbound",
          provider: "openai",
          openai: { apiKey: "test-key", model: "gpt-4o-mini-tts", voice: "alloy" },
        },
      },
    };

    it("skips auto-TTS when inbound audio gating is on and the message is not audio", async () => {
      const prevPrefs = process.env.CLAWDBOT_TTS_PREFS;
      process.env.CLAWDBOT_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const payload = { text: "Hello world" };
      const result = await maybeApplyTtsToPayload({
        payload,
        cfg: baseCfg,
        kind: "final",
        inboundAudio: false,
      });

      expect(result).toBe(payload);
      expect(fetchMock).not.toHaveBeenCalled();

      globalThis.fetch = originalFetch;
      process.env.CLAWDBOT_TTS_PREFS = prevPrefs;
    });

    it("attempts auto-TTS when inbound audio gating is on and the message is audio", async () => {
      const prevPrefs = process.env.CLAWDBOT_TTS_PREFS;
      process.env.CLAWDBOT_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await maybeApplyTtsToPayload({
        payload: { text: "Hello world" },
        cfg: baseCfg,
        kind: "final",
        inboundAudio: true,
      });

      expect(result.mediaUrl).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      globalThis.fetch = originalFetch;
      process.env.CLAWDBOT_TTS_PREFS = prevPrefs;
    });

    it("skips auto-TTS in tagged mode unless a tts tag is present", async () => {
      const prevPrefs = process.env.CLAWDBOT_TTS_PREFS;
      process.env.CLAWDBOT_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg = {
        ...baseCfg,
        messages: {
          ...baseCfg.messages,
          tts: { ...baseCfg.messages.tts, auto: "tagged" },
        },
      };

      const payload = { text: "Hello world" };
      const result = await maybeApplyTtsToPayload({
        payload,
        cfg,
        kind: "final",
      });

      expect(result).toBe(payload);
      expect(fetchMock).not.toHaveBeenCalled();

      globalThis.fetch = originalFetch;
      process.env.CLAWDBOT_TTS_PREFS = prevPrefs;
    });

    it("runs auto-TTS in tagged mode when tags are present", async () => {
      const prevPrefs = process.env.CLAWDBOT_TTS_PREFS;
      process.env.CLAWDBOT_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg = {
        ...baseCfg,
        messages: {
          ...baseCfg.messages,
          tts: { ...baseCfg.messages.tts, auto: "tagged" },
        },
      };

      const result = await maybeApplyTtsToPayload({
        payload: { text: "[[tts:text]]Hello world[[/tts:text]]" },
        cfg,
        kind: "final",
      });

      expect(result.mediaUrl).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      globalThis.fetch = originalFetch;
      process.env.CLAWDBOT_TTS_PREFS = prevPrefs;
    });
  });
});
