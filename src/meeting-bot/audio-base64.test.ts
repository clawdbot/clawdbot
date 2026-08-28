import { describe, expect, it } from "vitest";
import { decodeMeetingAudioBase64, isMeetingAudioBase64 } from "./audio-base64.js";

describe("meeting audio base64", () => {
  it("canonicalizes valid audio and rejects malformed payloads", () => {
    expect(decodeMeetingAudioBase64(" YXVkaW8 \n", "pullAudio").toString()).toBe("audio");
    expect(isMeetingAudioBase64("not-base64!")).toBe(false);
    expect(() => decodeMeetingAudioBase64("not-base64!", "pushAudio")).toThrow(
      "pushAudio base64 must be a valid audio payload",
    );
  });
});
