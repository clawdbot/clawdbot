import { describe, expect, it } from "vitest";
import { extractInboundMedia } from "./zalo-js.js";

describe("extractInboundMedia", () => {
  it("returns null for plain string content (text message)", () => {
    expect(extractInboundMedia("hello world")).toBeNull();
  });

  it("returns null for null / undefined / non-object content", () => {
    expect(extractInboundMedia(null)).toBeNull();
    expect(extractInboundMedia(undefined)).toBeNull();
    expect(extractInboundMedia(42)).toBeNull();
  });

  it("returns null for object content with no href (e.g. sticker)", () => {
    expect(extractInboundMedia({ type: "sticker", id: 123 })).toBeNull();
  });

  it("returns null for object content with href but no image markers (link preview)", () => {
    // Link preview from zca-js: type "link" + href to a webpage with no
    // thumb, no image extension. Should not be misclassified as a photo.
    expect(
      extractInboundMedia({
        type: "link",
        title: "Tingee",
        description: "Loa Tingee",
        href: "https://tingee.vn/products",
      }),
    ).toBeNull();
  });

  it("extracts media when content.type === \"photo\"", () => {
    const result = extractInboundMedia({
      type: "photo",
      href: "https://photo-stal-1.zdn.vn/abc/def.jpg",
      thumb: "https://photo-stal-1.zdn.vn/abc/def.thumb.jpg",
      width: 1024,
      height: 768,
    });
    expect(result).toEqual({
      kind: "image",
      url: "https://photo-stal-1.zdn.vn/abc/def.jpg",
      thumbUrl: "https://photo-stal-1.zdn.vn/abc/def.thumb.jpg",
    });
  });

  it("extracts media via image file extension fallback", () => {
    // Some clients omit `type` for photos; rely on URL extension.
    const result = extractInboundMedia({
      href: "https://example.com/path/photo.PNG",
    });
    expect(result).toEqual({
      kind: "image",
      url: "https://example.com/path/photo.PNG",
      thumbUrl: undefined,
    });
  });

  it("extracts media via thumb-presence fallback when type + extension absent", () => {
    // Some message shapes carry only `thumb` without explicit type; treat as photo.
    const result = extractInboundMedia({
      href: "https://photo-stal-7.zdn.vn/some/random/path",
      thumb: "https://photo-stal-7.zdn.vn/some/random/thumb",
    });
    expect(result).toEqual({
      kind: "image",
      url: "https://photo-stal-7.zdn.vn/some/random/path",
      thumbUrl: "https://photo-stal-7.zdn.vn/some/random/thumb",
    });
  });

  it("trims whitespace in href + thumb so URL builders downstream don't fail", () => {
    const result = extractInboundMedia({
      type: "photo",
      href: "   https://x/y.jpg   ",
      thumb: "  https://x/y-thumb.jpg  ",
    });
    expect(result?.url).toBe("https://x/y.jpg");
    expect(result?.thumbUrl).toBe("https://x/y-thumb.jpg");
  });

  it("matches common image extensions case-insensitively + with query strings", () => {
    for (const url of [
      "https://x/y.JPG?token=abc",
      "https://x/y.jpeg",
      "https://x/y.png",
      "https://x/y.gif?v=1",
      "https://x/y.webp",
      "https://x/y.bmp",
    ]) {
      const result = extractInboundMedia({ href: url });
      expect(result, `should match: ${url}`).not.toBeNull();
      expect(result?.url).toBe(url);
    }
  });

  it("does not match non-image href without other photo markers", () => {
    expect(extractInboundMedia({ href: "https://example.com/document.pdf" })).toBeNull();
    expect(extractInboundMedia({ href: "https://example.com/audio.mp3" })).toBeNull();
  });
});
