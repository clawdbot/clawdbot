// @vitest-environment node
// Control UI tests cover format behavior.
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import {
  clampText,
  formatDateTimeMs,
  formatDateMs,
  formatCompactTokenCount,
  formatContextTokenCapacity,
  formatDurationCompact,
  formatDurationHuman,
  formatMs,
  formatRelativeTimestamp,
  formatTimeAgo,
  formatTimeMs,
  formatUnknownText,
  truncateText,
} from "./format.ts";
import { stripThinkingTags } from "./strip-thinking-tags.ts";

describe("formatAgo", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it("formats timestamps less than 60s in the future", () => {
    expect(formatRelativeTimestamp(Date.now() + 30_000)).toMatch(/^in (29|30)s$/);
  });

  it("preserves past seconds without a suffix", () => {
    expect(formatRelativeTimestamp(Date.now() - 30_000, { suffix: false })).toMatch(/^(29|30)s$/);
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

  it("returns a localized current-time label for recent past timestamps", () => {
    expect(formatRelativeTimestamp(Date.now() - 10_000)).toBe("just now");
  });

  it("returns 'Xm ago' for past timestamps", () => {
    expect(formatRelativeTimestamp(Date.now() - 5 * 60_000)).toBe("5m ago");
  });

  it("returns 'n/a' for null/undefined", () => {
    expect(formatRelativeTimestamp(null)).toBe("n/a");
    expect(formatRelativeTimestamp(undefined)).toBe("n/a");
  });

  it("uses the active Control UI locale", async () => {
    await i18n.setLocale("fr");
    expect(formatRelativeTimestamp(Date.now() - 5 * 60_000)).toContain("5");
    expect(formatRelativeTimestamp(Date.now() - 5 * 60_000)).not.toContain("ago");
  });
});

describe("localized durations", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "preserves invalid duration fallbacks for %s",
    (durationMs) => {
      expect(formatDurationCompact(durationMs)).toBeUndefined();
      expect(formatDurationHuman(durationMs, "unavailable")).toBe("unavailable");
    },
  );

  it("keeps zero distinct from a positive duration rounded to zero", () => {
    expect(formatDurationCompact(0)).toBeUndefined();
    expect(formatDurationCompact(0.1)).toBe("0ms");
    expect(formatDurationHuman(0)).toBe("0ms");
  });

  it.each([
    { durationMs: 999.5, expected: "1s" },
    { durationMs: 59_000, expected: "59s" },
    { durationMs: 59_500, expected: "1m" },
    { durationMs: 92_000, expected: "1m 32s" },
    { durationMs: 3_660_000, expected: "1h 1m" },
    { durationMs: 3_630_000, expected: "1h 30s" },
    { durationMs: 86_430_000, expected: "1d 30s" },
    { durationMs: 86_460_000, expected: "1d 1m" },
    { durationMs: 49 * 60 * 60 * 1000, expected: "2d 1h" },
  ])("formats $durationMs ms with separated compact units", ({ durationMs, expected }) => {
    expect(formatDurationCompact(durationMs)).toBe(expected);
  });

  it.each([
    { durationMs: 999.6, expected: "1s" },
    { durationMs: 3_569_999, expected: "59m" },
    { durationMs: 5_371_000, expected: "1h" },
    { durationMs: 84_599_000, expected: "23h" },
    { durationMs: 127_799_000, expected: "1d" },
    { durationMs: 36 * 60 * 60 * 1000, expected: "2d" },
  ])("rounds $durationMs ms once for human display", ({ durationMs, expected }) => {
    expect(formatDurationHuman(durationMs)).toBe(expected);
  });

  it.each(["fr", "de", "ar"] as const)("preserves duration quantities in %s", async (locale) => {
    await i18n.setLocale(locale);
    const unit = (value: number, unitName: string) =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit: unitName,
        unitDisplay: "narrow",
        maximumFractionDigits: 0,
      }).format(value);
    expect(formatDurationCompact(60_000)).toBe(unit(1, "minute"));
    expect(formatDurationHuman(60_000)).toBe(unit(1, "minute"));
    expect(formatDurationHuman(5_371_000)).toBe(unit(1, "hour"));
    expect(formatDurationHuman(127_799_000)).toBe(unit(1, "day"));
    expect(formatDurationCompact(3_630_000)).toBe(`${unit(1, "hour")} ${unit(30, "second")}`);
    expect(formatDurationCompact(86_460_000)).toBe(`${unit(1, "day")} ${unit(1, "minute")}`);
    expect(formatDurationCompact(0)).toBeUndefined();
    expect(formatDurationHuman(0)).toBe(unit(0, "millisecond"));
    expect(formatDurationHuman(undefined, "missing")).toBe("missing");
  });
});

