import { describe, expect, it } from "vitest";
import { truncateCloseReason } from "./close-reason.js";

describe("truncateCloseReason", () => {
  it("returns the reason unchanged when it fits within the byte cap", () => {
    expect(truncateCloseReason("short reason")).toBe("short reason");
  });

  it("returns 'invalid handshake' for empty string", () => {
    expect(truncateCloseReason("")).toBe("invalid handshake");
  });

  it("truncates ASCII-only reasons at exactly maxBytes", () => {
    const reason = "a".repeat(200);
    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBe(120);
    expect(result).toBe("a".repeat(120));
  });

  it("does not cut mid-UTF-8 sequence — result stays within maxBytes", () => {
    // 118 ASCII chars + emoji starting at byte 118; emoji is 4 bytes so the
    // naive subarray(0, 120) would cut it at byte 2, leaving two continuation
    // bytes that decode to two U+FFFD (3 bytes each) = 122 bytes total.
    const reason = "x".repeat(118) + "😀".repeat(5);
    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(120);
    expect(result).not.toContain("�");
    expect(result).toBe("x".repeat(118));
  });

  it("does not cut mid-UTF-8 sequence for 2-byte chars (e.g. é)", () => {
    // Each 'é' is 2 bytes. 119 'a' + 'é' = 121 bytes; cap is 120, which falls
    // at the second byte of 'é'. The fix should back up and return 119 'a'.
    const reason = "a".repeat(119) + "é".repeat(5);
    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(120);
    expect(result).not.toContain("�");
    expect(result).toBe("a".repeat(119));
  });

  it("does not cut mid-UTF-8 sequence for 3-byte chars (e.g. ✓)", () => {
    // Each '✓' is 3 bytes. 119 'a' + '✓' = 122 bytes; the naive slice at 120
    // cuts the second byte of '✓'. The fix backs up to byte 119.
    const reason = "a".repeat(119) + "✓".repeat(5);
    const result = truncateCloseReason(reason);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(120);
    expect(result).not.toContain("�");
    expect(result).toBe("a".repeat(119));
  });

  it("respects a custom maxBytes cap", () => {
    const reason = "😀".repeat(10); // each 4 bytes = 40 bytes
    const result = truncateCloseReason(reason, 10);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(10);
    expect(result).not.toContain("�");
    expect(result).toBe("😀".repeat(2)); // 8 bytes, next emoji would exceed 10
  });
});
