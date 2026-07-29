// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { formatSidebarTimestamp } from "./app-sidebar-session-catalogs.ts";

describe("formatSidebarTimestamp", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await i18n.setLocale("en");
  });

  it("keeps the localized current-time label for recent sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));

    expect(formatSidebarTimestamp(Date.now() - 10_000)).toBe("now");
  });

  it("uses compact localized units for older sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));

    expect(formatSidebarTimestamp(Date.now() - 5 * 60_000)).toBe("5m");
  });

  it("preserves direction for timestamps in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00Z"));

    expect(formatSidebarTimestamp(Date.now() + 30_000)).toBe("in 30s");
    expect(formatSidebarTimestamp(Date.now() + 5 * 60_000)).toBe("in 5m");
  });
});
