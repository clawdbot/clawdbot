// Sandbox formatter tests cover duration and sandbox diagnostic display helpers.
import { describe, expect, it } from "vitest";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import { formatImageMatch, formatSimpleStatus, formatStatus } from "./sandbox-formatters.js";

/** Helper matching old formatAge behavior: spaced compound duration */
const formatAge = (ms: number) => formatDurationCompact(ms, { spaced: true }) ?? "0s";

describe("sandbox-formatters", () => {
  describe("formatStatus", () => {
    it.each([
      { running: true, expected: "🟢 running" },
      { running: false, expected: "⚫ stopped" },
    ])("formats running=$running", ({ running, expected }) => {
      expect(formatStatus(running)).toBe(expected);
    });
  });

  describe("formatSimpleStatus", () => {
    it.each([
      { running: true, expected: "running" },
      { running: false, expected: "stopped" },
    ])("formats running=$running without emoji", ({ running, expected }) => {
      expect(formatSimpleStatus(running)).toBe(expected);
    });
  });

  describe("formatImageMatch", () => {
    it.each([
      { imageMatch: true, expected: "✓" },
      { imageMatch: false, expected: "⚠️  mismatch" },
    ])("formats imageMatch=$imageMatch", ({ imageMatch, expected }) => {
      expect(formatImageMatch(imageMatch)).toBe(expected);
    });
  });

  describe("formatAge", () => {
    it.each([
      { ms: 0, expected: "0s" },
      { ms: 5000, expected: "5s" },
      { ms: 45000, expected: "45s" },
      { ms: 60000, expected: "1m" },
      { ms: 90000, expected: "1m 30s" }, // 90 seconds = 1m 30s
      { ms: 300000, expected: "5m" },
      { ms: 3600000, expected: "1h" },
      { ms: 3660000, expected: "1h 1m" },
      { ms: 5400000, expected: "1h 30m" },
      { ms: 7200000, expected: "2h" },
      { ms: 86400000, expected: "1d" },
      { ms: 90000000, expected: "1d 1h" },
      { ms: 172800000, expected: "2d" },
      { ms: 183600000, expected: "2d 3h" },
      { ms: 59999, expected: "1m" }, // Rounds to 1 minute exactly
      { ms: 3599999, expected: "1h" }, // Rounds to 1 hour exactly
      { ms: 86399999, expected: "1d" }, // Rounds to 1 day exactly
    ])("formats $ms ms", ({ ms, expected }) => {
      expect(formatAge(ms)).toBe(expected);
    });
  });
});
