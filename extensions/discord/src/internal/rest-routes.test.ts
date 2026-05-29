import { describe, expect, it, vi } from "vitest";
import { readHeaderNumber, readResetAt } from "./rest-routes.js";

describe("Discord REST rate limit header parsing", () => {
  it("rejects non-decimal numeric header forms", () => {
    const headers = new Headers({
      "X-RateLimit-Limit": "0x10",
      "X-RateLimit-Remaining": "1e3",
      "X-RateLimit-Reset-After": `1${"0".repeat(309)}`,
    });

    expect(readHeaderNumber(headers, "X-RateLimit-Limit")).toBeUndefined();
    expect(readHeaderNumber(headers, "X-RateLimit-Remaining")).toBeUndefined();
    expect(readHeaderNumber(headers, "X-RateLimit-Reset-After")).toBeUndefined();
  });

  it("keeps decimal reset headers working", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
    try {
      const response = new Response(null, {
        headers: { "X-RateLimit-Reset-After": "0.125" },
      });

      expect(readResetAt(response)).toBe(Date.now() + 125);
    } finally {
      vi.useRealTimers();
    }
  });
});
