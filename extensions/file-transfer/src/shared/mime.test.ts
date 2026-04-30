import { describe, expect, it } from "vitest";
import {
  EXTENSION_MIME,
  IMAGE_MIME_INLINE_SET,
  TEXT_INLINE_MAX_BYTES,
  TEXT_INLINE_MIME_SET,
  mimeFromExtension,
} from "./mime.js";

describe("mimeFromExtension", () => {
  it("returns the mapped mime for known extensions", () => {
    expect(mimeFromExtension("foo.png")).toBe("image/png");
    expect(mimeFromExtension("/abs/path/bar.JPG")).toBe("image/jpeg");
    expect(mimeFromExtension("doc.pdf")).toBe("application/pdf");
    expect(mimeFromExtension("notes.md")).toBe("text/markdown");
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(mimeFromExtension("blob.xyz")).toBe("application/octet-stream");
    expect(mimeFromExtension("Makefile")).toBe("application/octet-stream");
  });

  it("is case-insensitive on the extension", () => {
    expect(mimeFromExtension("foo.PNG")).toBe("image/png");
    expect(mimeFromExtension("foo.WeBp")).toBe("image/webp");
  });
});

describe("MIME constants", () => {
  it("EXTENSION_MIME includes the v1 image set", () => {
    expect(EXTENSION_MIME[".png"]).toBe("image/png");
    expect(EXTENSION_MIME[".jpg"]).toBe("image/jpeg");
    expect(EXTENSION_MIME[".jpeg"]).toBe("image/jpeg");
    expect(EXTENSION_MIME[".webp"]).toBe("image/webp");
    expect(EXTENSION_MIME[".gif"]).toBe("image/gif");
  });

  it("IMAGE_MIME_INLINE_SET is the inline-renderable image set", () => {
    expect(IMAGE_MIME_INLINE_SET.has("image/png")).toBe(true);
    expect(IMAGE_MIME_INLINE_SET.has("image/jpeg")).toBe(true);
    expect(IMAGE_MIME_INLINE_SET.has("image/webp")).toBe(true);
    expect(IMAGE_MIME_INLINE_SET.has("image/gif")).toBe(true);
    // heic/heif intentionally excluded
    expect(IMAGE_MIME_INLINE_SET.has("image/heic")).toBe(false);
    expect(IMAGE_MIME_INLINE_SET.has("image/heif")).toBe(false);
  });

  it("TEXT_INLINE_MIME_SET covers small-text inlining types", () => {
    expect(TEXT_INLINE_MIME_SET.has("text/plain")).toBe(true);
    expect(TEXT_INLINE_MIME_SET.has("text/markdown")).toBe(true);
    expect(TEXT_INLINE_MIME_SET.has("application/json")).toBe(true);
    expect(TEXT_INLINE_MIME_SET.has("text/csv")).toBe(true);
  });

  it("TEXT_INLINE_MAX_BYTES is the documented 8KB cap", () => {
    expect(TEXT_INLINE_MAX_BYTES).toBe(8 * 1024);
  });
});
