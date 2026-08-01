import { describe, expect, it } from "vitest";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
  hasMediaPayload,
  isImageWithMediaPayload,
} from "./tool-result-text.js";

describe("hasMediaPayload", () => {
  it("requires non-empty inline data instead of media metadata", () => {
    expect(hasMediaPayload({ type: "image", data: "aW1n", mimeType: "image/png" })).toBe(true);
    expect(hasMediaPayload({ type: "audio", data: "YXVkaW8=", mimeType: "audio/mpeg" })).toBe(true);
    expect(hasMediaPayload({ type: "image", data: "", mimeType: "image/png" })).toBe(false);
    expect(hasMediaPayload({ type: "image", data: "  ", mimeType: "image/png" })).toBe(false);
    expect(hasMediaPayload({ type: "image", path: "/tmp/image.png" })).toBe(false);
    expect(hasMediaPayload({ type: "image", url: "https://example.test/image.png" })).toBe(false);
  });
});

describe("isImageWithMediaPayload", () => {
  it("requires both the image type and inline payload bytes", () => {
    expect(isImageWithMediaPayload({ type: "image", data: "aW1n", mimeType: "image/png" })).toBe(
      true,
    );
    expect(isImageWithMediaPayload({ type: "image", data: "", mimeType: "image/png" })).toBe(false);
    expect(
      isImageWithMediaPayload({ type: "audio", data: "YXVkaW8=", mimeType: "audio/mpeg" }),
    ).toBe(false);
  });
});

describe("extractToolResultText", () => {
  it("keeps media-only blocks out of provider replay text", () => {
    const text = extractToolResultText([
      { type: "text", text: "summary" },
      { type: "image", data: "image-binary", mimeType: "image/png" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
      { type: "input_image", image_url: "data:image/png;base64,def456" },
      { type: "audio", data: "audio-binary", mimeType: "audio/mpeg" },
    ]);

    expect(text).toBe("summary");
    expect(text).not.toContain("image-binary");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("def456");
    expect(text).not.toContain("audio-binary");
  });

  it("omits MIME-tagged binary data while preserving textual resource data", () => {
    const text = extractToolResultText([
      { type: "resource", mime_type: "application/octet-stream", data: "AAECAwQFBgc=" },
      { type: "resource", mediaType: "application/json", data: '{"ok":true}' },
    ]);

    expect(text).toContain('"data":"[binary data omitted: 12 chars]"');
    expect(text).toContain('{\\"ok\\":true}');
    expect(text).not.toContain("AAECAwQFBgc=");
  });

  it("redacts inline data URIs without touching ordinary data-colon prose", () => {
    const text = extractToolResultText([
      {
        type: "json",
        value: {
          note: "metadata:ready",
          prose: "data: is ordinary prose",
          preview: "thumbnail=data:image/png;base64,abcdef done",
        },
      },
    ]);

    expect(text).toContain("metadata:ready");
    expect(text).toContain("data: is ordinary prose");
    expect(text).toContain("[inline data URI:");
    expect(text).not.toContain("abcdef");
  });

  it("omits opaque or binary structured fields", () => {
    const text = extractToolResultText([
      {
        type: "json",
        encrypted_content: "ciphertext",
        bytes: [1, 2, 3],
        visible: "safe-value",
      },
    ]);

    expect(text).toContain('"encrypted_content":"[omitted encrypted_content]"');
    expect(text).toContain('"bytes":"[omitted bytes]"');
    expect(text).toContain('"visible":"safe-value"');
    expect(text).not.toContain("ciphertext");
  });

  it("uses structured replay only as a no-text fallback without capping explicit text", () => {
    const textTail = "explicit-tail-marker";
    const text = extractToolResultText([
      { type: "text", text: `${"x".repeat(8_200)}${textTail}` },
      { type: "json", internal: "extra structured detail" },
    ]);

    expect(text).toContain(textTail);
    expect(text).not.toContain("…(truncated)…");
    expect(text).not.toContain("extra structured detail");
  });

  it("truncates structured fallback text before provider replay", () => {
    const tail = "tail-marker";
    const text = extractToolResultText([
      {
        type: "json",
        data: {
          payload: `${"x".repeat(8_200)}${tail}`,
        },
      },
    ]);

    expect(text.length).toBeLessThan(8_100);
    expect(text).toContain("…(truncated)…");
    expect(text).not.toContain(tail);
  });
});

describe("describeToolResultMediaPlaceholder", () => {
  it("describes image-only tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([{ type: "image", mimeType: "image/png", data: "img" }]),
    ).toBe("(see attached image)");
  });

  it("describes audio-only tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "audio", mimeType: "audio/mpeg", data: "audio" },
      ]),
    ).toBe("(see attached audio)");
  });

  it("describes mixed image and audio tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "image", mimeType: "image/png", data: "img" },
        { type: "audio", mimeType: "audio/mpeg", data: "audio" },
      ]),
    ).toBe("(see attached media)");
  });

  it("does not advertise payload-less media husks", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "image", mimeType: "image/png", data: "" },
        { type: "image", path: "/tmp/image.png" },
        { type: "audio", mimeType: "audio/mpeg" },
      ]),
    ).toBeUndefined();
  });

  it("does not treat text MIME metadata as attached media", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "text", text: "actual tool output", mimeType: "image/svg+xml" },
      ]),
    ).toBeUndefined();
  });
});
