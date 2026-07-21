import { describe, expect, it } from "vitest";
import {
  hasInboundAudio,
  hasInboundMedia,
  hasInboundMediaForUnderstanding,
} from "./inbound-media.js";

describe("hasInboundMedia", () => {
  it("detects retained type-only media facts", () => {
    expect(hasInboundMedia({ media: [{ kind: "sticker" }] })).toBe(true);
  });

  it("detects aligned type-only facts without a placeholder body", () => {
    expect(hasInboundMedia({ Body: "", MediaTypes: ["sticker", "image"] })).toBe(true);
  });

  it("ignores alignment-only blank projection slots", () => {
    expect(hasInboundMedia({ MediaPaths: [""] })).toBe(false);
    expect(hasInboundMedia({ MediaPath: "   " })).toBe(false);
    expect(hasInboundMedia({ MediaPaths: ["", "/tmp/real.png"] })).toBe(true);
  });
});

describe("hasInboundAudio", () => {
  it("detects native audio facts without legacy projections", () => {
    expect(hasInboundAudio({ media: [{ kind: "audio" }] })).toBe(true);
    expect(hasInboundAudio({ media: [{ contentType: "audio/ogg; codecs=opus" }] })).toBe(true);
  });

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

  it("keeps longer legacy URL/type arrays visible to understanding and audio gates", () => {
    const context = {
      SkipStickerMediaUnderstanding: true,
      MediaPaths: ["/tmp/photo.jpg"],
      MediaUrls: ["/tmp/photo.jpg", "https://example.test/voice.ogg"],
      MediaTypes: ["image/jpeg", "audio/ogg"],
    };
    expect(hasInboundMediaForUnderstanding(context)).toBe(true);
    expect(hasInboundAudio(context)).toBe(true);
  });
});
