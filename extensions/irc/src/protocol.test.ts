import { describe, expect, it } from "vitest";
import {
  parseIrcLine,
  parseIrcPrefix,
  sanitizeIrcOutboundText,
  sanitizeIrcTarget,
  splitIrcText,
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

  it("splits long text on boundaries", () => {
    const chunks = splitIrcText("a ".repeat(300), 120);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
  });
});
