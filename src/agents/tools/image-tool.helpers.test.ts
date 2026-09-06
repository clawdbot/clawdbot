import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { describe, expect, it } from "vitest";
import { decodeDataUrl } from "./image-tool.helpers.js";

describe("decodeDataUrl", () => {
  it.each(["SGVsbG8=", "SGVsbG8", "\r\nSGVs\r\nbG8="])(
    "preserves supported base64 spelling %j",
    (payload) => {
      const result = decodeDataUrl(` DATA:IMAGE/PNG;BASE64,${payload}\n `);
      expect(result.mimeType).toBe("image/png");
      expect(result.buffer.toString()).toBe("Hello");
    },
  );

  it.each([
    "data:image/png;base64,",
    "data:image/png;base64\n,SGVsbG8=",
    "data:image/png;charset=utf-8;base64,SGVsbG8=",
    "data:image/png;base64,SGVs bG8=",
    "data:image/png;base64,SGVsbG8%3D",
    "data:image/png;base64,SGVsbG8=,",
  ])("rejects unsupported data URL syntax %j", (input) => {
    expect(() => decodeDataUrl(input)).toThrow("Invalid data URL (expected base64 data: URL).");
  });

  it.each([0, 1])("checks a canonical-size payload with %i extra bytes", (extraBytes) => {
    const bytes = MAX_IMAGE_BYTES + extraBytes;
    const input = `data:image/png;base64,${Buffer.alloc(bytes).toString("base64")}`;
    if (extraBytes) {
      expect(() => decodeDataUrl(input, { maxBytes: MAX_IMAGE_BYTES })).toThrow(
        "Invalid data URL: payload exceeds size limit.",
      );
    } else {
      expect(decodeDataUrl(input, { maxBytes: MAX_IMAGE_BYTES }).buffer.byteLength).toBe(bytes);
    }
  });
});
