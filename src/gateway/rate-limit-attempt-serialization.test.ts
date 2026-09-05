// Auth serialization tests cover exemption-aware credential fallback ordering.
import { describe, expect, it, vi } from "vitest";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import { withSerializedCredentialFallbackAttempt } from "./rate-limit-attempt-serialization.js";

describe("credential fallback serialization", () => {
  it("does not queue an exempt local fallback behind another local attempt", async () => {
    const limiter = createAuthRateLimiter({ pruneIntervalMs: 0 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    try {
      const first = withSerializedCredentialFallbackAttempt({
        limiter,
        ip: "127.0.0.1",
        run: async () => await firstGate,
      });
      const second = withSerializedCredentialFallbackAttempt({
        limiter,
        ip: "127.0.0.1",
        run: async () => {
          secondStarted = true;
        },
      });

      await vi.waitFor(() => expect(secondStarted).toBe(true));
      releaseFirst();
      await Promise.all([first, second]);
    } finally {
      limiter.dispose();
    }
  });

  it("keeps non-exempt remote fallbacks serialized", async () => {
    const limiter = createAuthRateLimiter({ pruneIntervalMs: 0 });
    const ip = "198.51.100.20";
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    try {
      const first = withSerializedCredentialFallbackAttempt({
        limiter,
        ip,
        run: async () => await firstGate,
      });
      const second = withSerializedCredentialFallbackAttempt({
        limiter,
        ip,
        run: async () => {
          secondStarted = true;
        },
      });

      await Promise.resolve();
      expect(secondStarted).toBe(false);
      releaseFirst();
      await Promise.all([first, second]);
      expect(secondStarted).toBe(true);
    } finally {
      limiter.dispose();
    }
  });
});
