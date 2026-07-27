// @vitest-environment node
// Control UI tests cover format behavior.
import { afterEach, describe, expect, it } from "vitest";
import {
  clampText,
  formatDateTimeMs,
  formatDateMs,
  formatCompactTokenCount,
  formatMs,
  formatRelativeTimestamp,
  formatTimeMs,
  formatTokens,
  formatUnknownText,
  parseSessionKeyParts,
  setUiTimeFormatPreference,
  truncateText,
} from "./format.ts";
import { stripThinkingTags } from "./strip-thinking-tags.ts";

describe("formatAgo", () => {
  it("returns 'in <1m' for timestamps less than 60s in the future", () => {
    expect(formatRelativeTimestamp(Date.now() + 30_000)).toBe("in <1m");
  });

  it("returns 'Xm from now' for future timestamps", () => {
    expect(formatRelativeTimestamp(Date.now() + 5 * 60_000)).toBe("in 5m");
  });

  it("returns 'Xh from now' for future timestamps", () => {
    expect(formatRelativeTimestamp(Date.now() + 3 * 60 * 60_000)).toBe("in 3h");
  });

  it("returns 'Xd from now' for future timestamps beyond 48h", () => {
    expect(formatRelativeTimestamp(Date.now() + 3 * 24 * 60 * 60_000)).toBe("in 3d");
  });

  it("returns 'Xs ago' for recent past timestamps", () => {
    expect(formatRelativeTimestamp(Date.now() - 10_000)).toBe("just now");
  });

  it("returns 'Xm ago' for past timestamps", () => {
    expect(formatRelativeTimestamp(Date.now() - 5 * 60_000)).toBe("5m ago");
  });

  it("returns 'n/a' for null/undefined", () => {
    expect(formatRelativeTimestamp(null)).toBe("n/a");
    expect(formatRelativeTimestamp(undefined)).toBe("n/a");
  });
});

describe("formatMs", () => {
  it("formats epoch timestamps", () => {
    expect(formatMs(0)).not.toBe("n/a");
  });

  it("returns n/a for Date-invalid timestamps", () => {
    expect(formatMs(8_640_000_000_000_001)).toBe("n/a");
    expect(formatMs(Number.POSITIVE_INFINITY)).toBe("n/a");
  });
});

describe("date/time millisecond formatters", () => {
  it("return fallback text for Date-invalid timestamps", () => {
    expect(formatDateMs(8_640_000_000_000_001, undefined, "")).toBe("");
    expect(formatDateTimeMs(Number.NEGATIVE_INFINITY, undefined, "")).toBe("");
    expect(formatTimeMs(Number.POSITIVE_INFINITY, undefined, "")).toBe("");
  });
});

describe("agents.defaults.timeFormat preference", () => {
  // 19:30 UTC: 24-hour renders "19:30", 12-hour renders "7:30 PM".
  const ts = Date.UTC(2026, 0, 15, 19, 30);
  const opts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  };

  afterEach(() => {
    setUiTimeFormatPreference("auto");
  });

  it("forces a 24-hour clock when preference is 24", () => {
    setUiTimeFormatPreference("24");
    expect(formatTimeMs(ts, opts, "")).toBe("19:30");
  });

  it("forces a 12-hour clock when preference is 12", () => {
    setUiTimeFormatPreference("12");
    const formatted = formatTimeMs(ts, opts, "");
    expect(formatted).toContain("7:30");
    expect(formatted).toMatch(/PM/i);
  });

  it("lets the caller override the resolved hour cycle", () => {
    setUiTimeFormatPreference("24");
    expect(formatTimeMs(ts, { ...opts, hour12: true }, "")).toMatch(/PM/i);
  });

  it("leaves rendering to the browser locale default for auto", () => {
    setUiTimeFormatPreference("auto");
    const auto = formatDateTimeMs(ts, opts, "");
    const native = new Date(ts).toLocaleString([], opts);
    expect(auto).toBe(native);
  });
});

describe("stripThinkingTags", () => {
  it("strips <think>…</think> segments", () => {
    const input = ["<think>", "secret", "</think>", "", "Hello"].join("\n");
    expect(stripThinkingTags(input)).toBe("Hello");
  });

  it("strips <thinking>…</thinking> segments", () => {
    const input = ["<thinking>", "secret", "</thinking>", "", "Hello"].join("\n");
    expect(stripThinkingTags(input)).toBe("Hello");
  });

  it("keeps text when tags are unpaired", () => {
    expect(stripThinkingTags("<think>\nsecret\nHello")).toBe("secret\nHello");
    expect(stripThinkingTags("Hello\n</think>")).toBe("Hello\n");
  });

  it("drops malformed reasoning before orphan close tags when final text follows", () => {
    expect(stripThinkingTags("private chain of thought </think> Visible answer")).toBe(
      "Visible answer",
    );
  });

  it("returns original text when no tags exist", () => {
    expect(stripThinkingTags("Hello")).toBe("Hello");
  });

  it("strips <final>…</final> segments", () => {
    const input = "<final>\n\nHello there\n\n</final>";
    expect(stripThinkingTags(input)).toBe("Hello there\n\n");
  });

  it("strips mixed <think> and <final> tags", () => {
    const input = "<think>reasoning</think>\n\n<final>Hello</final>";
    expect(stripThinkingTags(input)).toBe("Hello");
  });

  it("handles incomplete <final tag gracefully", () => {
    // When streaming splits mid-tag, we may see "<final" without closing ">"
    // This should not crash and should handle gracefully
    expect(stripThinkingTags("<final\nHello")).toBe("<final\nHello");
    expect(stripThinkingTags("Hello</final>")).toBe("Hello");
  });

  it("strips <relevant-memories> blocks", () => {
    const input = [
      "<relevant-memories>",
      "The following memories may be relevant to this conversation:",
      "- Internal memory note",
      "</relevant-memories>",
      "",
      "User-visible answer",
    ].join("\n");
    expect(stripThinkingTags(input)).toBe("User-visible answer");
  });

  it("keeps relevant-memories tags in fenced code blocks", () => {
    const input = [
      "```xml",
      "<relevant-memories>",
      "sample",
      "</relevant-memories>",
      "```",
      "",
      "Visible text",
    ].join("\n");
    expect(stripThinkingTags(input)).toBe(input);
  });

  it("hides unfinished <relevant-memories> block tails", () => {
    const input = ["Hello", "<relevant-memories>", "internal-only"].join("\n");
    expect(stripThinkingTags(input)).toBe("Hello\n");
  });
});

