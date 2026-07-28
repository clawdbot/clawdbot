import { describe, expect, it } from "vitest";
import { readDiscordAutoArchiveDurationParam } from "./runtime.shared.js";

describe("readDiscordAutoArchiveDurationParam", () => {
  it("accepts Discord REST auto-archive durations", () => {
    for (const minutes of [60, 1440, 4320, 10080]) {
      expect(
        readDiscordAutoArchiveDurationParam({ autoArchiveMinutes: minutes }, "autoArchiveMinutes"),
      ).toBe(minutes);
    }
  });

  it("omits missing values", () => {
    expect(readDiscordAutoArchiveDurationParam({}, "autoArchiveMinutes")).toBeUndefined();
  });

  it("rejects positive integers Discord will not accept before REST", () => {
    expect(() =>
      readDiscordAutoArchiveDurationParam({ autoArchiveMinutes: 999 }, "autoArchiveMinutes"),
    ).toThrow("autoArchiveMinutes must be one of 60, 1440, 4320, or 10080 minutes");
  });
});
