import { describe, expect, it } from "vitest";
import {
  createQQBotSenderMatcher,
  normalizeQQBotAllowFrom,
  normalizeQQBotSenderId,
} from "./sender-match.js";

describe("normalizeQQBotSenderId", () => {
  it("uppercases and strips qqbot: prefix", () => {
    expect(normalizeQQBotSenderId("qqbot:abc123")).toBe("ABC123");
    expect(normalizeQQBotSenderId("QQBot:abc123")).toBe("ABC123");
  });

  it("trims whitespace", () => {
    expect(normalizeQQBotSenderId("  USER1  ")).toBe("USER1");
  });

  it("returns empty string for non-string input", () => {
    expect(normalizeQQBotSenderId(undefined as unknown as string)).toBe("");
    expect(normalizeQQBotSenderId(null as unknown as string)).toBe("");
    expect(normalizeQQBotSenderId({} as unknown as string)).toBe("");
  });

  it("accepts numeric input", () => {
    expect(normalizeQQBotSenderId(42)).toBe("42");
  });
});

describe("normalizeQQBotAllowFrom", () => {
  it("normalizes all entries and drops empty ones", () => {
    expect(normalizeQQBotAllowFrom(["qqbot:user1", "USER2", "", " "])).toEqual(["USER1", "USER2"]);
  });

  it("returns empty array for undefined/null", () => {
    expect(normalizeQQBotAllowFrom(undefined)).toEqual([]);
    expect(normalizeQQBotAllowFrom(null)).toEqual([]);
  });
});

describe("createQQBotSenderMatcher", () => {
  it("matches wildcard regardless of sender", () => {
    expect(createQQBotSenderMatcher("USER1")(["*"])).toBe(true);
    expect(createQQBotSenderMatcher("")(["*"])).toBe(true);
  });

  it("matches case-insensitive with qqbot: prefix", () => {
    const match = createQQBotSenderMatcher("qqbot:USER1");
    expect(match(["qqbot:user1"])).toBe(true);
    expect(match(["USER1"])).toBe(true);
    expect(match(["USER2"])).toBe(false);
  });

  it("returns false on empty allowlist", () => {
    expect(createQQBotSenderMatcher("USER1")([])).toBe(false);
  });

  it("returns false for empty sender against non-wildcard list", () => {
    expect(createQQBotSenderMatcher("")(["USER1"])).toBe(false);
  });
});
