import { describe, expect, it } from "vitest";
import {
  pcmToWav,
  stripAmrHeader,
  isVoiceAttachment,
  isAudioFile,
  shouldTranscodeVoice,
  parseWavFallback,
} from "./audio.js";

describe("engine/utils/audio", () => {
  describe("pcmToWav", () => {
    it("produces a valid WAV header", () => {
      const pcm = new Uint8Array([0, 0, 1, 0]);
      const wav = pcmToWav(pcm, 24000);

      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
      expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
      expect(wav.toString("ascii", 36, 40)).toBe("data");
    });

    it("sets correct file size in RIFF header", () => {
      const pcm = new Uint8Array(100);
      const wav = pcmToWav(pcm, 24000);
      const riffSize = wav.readUInt32LE(4);
      expect(riffSize).toBe(wav.length - 8);
    });

    it("sets correct sample rate", () => {
      const pcm = new Uint8Array(10);
      const wav = pcmToWav(pcm, 48000);
      expect(wav.readUInt32LE(24)).toBe(48000);
    });

    it("sets correct channel count", () => {
      const pcm = new Uint8Array(10);
      const wav = pcmToWav(pcm, 24000, 2);
      expect(wav.readUInt16LE(22)).toBe(2);
    });

    it("embeds PCM data after the 44-byte header", () => {
      const pcm = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      const wav = pcmToWav(pcm, 24000);
      expect(wav[44]).toBe(0x01);
      expect(wav[45]).toBe(0x02);
      expect(wav[46]).toBe(0x03);
      expect(wav[47]).toBe(0x04);
    });

    it("sets data chunk size matching PCM length", () => {
      const pcm = new Uint8Array(256);
      const wav = pcmToWav(pcm, 24000);
      const dataSize = wav.readUInt32LE(40);
      expect(dataSize).toBe(256);
    });
  });

  describe("stripAmrHeader", () => {
    it("strips the #!AMR header when present", () => {
      const amrHeader = Buffer.from("#!AMR\n");
      const payload = Buffer.from([0x01, 0x02, 0x03]);
      const buf = Buffer.concat([amrHeader, payload]);

      const result = stripAmrHeader(buf);
      expect(result).toEqual(payload);
    });

    it("returns the buffer unchanged when no AMR header", () => {
      const buf = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const result = stripAmrHeader(buf);
      expect(result).toBe(buf);
    });

    it("returns the buffer unchanged when too short", () => {
      const buf = Buffer.from([0x01, 0x02]);
      const result = stripAmrHeader(buf);
      expect(result).toBe(buf);
    });
  });

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

  describe("parseWavFallback", () => {
    function buildMinimalWav(pcmData: Buffer, sampleRate = 24000, channels = 1): Buffer {
      const bitsPerSample = 16;
      const byteRate = sampleRate * channels * (bitsPerSample / 8);
      const blockAlign = channels * (bitsPerSample / 8);
      const dataSize = pcmData.length;
      const buf = Buffer.alloc(44 + dataSize);

      buf.write("RIFF", 0);
      buf.writeUInt32LE(36 + dataSize, 4);
      buf.write("WAVE", 8);
      buf.write("fmt ", 12);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(1, 20);
      buf.writeUInt16LE(channels, 22);
      buf.writeUInt32LE(sampleRate, 24);
      buf.writeUInt32LE(byteRate, 28);
      buf.writeUInt16LE(blockAlign, 32);
      buf.writeUInt16LE(bitsPerSample, 34);
      buf.write("data", 36);
      buf.writeUInt32LE(dataSize, 40);
      pcmData.copy(buf, 44);
      return buf;
    }

    it("extracts PCM from a valid mono 24kHz WAV", () => {
      const pcm = Buffer.from([0x01, 0x00, 0x02, 0x00]);
      const wav = buildMinimalWav(pcm, 24000, 1);
      const result = parseWavFallback(wav);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(4);
      expect(result![0]).toBe(0x01);
      expect(result![1]).toBe(0x00);
    });

    it("returns null for buffers shorter than 44 bytes", () => {
      expect(parseWavFallback(Buffer.alloc(20))).toBeNull();
    });

    it("returns null for non-WAV data", () => {
      const buf = Buffer.alloc(44);
      buf.write("NOT_", 0);
      expect(parseWavFallback(buf)).toBeNull();
    });

    it("returns null for non-PCM audio formats", () => {
      const wav = buildMinimalWav(Buffer.alloc(4), 24000, 1);
      wav.writeUInt16LE(3, 20); // IEEE float instead of PCM
      expect(parseWavFallback(wav)).toBeNull();
    });

    it("downmixes stereo to mono", () => {
      // 2 samples × 2 channels × 2 bytes = 8 bytes
      const stereoPcm = Buffer.alloc(8);
      const view = new DataView(stereoPcm.buffer);
      view.setInt16(0, 100, true); // L sample 0
      view.setInt16(2, 200, true); // R sample 0
      view.setInt16(4, -100, true); // L sample 1
      view.setInt16(6, -200, true); // R sample 1

      const wav = buildMinimalWav(stereoPcm, 24000, 2);
      const result = parseWavFallback(wav);
      expect(result).not.toBeNull();
      // mono output: 2 samples × 2 bytes = 4 bytes
      expect(result!.length).toBe(4);
      const outView = new DataView(result!.buffer, result!.byteOffset);
      expect(outView.getInt16(0, true)).toBe(150); // (100+200)/2
      expect(outView.getInt16(2, true)).toBe(-150); // (-100+-200)/2
    });

    it("resamples non-24kHz WAV to 24kHz", () => {
      // 4 samples at 48kHz → should produce ~2 samples at 24kHz
      const pcm48k = Buffer.alloc(8);
      const wav = buildMinimalWav(pcm48k, 48000, 1);
      const result = parseWavFallback(wav);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(4); // 2 samples × 2 bytes
    });
  });
});
