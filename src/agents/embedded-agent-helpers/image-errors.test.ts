import { describe, expect, it } from "vitest";
import { parseImageDimensionError, parseImageSizeError } from "./image-errors.js";

describe("parseImageSizeError", () => {
  it("parses max MB values from error text", () => {
    expect(parseImageSizeError("image exceeds 5 MB maximum")?.maxMb).toBe(5);
    expect(parseImageSizeError("Image exceeds 5.5 MB limit")?.maxMb).toBe(5.5);
  });

  it("returns null for unrelated errors", () => {
    expect(parseImageSizeError("context overflow")).toBeNull();
  });
});

describe("image dimension errors", () => {
  it("parses anthropic image dimension errors", () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}';
    const parsed = parseImageDimensionError(raw);
    expect(parsed).toEqual({
      maxDimensionPx: 2000,
      messageIndex: 84,
      contentIndex: 1,
      raw,
    });
  });
});
