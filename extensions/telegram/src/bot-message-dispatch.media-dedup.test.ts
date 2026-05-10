import { describe, expect, it } from "vitest";
import { deduplicateBlockSentMedia } from "./bot-message-dispatch.media-dedup.js";

describe("deduplicateBlockSentMedia", () => {
  it("returns payload unchanged when no media URLs", () => {
    const payload = { text: "hello", mediaUrls: [] };
    const sent = new Set(["/tmp/a.jpg"]);
    expect(deduplicateBlockSentMedia(payload, sent)).toBe(payload);
  });

  it("returns payload unchanged when sent set is empty", () => {
    const payload = { text: "hello", mediaUrls: ["/tmp/a.jpg"] };
    const sent = new Set<string>();
    expect(deduplicateBlockSentMedia(payload, sent)).toBe(payload);
  });

  it("returns payload unchanged when no overlap", () => {
    const payload = { text: "hello", mediaUrls: ["/tmp/a.jpg"] };
    const sent = new Set(["/tmp/other.jpg"]);
    expect(deduplicateBlockSentMedia(payload, sent)).toBe(payload);
  });

  it("filters out already-sent media URLs from final payload", () => {
    const payload = { text: "hello", mediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg"] };
    const sent = new Set(["/tmp/a.jpg"]);
    const result = deduplicateBlockSentMedia(payload, sent);
    expect(result).toEqual({ text: "hello", mediaUrls: ["/tmp/b.jpg"] });
  });

  it("returns undefined when all media already sent and no text", () => {
    const payload = { text: undefined, mediaUrls: ["/tmp/a.jpg"] };
    const sent = new Set(["/tmp/a.jpg"]);
    expect(deduplicateBlockSentMedia(payload, sent)).toBeUndefined();
  });

  it("returns payload with empty mediaUrls when all media already sent but text remains", () => {
    const payload = { text: "some text", mediaUrls: ["/tmp/a.jpg"] };
    const sent = new Set(["/tmp/a.jpg"]);
    const result = deduplicateBlockSentMedia(payload, sent);
    expect(result).toEqual({ text: "some text", mediaUrls: [] });
  });

  it("handles partial overlap with multiple URLs", () => {
    const payload = { text: "see attached", mediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"] };
    const sent = new Set(["/tmp/a.jpg", "/tmp/c.jpg"]);
    const result = deduplicateBlockSentMedia(payload, sent);
    expect(result).toEqual({ text: "see attached", mediaUrls: ["/tmp/b.jpg"] });
  });

  it("clears legacy mediaUrl when all mediaUrls removed but text remains", () => {
    const payload = { text: "captioned", mediaUrl: "/tmp/a.jpg", mediaUrls: ["/tmp/a.jpg"] };
    const sent = new Set(["/tmp/a.jpg"]);
    const result = deduplicateBlockSentMedia(payload, sent);
    expect(result).toEqual({ text: "captioned", mediaUrl: undefined, mediaUrls: [] });
  });

  it("preserves legacy mediaUrl when some mediaUrls remain", () => {
    const payload = {
      text: "hey",
      mediaUrl: "/tmp/a.jpg",
      mediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg"],
    };
    const sent = new Set(["/tmp/a.jpg"]);
    const result = deduplicateBlockSentMedia(payload, sent);
    expect(result).toEqual({ text: "hey", mediaUrl: "/tmp/a.jpg", mediaUrls: ["/tmp/b.jpg"] });
  });
});
