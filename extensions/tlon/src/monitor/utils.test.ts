import { describe, expect, it } from "vitest";
import { formatSummarizationHistoryText } from "./utils.js";

// 2026-07-01 12:00:00 UTC. The same instant in any zone, so assertions can
// compare timezone-aware output deterministically.
const SAMPLE_TS = Date.UTC(2026, 6, 1, 12, 0, 0);

function extractTimestamp(text: string): string {
  // Envelope header is the leading `[Tlon ...]`; the timestamp is its tail.
  const match = text.match(/^\[Tlon [^\]]+\]/);
  if (!match) {
    throw new Error(`expected envelope header in: ${text}`);
  }
  return match[0];
}

describe("formatSummarizationHistoryText", () => {
  it("renders UTC instants with a Z-suffixed ISO timestamp when userTimezone is UTC", () => {
    // UTC is the deterministic baseline: the envelope's UTC branch emits a
    // `YYYY-MM-DDTHH:mm:ssZ` ISO timestamp that no local/IANA zone produces,
    // so this assertion cannot false-pass on a host whose zone equals UTC.
    const text = formatSummarizationHistoryText(
      [{ author: "~sampel", content: "hello", timestamp: SAMPLE_TS }],
      { agents: { defaults: { userTimezone: "UTC" } } } as never,
    );
    expect(extractTimestamp(text)).toContain("2026-07-01T12:00:00Z");
    expect(text).toContain("~sampel");
    expect(text).toContain("hello");
  });

  it("shifts the local time relative to the UTC baseline when a non-UTC zone is configured", () => {
    // 12:00 UTC + 8h -> 20:00 in Asia/Shanghai; -4h (EDT) -> 08:00 in New York.
    // Both differ from the UTC baseline, proving the configured zone applied.
    const history = [{ author: "~a", content: "x", timestamp: SAMPLE_TS }];
    const utc = extractTimestamp(
      formatSummarizationHistoryText(history, {
        agents: { defaults: { userTimezone: "UTC" } },
      } as never),
    );
    const shanghai = extractTimestamp(
      formatSummarizationHistoryText(history, {
        agents: { defaults: { userTimezone: "Asia/Shanghai" } },
      } as never),
    );
    const newYork = extractTimestamp(
      formatSummarizationHistoryText(history, {
        agents: { defaults: { userTimezone: "America/New_York" } },
      } as never),
    );
    expect(shanghai).toContain("20:00:00");
    expect(newYork).toContain("08:00:00");
    expect(shanghai).not.toBe(utc);
    expect(newYork).not.toBe(utc);
  });

  it("joins multiple entries with newlines", () => {
    const history = [
      { author: "~a", content: "first", timestamp: SAMPLE_TS },
      { author: "~b", content: "second", timestamp: SAMPLE_TS + 60_000 },
    ];
    const text = formatSummarizationHistoryText(history, {
      agents: { defaults: { userTimezone: "UTC" } },
    } as never);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("first");
    expect(text).toContain("second");
  });
});
