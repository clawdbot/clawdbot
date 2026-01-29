import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHandlerRateLimitInfo,
  isHandlerRateLimited,
  resetAllRateLimits,
  resetHandlerRateLimit,
} from "./message-handler-rate-limit.js";

describe("message-handler-rate-limit", () => {
  afterEach(() => {
    resetAllRateLimits();
    vi.useRealTimers();
  });

  describe("isHandlerRateLimited", () => {
    it("allows first request", () => {
      const isLimited = isHandlerRateLimited("test-handler");
      expect(isLimited).toBe(false);
    });

    it("allows up to rate limit requests", () => {
      const limit = 5;
      for (let i = 0; i < limit; i++) {
        expect(isHandlerRateLimited("test-handler", limit)).toBe(false);
      }
    });

    it("blocks requests beyond rate limit", () => {
      const limit = 3;
      // Use up all tokens
      for (let i = 0; i < limit; i++) {
        expect(isHandlerRateLimited("test-handler", limit)).toBe(false);
      }
      // Next request should be blocked
      expect(isHandlerRateLimited("test-handler", limit)).toBe(true);
    });

    it("tracks handlers independently", () => {
      // Handler A uses all tokens
      for (let i = 0; i < 3; i++) {
        isHandlerRateLimited("handler-a", 3);
      }
      expect(isHandlerRateLimited("handler-a", 3)).toBe(true);

      // Handler B should still have tokens
      expect(isHandlerRateLimited("handler-b", 3)).toBe(false);
    });

    it("refills tokens after window expires", () => {
      vi.useFakeTimers();
      const limit = 2;
      const windowMs = 60_000;

      // Use up all tokens
      expect(isHandlerRateLimited("test-handler", limit, windowMs)).toBe(false);
      expect(isHandlerRateLimited("test-handler", limit, windowMs)).toBe(false);
      expect(isHandlerRateLimited("test-handler", limit, windowMs)).toBe(true);

      // Advance time past window
      vi.advanceTimersByTime(windowMs);

      // Should have tokens again
      expect(isHandlerRateLimited("test-handler", limit, windowMs)).toBe(false);
    });
  });

  describe("getHandlerRateLimitInfo", () => {
    it("returns null for unknown handler", () => {
      const info = getHandlerRateLimitInfo("unknown");
      expect(info).toBeNull();
    });

    it("returns remaining tokens after usage", () => {
      isHandlerRateLimited("test-handler", 5);
      isHandlerRateLimited("test-handler", 5);
      const info = getHandlerRateLimitInfo("test-handler");
      expect(info?.remaining).toBe(3);
    });
  });

  describe("resetHandlerRateLimit", () => {
    it("clears rate limit for specific handler", () => {
      // Use up tokens
      for (let i = 0; i < 3; i++) {
        isHandlerRateLimited("test-handler", 3);
      }
      expect(isHandlerRateLimited("test-handler", 3)).toBe(true);

      // Reset
      resetHandlerRateLimit("test-handler");

      // Should have tokens again
      expect(isHandlerRateLimited("test-handler", 3)).toBe(false);
    });
  });

  describe("resetAllRateLimits", () => {
    it("clears all rate limits", () => {
      // Use up tokens for multiple handlers
      for (let i = 0; i < 3; i++) {
        isHandlerRateLimited("handler-a", 3);
        isHandlerRateLimited("handler-b", 3);
      }
      expect(isHandlerRateLimited("handler-a", 3)).toBe(true);
      expect(isHandlerRateLimited("handler-b", 3)).toBe(true);

      // Reset all
      resetAllRateLimits();

      // Both should have tokens again
      expect(isHandlerRateLimited("handler-a", 3)).toBe(false);
      expect(isHandlerRateLimited("handler-b", 3)).toBe(false);
    });
  });
});
