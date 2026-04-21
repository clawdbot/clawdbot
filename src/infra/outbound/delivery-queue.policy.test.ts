import { describe, expect, it } from "vitest";
import {
  computeBackoffMs,
  isEntryEligibleForRecoveryRetry,
  isPermanentDeliveryError,
} from "./delivery-queue.js";

describe("delivery-queue policy", () => {
  describe("isPermanentDeliveryError", () => {
    it.each([
      "No conversation reference found for user:abc",
      "Forum send failed: chat not found (chat_id=user:123)",
      "403: Forbidden: bot is not a member of the channel chat",
      "user not found",
      "Bot was blocked by the user",
      "Forbidden: bot was kicked from the group chat",
      "chat_id is empty",
      "Outbound not configured for channel: demo-channel",
      "MatrixError: [403] User @bot:matrix.example.com not in room !mixedCase:matrix.example.com",
    ])("returns true for permanent error: %s", (msg) => {
      expect(isPermanentDeliveryError(msg)).toBe(true);
    });

    it.each([
      "network down",
      "ETIMEDOUT",
      "socket hang up",
      "rate limited",
      "500 Internal Server Error",
    ])("returns false for transient error: %s", (msg) => {
      expect(isPermanentDeliveryError(msg)).toBe(false);
    });
  });

  describe("computeBackoffMs", () => {
    it.each([
      { retryCount: 0, expected: 0 },
      { retryCount: 1, expected: 5_000 },
      { retryCount: 2, expected: 25_000 },
      { retryCount: 3, expected: 120_000 },
      { retryCount: 4, expected: 600_000 },
      { retryCount: 5, expected: 600_000 },
    ] as const)(
      "returns scheduled backoff for retryCount=$retryCount",
      ({ retryCount, expected }) => {
        expect(computeBackoffMs(retryCount)).toBe(expected);
      },
    );
  });

  describe("isEntryEligibleForRecoveryRetry", () => {
    it("allows first replay after crash for retryCount=0 without lastAttemptAt", () => {
      const now = Date.now();
      const result = isEntryEligibleForRecoveryRetry(
        {
          id: "entry-1",
          channel: "demo-channel",
          to: "+1",
          payloads: [{ text: "a" }],
          enqueuedAt: now,
          retryCount: 0,
        },
        now,
      );
      expect(result).toEqual({ eligible: true });
    });

    it("defers retry entries until backoff window elapses", () => {
      const now = Date.now();
      const result = isEntryEligibleForRecoveryRetry(
        {
          id: "entry-2",
          channel: "demo-channel",
          to: "+1",
          payloads: [{ text: "a" }],
          enqueuedAt: now - 30_000,
          retryCount: 3,
          lastAttemptAt: now,
        },
        now,
      );
      expect(result.eligible).toBe(false);
      if (result.eligible) {
        throw new Error("Expected ineligible retry entry");
      }
      expect(result.remainingBackoffMs).toBeGreaterThan(0);
    });
  });
});
