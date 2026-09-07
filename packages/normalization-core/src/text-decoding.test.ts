import { describe, expect, it } from "vitest";
import { decodeTextPrefix } from "./text-decoding.js";

describe("decodeTextPrefix", () => {
  const encoded = new TextEncoder().encode("ab😀cd");

  it("decodes complete text normally", () => {
    expect(decodeTextPrefix(encoded)).toBe("ab😀cd");
  });

  it("drops an incomplete trailing sequence from a truncated prefix", () => {
    expect(decodeTextPrefix(encoded.subarray(0, 3), { truncated: true })).toBe("ab");
  });

  it("preserves normal replacement behavior for a complete malformed body", () => {
    expect(decodeTextPrefix(encoded.subarray(0, 3))).toBe("ab�");
  });
});
