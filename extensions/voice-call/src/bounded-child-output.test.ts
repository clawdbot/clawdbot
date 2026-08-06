// Voice Call tests cover bounded child output plugin behavior.
import { describe, expect, it } from "vitest";
import {
  appendBoundedChildOutput,
  emptyBoundedChildOutput,
  formatBoundedChildOutput,
} from "./bounded-child-output.js";

describe("bounded child output", () => {
  it("keeps a bounded tail and records truncation", () => {
    const first = appendBoundedChildOutput(emptyBoundedChildOutput(), "abcdef", 5);
    expect(first).toEqual({ text: "bcdef", truncated: true });

    const second = appendBoundedChildOutput(first, "ghij", 5);
    expect(second).toEqual({ text: "fghij", truncated: true });
    expect(formatBoundedChildOutput(second)).toBe("[output truncated]\nfghij");
  });

  it("does not split a surrogate pair at the tail cap boundary", () => {
    // 🤖 is U+1F916 — two UTF-16 code units (U+D83E U+DD16).
    // Cap of 5 starts on the low surrogate: raw .slice(-5) keeps lone U+DD16 + "kept".
    // sliceUtf16Safe advances past that dangling low half and retains "kept".
    const chunk = `${"p".repeat(10)}🤖kept`;
    const rawTail = chunk.slice(-5);
    expect(rawTail.charCodeAt(0)).toBe(0xdd16);

    const result = appendBoundedChildOutput(emptyBoundedChildOutput(), chunk, 5);
    expect(result).toEqual({ text: "kept", truncated: true });
    expect(formatBoundedChildOutput(result)).toBe("[output truncated]\nkept");
  });
});
