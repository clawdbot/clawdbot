// Media Core tests cover inline image data url behavior.
import { describe, expect, it } from "vitest";
import { sanitizeInlineImageDataUrl, sniffInlineImageMime } from "./inline-image-data-url.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

describe("inline image data URL sanitizer", () => {
  it("keeps non-data image references unchanged", () => {
    expect(sanitizeInlineImageDataUrl("https://example.test/image.png")).toBe(
      "https://example.test/image.png",
    );
  });

  it("rejects malformed and non-image data URLs", () => {
    expect(sanitizeInlineImageDataUrl("data:image/png;base64")).toBeUndefined();
    expect(sanitizeInlineImageDataUrl("data:text/plain;base64,SGVsbG8=")).toBeUndefined();
    expect(sanitizeInlineImageDataUrl("data:image/png,SGVsbG8=")).toBeUndefined();
    expect(sanitizeInlineImageDataUrl("data:image/png;base64,not base64!")).toBeUndefined();
    expect(sanitizeInlineImageDataUrl("data:image/png;base64,SGVsbG8=")).toBeUndefined();
  });

  it("canonicalizes valid data URLs with sniffed MIME type", () => {
    expect(sanitizeInlineImageDataUrl(`data:image/jpeg;base64,\n${PNG_1X1}`)).toBe(
      `data:image/png;base64,${PNG_1X1}`,
    );
  });

  it("sniffs supported inline image signatures", () => {
    expect(sniffInlineImageMime(Buffer.from("GIF89a", "ascii"))).toBe("image/gif");
    expect(sniffInlineImageMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
  });
});
