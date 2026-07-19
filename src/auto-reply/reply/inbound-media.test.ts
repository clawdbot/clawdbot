import { describe, expect, it } from "vitest";
import { hasInboundAudio } from "./inbound-media.js";

describe("hasInboundAudio", () => {
  it("detects audio from the singular structured media type without a placeholder body", () => {
    expect(hasInboundAudio({ MediaType: " Audio/Ogg ; codecs=opus " })).toBe(true);
  });

  it("detects audio in aligned structured media types", () => {
    expect(hasInboundAudio({ MediaTypes: ["image/png", "audio/mpeg"] })).toBe(true);
  });

  it("accepts the structured audio kind when a MIME subtype is unavailable", () => {
    expect(hasInboundAudio({ MediaTypes: ["audio"] })).toBe(true);
  });

  it("does not infer audio from placeholder or transcript text", () => {
    expect(hasInboundAudio({ Body: "<media:audio>" })).toBe(false);
    expect(hasInboundAudio({ Body: "[Audio]\nTranscript:\nhello" })).toBe(false);
  });

  it("does not rederive audio from a media filename", () => {
    expect(hasInboundAudio({ MediaPath: "/tmp/voice.ogg" })).toBe(false);
  });

  it("does not treat non-audio media as audio", () => {
    expect(hasInboundAudio({ MediaType: "image/png", MediaTypes: ["video/mp4"] })).toBe(false);
  });
});
