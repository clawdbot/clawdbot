// Irc tests cover protocol plugin behavior.
import { describe, expect, it } from "vitest";
import {
  parseIrcLine,
  parseIrcPrefix,
  sanitizeIrcOutboundText,
  sanitizeIrcTarget,
} from "./protocol.js";

describe("irc protocol", () => {
  it("parses PRIVMSG lines with prefix and trailing", () => {
    const parsed = parseIrcLine(":alice!u@host PRIVMSG #room :hello world");
    expect(parsed).toEqual({
      raw: ":alice!u@host PRIVMSG #room :hello world",
      prefix: "alice!u@host",
      command: "PRIVMSG",
      params: ["#room"],
      trailing: "hello world",
    });

    expect(parseIrcPrefix(parsed?.prefix)).toEqual({
      nick: "alice",
      user: "u",
      host: "host",
    });
  });

  it("sanitizes outbound text to prevent command injection", () => {
    expect(sanitizeIrcOutboundText("hello\\r\\nJOIN #oops")).toBe("hello JOIN #oops");
    expect(sanitizeIrcOutboundText("\\u0001test\\u0000")).toBe("test");
  });

  it("validates targets and rejects control characters", () => {
    expect(sanitizeIrcTarget("#openclaw")).toBe("#openclaw");
    expect(() => sanitizeIrcTarget("#bad\\nPING")).toThrow(/Invalid IRC target/);
    expect(() => sanitizeIrcTarget(" user")).toThrow(/Invalid IRC target/);
  });

  describe("\\u escape surrogate-range guard", () => {
    const LONE_SURROGATE = /[\uD800-\uDFFF]/;

    it("preserves literal \\uXXXX when codepoint is a high surrogate", () => {
      const out = sanitizeIrcOutboundText("\\uD800");
      expect(LONE_SURROGATE.test(out)).toBe(false);
    });

    it("preserves literal \\uXXXX when codepoint is a low surrogate", () => {
      const out = sanitizeIrcOutboundText("\\uDFFF");
      expect(LONE_SURROGATE.test(out)).toBe(false);
    });

    it("still decodes valid BMP codepoints outside the surrogate range", () => {
      expect(sanitizeIrcOutboundText("\\u0041")).toBe("A");
      expect(sanitizeIrcOutboundText("\\u00e9")).toBe("é"); // é
    });

    it("decodes adjacent surrogate-pair escapes to the astral character", () => {
      expect(sanitizeIrcOutboundText("\\uD83D\\uDE00")).toBe("😀");
      expect(sanitizeIrcOutboundText("\\uD83D\\uDE00\\uD83D\\uDE01")).toBe("😀😁");
    });

    it("preserves lone high surrogate even when followed by a non-surrogate \\u", () => {
      const out = sanitizeIrcOutboundText("\\uD800\\u0041");
      expect(LONE_SURROGATE.test(out)).toBe(false);
      expect(out).toContain("A");
    });

    it("decodes BMP-escaped prefix before a surrogate pair correctly", () => {
      // Regression: \\u0041\\uD83D\\uDE00 must yield A😀, not A\\uD83D\\uDE00.
      // The old step-1 regex \\u(xxxx)\\u(xxxx) would consume \\u0041\\uD83D as a
      // non-pair, leaving \\uDE00 as a lone surrogate.
      expect(sanitizeIrcOutboundText("\\u0041\\uD83D\\uDE00")).toBe("A😀");
    });

    it("handles lone high surrogate followed by a different surrogate pair", () => {
      // \\uD800\\uD83D\\uDE00: D800 is lone (no matching low), D83D+DE00 form 😀.
      // Use toBe rather than LONE_SURROGATE regex: emoji contains surrogate
      // code units internally that would trigger a naive /[\uD800-\uDFFF]/ check.
      expect(sanitizeIrcOutboundText("\\uD800\\uD83D\\uDE00")).toBe("\\uD800😀");
    });

    it("preserves two consecutive lone high surrogates", () => {
      const out = sanitizeIrcOutboundText("\\uD800\\uD801");
      expect(LONE_SURROGATE.test(out)).toBe(false);
    });
  });
});