describe("formatTimeAgo", () => {
  it("keeps sub-minute durations in seconds", () => {
    expect(formatTimeAgo(30_000, { suffix: false })).toBe("30s");
  });

  it("localizes its invalid-duration fallback", async () => {
    await i18n.setLocale("fr");
    expect(formatTimeAgo(null)).not.toBe("unknown");
    await i18n.setLocale("en");
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

  it("defaults to minute precision", () => {
    const formatted = formatMs(new Date(2026, 0, 2, 15, 4, 55).getTime());
    expect(formatted).toContain("2026");
    expect(formatted).not.toMatch(/:55(?:\s|$)/u);
  });
});

describe("date/time millisecond formatters", () => {
  it("return fallback text for Date-invalid timestamps", () => {
    expect(formatDateMs(8_640_000_000_000_001, undefined, "")).toBe("");
    expect(formatDateTimeMs(Number.NEGATIVE_INFINITY, undefined, "")).toBe("");
    expect(formatTimeMs(Number.POSITIVE_INFINITY, undefined, "")).toBe("");
  });

  it("defaults time-only values to minute precision while preserving explicit seconds", () => {
    const timestamp = new Date(2026, 0, 2, 15, 4, 55).getTime();
    expect(formatTimeMs(timestamp)).not.toMatch(/:55(?:\s|$)/u);
    expect(
      formatTimeMs(timestamp, { hour: "numeric", minute: "2-digit", second: "2-digit" }),
    ).toMatch(/:55(?:\s|$)/u);
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

  it("drops malformed reasoning while preserving the visible suffix spacing", () => {
    expect(stripThinkingTags("private chain of thought </think> Visible answer")).toBe(
      " Visible answer",
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
    expect(formatCompactTokenCount(1_050_000)).toBe("1.1M");
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

describe("formatContextTokenCapacity", () => {
  it("truncates million-scale capacity to at most one decimal", () => {
    expect(formatContextTokenCapacity(1_000_000)).toBe("1M");
    expect(formatContextTokenCapacity(1_050_000)).toBe("1M");
    expect(formatContextTokenCapacity(1_100_000)).toBe("1.1M");
  });

  it("preserves shared compact formatting below one million", () => {
    expect(formatContextTokenCapacity(999)).toBe("999");
    expect(formatContextTokenCapacity(1_000)).toBe("1k");
    expect(formatContextTokenCapacity(32_768)).toBe("32.8k");
    expect(formatContextTokenCapacity(999_999)).toBe("1M");
  });
});

describe("formatCompactTokenCount edge inputs", () => {
  it("falls back to 0 for nullish or non-finite input", () => {
    expect(formatCompactTokenCount(null)).toBe("0");
    expect(formatCompactTokenCount(undefined)).toBe("0");
    expect(formatCompactTokenCount(Number.NaN)).toBe("0");
  });

  it("formats billion-scale provider totals with a B suffix", () => {
    expect(formatCompactTokenCount(1_000_000_000)).toBe("1B");
    expect(formatCompactTokenCount(4_132_000_000)).toBe("4.1B");
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
