// Media Core tests cover inline image data url behavior.
import { describe, expect, it } from "vitest";
import {
  sanitizeInlineImageBase64,
  sanitizeInlineImageDataUrl,
  sanitizeInlineImageDataUrlForStorage,
  sniffInlineImageMime,
} from "./inline-image-data-url.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
const BMP_HEADER = Buffer.from("BMfixture", "ascii").toString("base64");
const HEIC_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x69, 0x66, 0x31,
]).toString("base64");
const HEIF_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00,
]).toString("base64");

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

  it("canonicalizes valid unpadded image data URLs", () => {
    const unpaddedPng = PNG_1X1.replace(/=+$/u, "");
    expect(sanitizeInlineImageDataUrl(`data:image/png;base64,${unpaddedPng}`)).toBe(
      `data:image/png;base64,${PNG_1X1}`,
    );
  });

  it("rejects image data URLs for formats that require conversion before provider transport", () => {
    expect(sanitizeInlineImageDataUrl(`data:image/bmp;base64,${BMP_HEADER}`)).toBeUndefined();
    expect(sanitizeInlineImageDataUrl(`data:image/heic;base64,${HEIC_HEADER}`)).toBeUndefined();
    expect(sanitizeInlineImageDataUrl(`data:image/heif;base64,${HEIF_HEADER}`)).toBeUndefined();
  });

  it("canonicalizes valid image data URLs for storage without transport allowlist filtering", () => {
    expect(sanitizeInlineImageDataUrlForStorage(`data:image/bmp;base64,${BMP_HEADER}`)).toBe(
      `data:image/bmp;base64,${BMP_HEADER}`,
    );
    expect(sanitizeInlineImageDataUrlForStorage(`data:image/heic;base64,${HEIC_HEADER}`)).toBe(
      `data:image/heic;base64,${HEIC_HEADER}`,
    );
  });

  it("canonicalizes valid image base64 with sniffed MIME type", () => {
    expect(sanitizeInlineImageBase64({ mimeType: "image/jpeg", base64: `\n${PNG_1X1}` })).toEqual({
      mimeType: "image/png",
      base64: PNG_1X1,
    });
    expect(
      sanitizeInlineImageBase64({ mimeType: "image/png", base64: "SGVsbG8=" }),
    ).toBeUndefined();
  });

  it("accepts supported non-browser image signatures", () => {
    expect(sanitizeInlineImageBase64({ mimeType: "image/bmp", base64: BMP_HEADER })).toEqual({
      mimeType: "image/bmp",
      base64: BMP_HEADER,
    });
    expect(sanitizeInlineImageBase64({ mimeType: "image/heic", base64: HEIC_HEADER })).toEqual({
      mimeType: "image/heic",
      base64: HEIC_HEADER,
    });
    expect(sanitizeInlineImageBase64({ mimeType: "image/heif", base64: HEIF_HEADER })).toEqual({
      mimeType: "image/heif",
      base64: HEIF_HEADER,
    });
  });

  it("sniffs supported inline image signatures", () => {
    expect(sniffInlineImageMime(Buffer.from("GIF89a", "ascii"))).toBe("image/gif");
    expect(sniffInlineImageMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
  });
});
