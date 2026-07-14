import { describe, expect, it } from "vitest";
import { base64UrlDecode } from "./ed25519-signature.ts";

describe("base64UrlDecode", () => {
  it("throws on input exceeding the maximum allowed length", () => {
    // MAX_BASE64URL_DECODE_INPUT_LENGTH is 4096; 5000 is safely over it.
    const oversized = "A".repeat(5000);
    expect(() => base64UrlDecode(oversized)).toThrow(/maximum allowed length/);
  });
});
