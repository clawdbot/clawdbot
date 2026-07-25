// Qqbot tests cover audio plugin behavior.
import { describe, expect, it } from "vitest";
import { isVoiceAttachment, isAudioFile, shouldTranscodeVoice } from "./audio.js";

describe("engine/utils/audio", () => {
  describe("isVoiceAttachment", () => {
    it("detects voice content_type", () => {
      expect(isVoiceAttachment({ content_type: "voice" })).toBe(true);
    });

    it("detects audio/* content_type", () => {
      expect(isVoiceAttachment({ content_type: "audio/silk" })).toBe(true);
      expect(isVoiceAttachment({ content_type: "audio/amr" })).toBe(true);
    });

    it("detects voice file extensions", () => {
      expect(isVoiceAttachment({ filename: "msg.amr" })).toBe(true);
      expect(isVoiceAttachment({ filename: "msg.silk" })).toBe(true);
      expect(isVoiceAttachment({ filename: "msg.slk" })).toBe(true);
      expect(isVoiceAttachment({ filename: "msg.slac" })).toBe(true);
    });

    it("treats content_type case-insensitively", () => {
      expect(isVoiceAttachment({ content_type: "Voice" })).toBe(true);
      expect(isVoiceAttachment({ content_type: "Audio/Silk" })).toBe(true);
      expect(isVoiceAttachment({ content_type: "Image/PNG" })).toBe(false);
    });

    it("rejects non-voice attachments", () => {
      expect(isVoiceAttachment({ content_type: "image/png" })).toBe(false);
      expect(isVoiceAttachment({ filename: "photo.jpg" })).toBe(false);
    });

    it("handles missing fields", () => {
      expect(isVoiceAttachment({})).toBe(false);
    });
  });

  describe("isAudioFile", () => {
    it.each([
      ".silk",
      ".slk",
      ".amr",
      ".wav",
      ".mp3",
      ".ogg",
      ".opus",
      ".aac",
      ".flac",
      ".m4a",
      ".wma",
      ".pcm",
    ])("recognizes %s as audio", (ext) => {
      expect(isAudioFile(`file${ext}`)).toBe(true);
    });

    it("recognizes audio MIME types", () => {
      expect(isAudioFile("file.bin", "audio/mpeg")).toBe(true);
      expect(isAudioFile("file.bin", "voice")).toBe(true);
    });

    it("rejects non-audio files", () => {
      expect(isAudioFile("photo.jpg")).toBe(false);
      expect(isAudioFile("doc.pdf")).toBe(false);
    });

    it("is case-insensitive on extensions", () => {
      expect(isAudioFile("file.MP3")).toBe(true);
      expect(isAudioFile("file.Wav")).toBe(true);
    });
  });

  describe("shouldTranscodeVoice", () => {
    it("returns false for QQ native MIME types", () => {
      expect(shouldTranscodeVoice("file.bin", "audio/silk")).toBe(false);
      expect(shouldTranscodeVoice("file.bin", "audio/amr")).toBe(false);
      expect(shouldTranscodeVoice("file.bin", "audio/wav")).toBe(false);
      expect(shouldTranscodeVoice("file.bin", "audio/mp3")).toBe(false);
    });

    it("returns false for QQ native extensions", () => {
      expect(shouldTranscodeVoice("voice.silk")).toBe(false);
      expect(shouldTranscodeVoice("voice.amr")).toBe(false);
      expect(shouldTranscodeVoice("voice.wav")).toBe(false);
      expect(shouldTranscodeVoice("voice.mp3")).toBe(false);
    });

    it("returns true for non-native audio formats", () => {
      expect(shouldTranscodeVoice("voice.ogg")).toBe(true);
      expect(shouldTranscodeVoice("voice.opus")).toBe(true);
      expect(shouldTranscodeVoice("voice.flac")).toBe(true);
      expect(shouldTranscodeVoice("voice.aac")).toBe(true);
    });

    it("returns false for non-audio files", () => {
      expect(shouldTranscodeVoice("photo.jpg")).toBe(false);
      expect(shouldTranscodeVoice("doc.txt")).toBe(false);
    });
  });
});
