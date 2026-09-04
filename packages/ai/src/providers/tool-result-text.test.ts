import { describe, expect, it } from "vitest";
import {
  describeToolResultMediaPlaceholder,
  describeUnsupportedToolResultMedia,
  extractToolResultText,
  formatToolResultText,
  hasMediaPayload,
  isImageWithMediaPayload,
} from "./tool-result-text.js";

describe("formatToolResultText", () => {
  it("preserves significant boundary whitespace in nonblank tool output", () => {
    expect(formatToolResultText({ text: "  indented\n", isError: false })).toBe("  indented\n");
    expect(formatToolResultText({ text: "row1   \nrow2\n", isError: false })).toBe(
      "row1   \nrow2\n",
    );
  });

  it("falls back to placeholders only for blank tool output", () => {
    expect(formatToolResultText({ text: "   \n\t", isError: false })).toBe("(no tool output)");
    expect(
      formatToolResultText({ text: "", mediaPlaceholder: "(see attached image)", isError: false }),
    ).toBe("(see attached image)");
  });

  it("keeps the error prefix on unmodified output", () => {
    expect(formatToolResultText({ text: "  failed  ", isError: true })).toBe(
      "[tool error]   failed  ",
    );
  });

  it("appends the omitted-media suffix after unmodified output", () => {
    const text = "line with trailing spaces   ";
    expect(
      formatToolResultText({
        text,
        omittedMediaPlaceholder: "[tool image omitted]",
        isError: false,
      }),
    ).toBe(`${text}\n[tool image omitted]`);
  });
});

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
  it.each([
    { blocks: ["A\ud800", "\udc00B"], expected: "A\nB" },
    { blocks: ["😀\ud800x\udc00漢"], expected: "😀x漢" },
    { blocks: ["\ud800", "\udc00"], expected: "" },
    { blocks: ["  before\n", "after  "], expected: "  before\n\nafter  " },
  ])("sanitizes separate text blocks before joining: $blocks", ({ blocks, expected }) => {
    expect(extractToolResultText(blocks.map((text) => ({ type: "text", text })))).toBe(expected);
  });

  it("keeps structured fallback and inclusion after block sanitation", () => {
    const structured = { type: "json", value: "😀漢" };
    const expected = '{"type":"json","value":"😀漢"}';
    expect(extractToolResultText([{ type: "text", text: "\ud800" }, structured])).toBe(expected);
    expect(
      extractToolResultText([{ type: "text", text: "head\ud800" }, structured], {
        includeStructured: true,
      }),
    ).toBe(`head\n${expected}`);
  });

  it.each([
    { text: "x".repeat(8_000), expected: "x".repeat(8_000) },
    { text: `${"x".repeat(7_999)}😀`, expected: `${"x".repeat(7_999)}\n…(truncated)…` },
    { text: `${"x".repeat(8_000)}😀`, expected: `${"x".repeat(8_000)}\n…(truncated)…` },
  ])("preserves UTF-16 at the included-text cap: $#", ({ text, expected }) => {
    const blocks = [{ type: "text", text }];
    expect(extractToolResultText(blocks, { includeStructured: true })).toBe(expected);
    expect(extractToolResultText(blocks)).toBe(text);
  });

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
    const husks = [
      { type: "image", mimeType: "image/png", data: "" },
      { type: "image", path: "/tmp/image.png" },
      { type: "audio", mimeType: "audio/mpeg" },
      { type: "text", text: "ordinary text", mimeType: "image/png" },
    ];
    expect(describeToolResultMediaPlaceholder(husks)).toBeUndefined();
    expect(
      describeUnsupportedToolResultMedia(husks, { images: true, audio: false }),
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
