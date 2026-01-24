/**
 * Unit tests for telegram-tts extension
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { _test, meta } from "./index.js";

const { isValidVoiceId, isValidOpenAIVoice, isValidOpenAIModel, OPENAI_TTS_MODELS, summarizeText } = _test;

describe("telegram-tts", () => {
  describe("meta", () => {
    it("should have correct plugin metadata", () => {
      expect(meta.id).toBe("telegram-tts");
      expect(meta.name).toBe("Telegram TTS");
      expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe("isValidVoiceId", () => {
    it("should accept valid ElevenLabs voice IDs", () => {
      // Real ElevenLabs voice ID format (20 alphanumeric chars)
      expect(isValidVoiceId("pMsXgVXv3BLzUgSXRplE")).toBe(true);
      expect(isValidVoiceId("21m00Tcm4TlvDq8ikWAM")).toBe(true);
      expect(isValidVoiceId("EXAVITQu4vr4xnSDxMaL")).toBe(true);
    });

    it("should accept voice IDs of varying valid lengths", () => {
      expect(isValidVoiceId("a1b2c3d4e5")).toBe(true); // 10 chars (min)
      expect(isValidVoiceId("a".repeat(40))).toBe(true); // 40 chars (max)
    });

    it("should reject too short voice IDs", () => {
      expect(isValidVoiceId("")).toBe(false);
      expect(isValidVoiceId("abc")).toBe(false);
      expect(isValidVoiceId("123456789")).toBe(false); // 9 chars
    });

    it("should reject too long voice IDs", () => {
      expect(isValidVoiceId("a".repeat(41))).toBe(false);
      expect(isValidVoiceId("a".repeat(100))).toBe(false);
    });

    it("should reject voice IDs with invalid characters", () => {
      expect(isValidVoiceId("pMsXgVXv3BLz-gSXRplE")).toBe(false); // hyphen
      expect(isValidVoiceId("pMsXgVXv3BLz_gSXRplE")).toBe(false); // underscore
      expect(isValidVoiceId("pMsXgVXv3BLz gSXRplE")).toBe(false); // space
      expect(isValidVoiceId("../../../etc/passwd")).toBe(false); // path traversal
      expect(isValidVoiceId("voice?param=value")).toBe(false); // query string
    });
  });

  describe("isValidOpenAIVoice", () => {
    it("should accept all valid OpenAI voices", () => {
      const validVoices = ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"];
      for (const voice of validVoices) {
        expect(isValidOpenAIVoice(voice)).toBe(true);
      }
    });

    it("should reject invalid voice names", () => {
      expect(isValidOpenAIVoice("invalid")).toBe(false);
      expect(isValidOpenAIVoice("")).toBe(false);
      expect(isValidOpenAIVoice("ALLOY")).toBe(false); // case sensitive
      expect(isValidOpenAIVoice("alloy ")).toBe(false); // trailing space
      expect(isValidOpenAIVoice(" alloy")).toBe(false); // leading space
    });
  });

  describe("isValidOpenAIModel", () => {
    it("should accept gpt-4o-mini-tts model", () => {
      expect(isValidOpenAIModel("gpt-4o-mini-tts")).toBe(true);
    });

    it("should reject other models", () => {
      expect(isValidOpenAIModel("tts-1")).toBe(false);
      expect(isValidOpenAIModel("tts-1-hd")).toBe(false);
      expect(isValidOpenAIModel("invalid")).toBe(false);
      expect(isValidOpenAIModel("")).toBe(false);
      expect(isValidOpenAIModel("gpt-4")).toBe(false);
    });
  });

  describe("OPENAI_TTS_MODELS", () => {
    it("should contain only gpt-4o-mini-tts", () => {
      expect(OPENAI_TTS_MODELS).toContain("gpt-4o-mini-tts");
      expect(OPENAI_TTS_MODELS).toHaveLength(1);
    });

    it("should be a non-empty array", () => {
      expect(Array.isArray(OPENAI_TTS_MODELS)).toBe(true);
      expect(OPENAI_TTS_MODELS.length).toBeGreaterThan(0);
    });
  });

  describe("summarizeText", () => {
    const mockApiKey = "test-api-key";
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    });

    it("should summarize text and return result with metrics", async () => {
      const mockSummary = "This is a summarized version of the text.";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: mockSummary } }],
        }),
      });

      const longText = "A".repeat(2000); // Text longer than default limit
      const result = await summarizeText(longText, 1500, mockApiKey);

      expect(result.summary).toBe(mockSummary);
      expect(result.inputLength).toBe(2000);
      expect(result.outputLength).toBe(mockSummary.length);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("should call OpenAI API with correct parameters", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: "Summary" } }],
        }),
      });

      await summarizeText("Long text to summarize", 500, mockApiKey);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: `Bearer ${mockApiKey}`,
            "Content-Type": "application/json",
          },
        })
      );

      const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.temperature).toBe(0.3);
      expect(body.max_tokens).toBe(250); // Math.ceil(500 / 2)
    });

    it("should reject targetLength below minimum (100)", async () => {
      await expect(summarizeText("text", 99, mockApiKey)).rejects.toThrow(
        "Invalid targetLength: 99"
      );
    });

    it("should reject targetLength above maximum (10000)", async () => {
      await expect(summarizeText("text", 10001, mockApiKey)).rejects.toThrow(
        "Invalid targetLength: 10001"
      );
    });

    it("should accept targetLength at boundaries", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: "Summary" } }],
        }),
      });

      // Min boundary
      await expect(summarizeText("text", 100, mockApiKey)).resolves.toBeDefined();
      // Max boundary
      await expect(summarizeText("text", 10000, mockApiKey)).resolves.toBeDefined();
    });

    it("should throw error when API returns non-ok response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(summarizeText("text", 500, mockApiKey)).rejects.toThrow(
        "Summarization service unavailable"
      );
    });

    it("should throw error when no summary is returned", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [],
        }),
      });

      await expect(summarizeText("text", 500, mockApiKey)).rejects.toThrow(
        "No summary returned"
      );
    });

    it("should throw error when summary content is empty", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: "   " } }], // whitespace only
        }),
      });

      await expect(summarizeText("text", 500, mockApiKey)).rejects.toThrow(
        "No summary returned"
      );
    });
  });
});
