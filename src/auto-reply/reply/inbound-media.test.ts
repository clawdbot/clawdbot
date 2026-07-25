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
    expect(hasInboundMedia({ Body: "", media: [{ kind: "sticker" }, { kind: "image" }] })).toBe(
      true,
    );
  });

  it("ignores blank facts", () => {
    expect(hasInboundMedia({ media: [{ path: "" }] })).toBe(false);
    expect(hasInboundMedia({ media: [{ path: "   " }] })).toBe(false);
    expect(hasInboundMedia({ media: [{}, { path: "/tmp/real.png" }] })).toBe(true);
  });
});

describe("hasInboundAudio", () => {
  it("detects native audio facts without legacy projections", () => {
    expect(hasInboundAudio({ media: [{ kind: "audio" }] })).toBe(true);
    expect(hasInboundAudio({ media: [{ contentType: "audio/ogg; codecs=opus" }] })).toBe(true);
  });

  it("detects audio from structured content type without a placeholder body", () => {
    expect(hasInboundAudio({ media: [{ contentType: " Audio/Ogg ; codecs=opus " }] })).toBe(true);
  });

  it("detects audio across ordered facts", () => {
    expect(
      hasInboundAudio({ media: [{ contentType: "image/png" }, { contentType: "audio/mpeg" }] }),
    ).toBe(true);
  });

  it("accepts the structured audio kind when a MIME subtype is unavailable", () => {
    expect(hasInboundAudio({ media: [{ kind: "audio" }] })).toBe(true);
  });

  it("does not infer audio from placeholder or transcript text", () => {
    expect(hasInboundAudio({ Body: "<media:audio>" })).toBe(false);
    expect(hasInboundAudio({ Body: "[Audio]\nTranscript:\nhello" })).toBe(false);
  });

  it("does not rederive audio from a media filename", () => {
    expect(hasInboundAudio({ media: [{ path: "/tmp/voice.ogg" }] })).toBe(false);
  });

  it("does not treat non-audio media as audio", () => {
    expect(
      hasInboundAudio({ media: [{ contentType: "image/png" }, { contentType: "video/mp4" }] }),
    ).toBe(false);
  });

  it("keeps every fact visible to understanding and audio gates", () => {
    const context = {
      SkipStickerMediaUnderstanding: true,
      media: [
        { path: "/tmp/photo.jpg", contentType: "image/jpeg" },
        { url: "https://example.test/voice.ogg", contentType: "audio/ogg" },
      ],
    };
    expect(hasInboundMediaForUnderstanding(context)).toBe(true);
    expect(hasInboundAudio(context)).toBe(true);
  });
});
