import { describe, expect, it } from "vitest";
import {
  isVoiceCompatibleAudio,
  VOICE_MESSAGE_AUDIO_EXTENSIONS,
  VOICE_MESSAGE_MIME_TYPES,
} from "./audio.js";

describe("isVoiceCompatibleAudio", () => {
  function expectVoiceCompatibilityCase(
    opts: Parameters<typeof isVoiceCompatibleAudio>[0],
    expected: boolean,
  ) {
    expect(isVoiceCompatibleAudio(opts)).toBe(expected);
  }

  function expectVoiceCompatibilityCases(
    cases: ReadonlyArray<{
      opts: Parameters<typeof isVoiceCompatibleAudio>[0];
      expected: boolean;
    }>,
  ) {
    cases.forEach(({ opts, expected }) => {
      expectVoiceCompatibilityCase(opts, expected);
    });
  }

  it.each([
    {
      name: "returns true for supported MIME types",
      cases: [
        ...Array.from(VOICE_MESSAGE_MIME_TYPES, (contentType) => ({
          opts: { contentType, fileName: null },
          expected: true,
        })),
        { opts: { contentType: "audio/ogg; codecs=opus", fileName: null }, expected: true },
        { opts: { contentType: "audio/mp4; codecs=mp4a.40.2", fileName: null }, expected: true },
      ],
    },
    {
      name: "returns true for supported extensions",
      cases: Array.from(VOICE_MESSAGE_AUDIO_EXTENSIONS, (ext) => ({
        opts: { fileName: `voice${ext}` },
        expected: true,
      })),
    },
    {
      name: "returns false for unsupported MIME types",
      cases: [
        { opts: { contentType: "audio/wav", fileName: null }, expected: false },
        { opts: { contentType: "audio/flac", fileName: null }, expected: false },
        { opts: { contentType: "audio/aac", fileName: null }, expected: false },
        { opts: { contentType: "video/mp4", fileName: null }, expected: false },
      ],
    },
    {
      name: "returns false for unsupported extensions",
      cases: [".wav", ".flac", ".webm"].map((ext) => ({
        opts: { fileName: `audio${ext}` },
        expected: false,
      })),
    },
    {
      name: "keeps fallback edge cases explicit",
      cases: [
        {
          opts: {},
          expected: false,
        },
        {
          opts: { contentType: "audio/mpeg", fileName: "file.wav" },
          expected: true,
        },
      ],
    },
  ])("$name", ({ cases }) => {
    expectVoiceCompatibilityCases(cases);
  });
});
