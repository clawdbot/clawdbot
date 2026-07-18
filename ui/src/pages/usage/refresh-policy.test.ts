import { describe, expect, it } from "vitest";
import { decideUsageRefresh, USAGE_PAYLOAD_TTL_MS } from "./refresh-policy.ts";

const NOW_MS = 1_000_000;

describe("decideUsageRefresh", () => {
  it("skips a reconnect while the cached payload is within the TTL", () => {
    expect(
      decideUsageRefresh({
        reason: "reconnect",
        visible: true,
        interrupted: false,
        nowMs: NOW_MS,
        lastLoadedAtMs: NOW_MS - USAGE_PAYLOAD_TTL_MS + 1,
      }),
    ).toBe("skip");
  });

  it("defers a stale reconnect until the page is visible", () => {
    const stale = {
      nowMs: NOW_MS,
      lastLoadedAtMs: NOW_MS - USAGE_PAYLOAD_TTL_MS,
    };
    expect(
      decideUsageRefresh({ reason: "reconnect", visible: false, interrupted: false, ...stale }),
    ).toBe("defer");
    expect(
      decideUsageRefresh({ reason: "focus", visible: true, interrupted: false, ...stale }),
    ).toBe("fetch");
  });

  it("always fetches for a manual refresh", () => {
    expect(
      decideUsageRefresh({
        reason: "manual",
        visible: false,
        interrupted: false,
        nowMs: NOW_MS,
        lastLoadedAtMs: NOW_MS,
      }),
    ).toBe("fetch");
  });

  it("fetches on a visible reconnect after the TTL", () => {
    expect(
      decideUsageRefresh({
        reason: "reconnect",
        visible: true,
        interrupted: false,
        nowMs: NOW_MS,
        lastLoadedAtMs: NOW_MS - USAGE_PAYLOAD_TTL_MS,
      }),
    ).toBe("fetch");
  });
  it("defers interrupted work while hidden, then fetches once active despite a fresh payload", () => {
    const fresh = {
      reason: "reconnect" as const,
      nowMs: NOW_MS,
      lastLoadedAtMs: NOW_MS,
      interrupted: true,
    };
    expect(decideUsageRefresh({ ...fresh, visible: false })).toBe("defer");
    expect(decideUsageRefresh({ ...fresh, reason: "focus", visible: true })).toBe("fetch");
  });

  it("applies the same TTL to automatic settle polling", () => {
    expect(
      decideUsageRefresh({
        reason: "poll",
        visible: true,
        interrupted: false,
        nowMs: NOW_MS,
        lastLoadedAtMs: NOW_MS - USAGE_PAYLOAD_TTL_MS + 1,
      }),
    ).toBe("skip");
  });
});
