import { describe, expect, it, vi } from "vitest";
import {
  appendAttemptCacheTtlIfNeeded,
  ATTEMPT_CACHE_TTL_CUSTOM_TYPE,
} from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt cache-ttl tracking after compaction", () => {
  it("skips cache-ttl append when compaction completed during the attempt", () => {
    const sessionManager = {
      appendCustomEntry: vi.fn(),
    };
    const appended = appendAttemptCacheTtlIfNeeded({
      sessionManager,
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: true,
      config: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      modelApi: "anthropic-messages",
      isCacheTtlEligibleProvider: () => true,
      now: 123,
    });

    expect(appended).toBe(false);
    expect(sessionManager.appendCustomEntry).not.toHaveBeenCalledWith(
      ATTEMPT_CACHE_TTL_CUSTOM_TYPE,
      expect.anything(),
    );
  });

  it("appends cache-ttl when no compaction completed during the attempt", () => {
    const sessionManager = {
      appendCustomEntry: vi.fn(),
    };
    const appended = appendAttemptCacheTtlIfNeeded({
      sessionManager,
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      config: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      modelApi: "anthropic-messages",
      isCacheTtlEligibleProvider: () => true,
      now: 123,
    });

    expect(appended).toBe(true);
    expect(sessionManager.appendCustomEntry).toHaveBeenCalledWith(ATTEMPT_CACHE_TTL_CUSTOM_TYPE, {
      timestamp: 123,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
  });
});
