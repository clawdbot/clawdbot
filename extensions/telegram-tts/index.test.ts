/**
 * Unit tests for telegram-tts extension
 */

import { describe, expect, it } from "vitest";
import { _test, meta } from "./index.js";

const { isValidVoiceId, isValidOpenAIVoice, isValidOpenAIModel, OPENAI_TTS_MODELS } = _test;

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
    it("should accept standard OpenAI TTS models", () => {
      expect(isValidOpenAIModel("gpt-4o-mini-tts")).toBe(true);
      expect(isValidOpenAIModel("tts-1")).toBe(true);
      expect(isValidOpenAIModel("tts-1-hd")).toBe(true);
    });

    it("should accept gpt-4o-mini-tts variants", () => {
      expect(isValidOpenAIModel("gpt-4o-mini-tts-2025-12-15")).toBe(true);
      expect(isValidOpenAIModel("gpt-4o-mini-tts-preview")).toBe(true);
    });

    it("should reject invalid model names", () => {
      expect(isValidOpenAIModel("invalid")).toBe(false);
      expect(isValidOpenAIModel("")).toBe(false);
      expect(isValidOpenAIModel("tts-2")).toBe(false);
      expect(isValidOpenAIModel("gpt-4")).toBe(false);
    });
  });

  describe("OPENAI_TTS_MODELS", () => {
    it("should contain the expected models", () => {
      expect(OPENAI_TTS_MODELS).toContain("gpt-4o-mini-tts");
      expect(OPENAI_TTS_MODELS).toContain("tts-1");
      expect(OPENAI_TTS_MODELS).toContain("tts-1-hd");
    });

    it("should be a non-empty array", () => {
      expect(Array.isArray(OPENAI_TTS_MODELS)).toBe(true);
      expect(OPENAI_TTS_MODELS.length).toBeGreaterThan(0);
    });
  });
});
