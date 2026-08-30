// Tests for chat input control character sanitization.
import { describe, expect, it } from "vitest";
import { sanitizeChatSendMessageInput } from "./chat-input-sanitize.js";

describe("sanitizeChatSendMessageInput", () => {
  it("rejects null bytes before filtering", () => {
    expect(sanitizeChatSendMessageInput("before\u0000after")).toEqual({
      ok: false,
      error: "message must not contain null bytes",
    });
  });

  it("strips every disallowed C0 character and DEL", () => {
    const disallowed = [
      ...Array.from({ length: 8 }, (_, index) => String.fromCharCode(index + 1)),
      String.fromCharCode(0x0b, 0x0c),
      ...Array.from({ length: 18 }, (_, index) => String.fromCharCode(index + 0x0e)),
      String.fromCharCode(0x7f),
    ].join("");
    expect(sanitizeChatSendMessageInput(`before${disallowed}after`)).toEqual({
      ok: true,
      message: "beforeafter",
    });
  });

  it("preserves whitespace, printable text, C1 boundaries, and Unicode", () => {
    const input = `\t\n\r ~${String.fromCharCode(0x80)}${String.fromCharCode(0x9f)}世界😀`;
    expect(sanitizeChatSendMessageInput(input)).toEqual({ ok: true, message: input });
  });

  it("normalizes Unicode to NFC", () => {
    expect(sanitizeChatSendMessageInput("Cafe\u0301")).toEqual({
      ok: true,
      message: "Café",
    });
  });
});
