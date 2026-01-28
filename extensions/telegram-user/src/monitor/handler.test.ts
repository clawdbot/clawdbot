import { describe, expect, it } from "vitest";

import { resolveTelegramUserTimestampMs } from "./handler.js";

describe("resolveTelegramUserTimestampMs", () => {
  it("uses Date values directly", () => {
    const date = new Date("2025-01-02T03:04:05Z");
    expect(resolveTelegramUserTimestampMs(date)).toBe(date.getTime());
  });

  it("converts seconds to milliseconds", () => {
    expect(resolveTelegramUserTimestampMs(1_710_000_000)).toBe(1_710_000_000 * 1000);
  });

  it("passes through millisecond values", () => {
    expect(resolveTelegramUserTimestampMs(1_710_000_000_000)).toBe(1_710_000_000_000);
  });

  it("returns undefined for invalid dates", () => {
    const invalid = new Date("invalid");
    expect(resolveTelegramUserTimestampMs(invalid)).toBeUndefined();
  });
});