describe("formatUnknownText", () => {
  it("stringifies plain objects without throwing", () => {
    expect(formatUnknownText({ ok: true })).toBe('{"ok":true}');
  });

  it("falls back to object tags for non-serializable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatUnknownText(circular)).toBe("[object Object]");
  });

  it("formats symbols without relying on object coercion", () => {
    expect(formatUnknownText(Symbol("agent"))).toBe("Symbol(agent)");
  });
});

describe("parseSessionKeyParts", () => {
  it("parses a standard agent session key", () => {
    expect(parseSessionKeyParts("agent:data-expert:dingtalk:cidzg6sF43NZMy52Rnk8EN")).toEqual({
      agentId: "data-expert",
      channel: "dingtalk",
      accountId: "cidzg6sF43NZMy52Rnk8EN",
    });
  });

  it("parses account ids containing separators", () => {
    expect(parseSessionKeyParts("agent:main:telegram:user:12345:extra")).toEqual({
      agentId: "main",
      channel: "telegram",
      accountId: "user:12345:extra",
    });
  });

  it("returns null for non-agent or malformed keys", () => {
    expect(parseSessionKeyParts("global:default")).toBeNull();
    expect(parseSessionKeyParts("direct:some-key")).toBeNull();
    expect(parseSessionKeyParts("")).toBeNull();
    expect(parseSessionKeyParts("agent:")).toBeNull();
    expect(parseSessionKeyParts("agent:main")).toBeNull();
    expect(parseSessionKeyParts("agent:main:")).toBeNull();
    expect(parseSessionKeyParts("agent:main:telegram")).toBeNull();
  });
});

describe("formatCompactTokenCount", () => {
  it("formats values under 1,000 as-is", () => {
    expect(formatCompactTokenCount(0)).toBe("0");
    expect(formatCompactTokenCount(999)).toBe("999");
  });

  it("formats thousands with one decimal, trimming a trailing .0", () => {
    expect(formatCompactTokenCount(1_000)).toBe("1k");
    expect(formatCompactTokenCount(214_500)).toBe("214.5k");
    expect(formatCompactTokenCount(99_950)).toBe("100k");
  });

  it("formats millions with one decimal, trimming a trailing .0", () => {
    expect(formatCompactTokenCount(1_000_000)).toBe("1M");
    expect(formatCompactTokenCount(1_500_000)).toBe("1.5M");
  });

  it("rolls values that round up to 1000.0k into the M branch", () => {
    expect(formatCompactTokenCount(999_999)).toBe("1M");
    expect(formatCompactTokenCount(999_950)).toBe("1M");
    expect(formatCompactTokenCount(999_500)).toBe("999.5k");
  });

  it("does not roll over values just below the rounding boundary", () => {
    expect(formatCompactTokenCount(999_949)).toBe("999.9k");
    expect(formatCompactTokenCount(999_499)).toBe("999.5k");
  });

  it("supports uppercase thousands labels for Usage surfaces", () => {
    expect(formatCompactTokenCount(12_500, { thousandsSuffix: "K" })).toBe("12.5K");
  });

  it("can preserve trailing decimals for Usage surfaces", () => {
    expect(formatCompactTokenCount(1_000, { thousandsSuffix: "K", trimTrailingZero: false })).toBe(
      "1.0K",
    );
    expect(formatCompactTokenCount(1_000_000, { trimTrailingZero: false })).toBe("1.0M");
  });
});

describe("formatTokens", () => {
  it("rolls a value that rounds up to 1000k over into the M branch", () => {
    expect(formatTokens(999_500)).toBe("1.0M");
    expect(formatTokens(999_999)).toBe("1.0M");
    expect(formatTokens(999_499)).toBe("999k");
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(5_500)).toBe("5.5k");
    expect(formatTokens(null)).toBe("0");
  });
});

describe("text truncation", () => {
  it("keeps clampText output valid when the ellipsis boundary bisects an emoji", () => {
    expect(clampText(`${"a".repeat(118)}😀x`, 120)).toBe(`${"a".repeat(118)}…`);
  });

  it("keeps truncateText output valid when the boundary bisects an emoji", () => {
    expect(truncateText(`${"a".repeat(120)}😀`, 121)).toEqual({
      text: "a".repeat(120),
      truncated: true,
      total: 122,
    });
  });

  it("leaves short text unchanged", () => {
    expect(clampText("hello", 120)).toBe("hello");
    expect(truncateText("hello", 120)).toEqual({
      text: "hello",
      truncated: false,
      total: 5,
    });
  });

  it("preserves ordinary truncation behavior", () => {
    expect(clampText("abc", 2)).toBe("a…");
    expect(truncateText("abc", 2)).toEqual({ text: "ab", truncated: true, total: 3 });
  });
});
