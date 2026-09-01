import { describe, expect, it } from "vitest";
import {
  escapeCodexChatText,
  formatCodexTextForDisplay,
  sanitizeCodexTextForDisplay,
} from "./command-display-text.js";

const fromCodePoints = (codePoints: readonly number[]) =>
  codePoints.map((codePoint) => String.fromCodePoint(codePoint)).join("");

describe("Codex command display text", () => {
  it("escapes chat formatting and mention characters in order", () => {
    expect(escapeCodexChatText("&<>@\\`[]()*_~|")).toBe(
      "&amp;&lt;&gt;\uff20\\\uff40\uff3b\uff3d\uff08\uff09\u2217\uff3f\uff5e\uff5c",
    );
  });

  it("replaces every unsafe display range endpoint", () => {
    const unsafe = [
      0x0000, 0x001f, 0x007f, 0x009f, 0x00ad, 0x061c, 0x180e, 0x200b, 0x200f, 0x202a, 0x202e,
      0x2060, 0x206f, 0xfeff, 0xfff9, 0xfffb, 0xe0000, 0xe007f,
    ];
    expect(sanitizeCodexTextForDisplay(fromCodePoints(unsafe))).toBe("?".repeat(unsafe.length));
  });

  it("preserves code points adjacent to unsafe ranges", () => {
    const safe = [
      0x0020, 0x007e, 0x00a0, 0x00ac, 0x00ae, 0x061b, 0x061d, 0x180d, 0x180f, 0x200a, 0x2010,
      0x2029, 0x202f, 0x205f, 0x2070, 0xfefe, 0xff00, 0xfff8, 0xfffc, 0xdffff, 0xe0080,
    ];
    const value = fromCodePoints(safe);
    expect(sanitizeCodexTextForDisplay(value)).toBe(value);
  });

  it("preserves safe astral text and replaces one tag code point once", () => {
    expect(sanitizeCodexTextForDisplay(`A😀${String.fromCodePoint(0xe0001)}B`)).toBe("A😀?B");
  });

  it("trims display text, supplies the fallback, and neutralizes at signs", () => {
    expect(formatCodexTextForDisplay("  value  ")).toBe("value");
    expect(formatCodexTextForDisplay(" \u00a0 ")).toBe("<unknown>");
    expect(escapeCodexChatText(formatCodexTextForDisplay(" user@example.com "))).toBe(
      "user\uff20example.com",
    );
  });
});
