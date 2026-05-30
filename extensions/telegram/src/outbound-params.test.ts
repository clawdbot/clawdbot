import { describe, expect, it } from "vitest";
import {
  parseTelegramMessageThreadId,
  parseTelegramReplyToMessageId,
  parseTelegramThreadId,
} from "./outbound-params.js";

describe("parseTelegramThreadId", () => {
  it("parses numeric and scoped thread ids", () => {
    expect(parseTelegramThreadId("42")).toBe(42);
    expect(parseTelegramThreadId("-10099")).toBe(-10099);
    expect(parseTelegramThreadId("-10099:42")).toBe(42);
    expect(parseTelegramThreadId("-1001234567890:topic:42")).toBe(42);
    expect(parseTelegramThreadId(42)).toBe(42);
  });

  it("returns undefined for invalid thread ids", () => {
    expect(parseTelegramThreadId("abc")).toBeUndefined();
    expect(parseTelegramThreadId(42.5)).toBeUndefined();
    expect(parseTelegramThreadId(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(parseTelegramThreadId("-10099:42.5")).toBeUndefined();
    expect(parseTelegramThreadId("")).toBeUndefined();
    expect(parseTelegramThreadId(null)).toBeUndefined();
    expect(parseTelegramThreadId(undefined)).toBeUndefined();
  });
});

describe("parseTelegramReplyToMessageId", () => {
  it("parses reply-to message ids", () => {
    expect(parseTelegramReplyToMessageId("123")).toBe(123);
  });

  it("returns undefined for missing reply-to ids", () => {
    expect(parseTelegramReplyToMessageId(null)).toBeUndefined();
  });

  it("returns undefined for unsafe reply-to ids", () => {
    expect(parseTelegramReplyToMessageId("123.5")).toBeUndefined();
    expect(parseTelegramReplyToMessageId(123.5)).toBeUndefined();
    expect(parseTelegramReplyToMessageId(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
  });
});

describe("parseTelegramMessageThreadId", () => {
  it("parses non-negative Telegram message thread ids", () => {
    expect(parseTelegramMessageThreadId("0")).toBe(0);
    expect(parseTelegramMessageThreadId(42)).toBe(42);
  });

  it("returns undefined for unsafe Telegram message thread ids", () => {
    expect(parseTelegramMessageThreadId("-1")).toBeUndefined();
    expect(parseTelegramMessageThreadId(42.5)).toBeUndefined();
    expect(parseTelegramMessageThreadId(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
  });
});
