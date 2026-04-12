import { afterEach, describe, expect, it, vi } from "vitest";
import { formatConsoleTimestamp } from "./console.js";

describe("formatConsoleTimestamp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function pad2(n: number) {
    return String(n).padStart(2, "0");
  }

  function pad3(n: number) {
    return String(n).padStart(3, "0");
  }

  function formatExpectedLocalIsoWithOffset(now: Date) {
    const year = now.getFullYear();
    const month = pad2(now.getMonth() + 1);
    const day = pad2(now.getDate());
    const h = pad2(now.getHours());
    const m = pad2(now.getMinutes());
    const s = pad2(now.getSeconds());
    const ms = pad3(now.getMilliseconds());
    const tzOffset = now.getTimezoneOffset();
    const tzSign = tzOffset <= 0 ? "+" : "-";
    const tzHours = pad2(Math.floor(Math.abs(tzOffset) / 60));
    const tzMinutes = pad2(Math.abs(tzOffset) % 60);
    return `${year}-${month}-${day}T${h}:${m}:${s}.${ms}${tzSign}${tzHours}:${tzMinutes}`;
  }

  it("pretty style returns local HH:MM:SS without timezone suffix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T18:01:02.345Z"));

    const result = formatConsoleTimestamp("pretty");
    const now = new Date();
    const h = pad2(now.getHours());
    const m = pad2(now.getMinutes());
    const s = pad2(now.getSeconds());
    expect(result).toBe(`${h}:${m}:${s}`);
  });

  it("compact style returns local ISO-like timestamp with timezone offset", () => {
    const result = formatConsoleTimestamp("compact");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T18:01:02.345Z"));
    const now = new Date();
    expect(formatConsoleTimestamp("compact")).toBe(formatExpectedLocalIsoWithOffset(now));
  });

  it("json style returns local ISO-like timestamp with timezone offset", () => {
    const result = formatConsoleTimestamp("json");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T18:01:02.345Z"));
    const now = new Date();
    expect(formatConsoleTimestamp("json")).toBe(formatExpectedLocalIsoWithOffset(now));
  });

  it("timestamp contains the correct local date components", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T18:01:02.345Z"));

    const before = new Date();
    const result = formatConsoleTimestamp("compact");
    const after = new Date();
    // The date portion should match the local date
    const datePart = result.slice(0, 10);
    const beforeDate = `${before.getFullYear()}-${String(before.getMonth() + 1).padStart(2, "0")}-${String(before.getDate()).padStart(2, "0")}`;
    const afterDate = `${after.getFullYear()}-${String(after.getMonth() + 1).padStart(2, "0")}-${String(after.getDate()).padStart(2, "0")}`;
    // Allow for date boundary crossing during test
    expect([beforeDate, afterDate]).toContain(datePart);
  });
});
