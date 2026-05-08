import { describe, expect, it } from "vitest";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  calculateBackoffMs,
  getCommandPollSuggestion,
  pruneStaleCommandPolls,
  recordCommandPoll,
  resetCommandPollCount,
} from "./command-poll-backoff.js";

describe("command-poll-backoff", () => {
  describe("calculateBackoffMs", () => {
    it("returns 5s for first poll", () => {
      expect(calculateBackoffMs(0)).toBe(5000);
    });

    it("returns 10s for second poll", () => {
      expect(calculateBackoffMs(1)).toBe(10000);
    });

    it("returns 30s for third poll", () => {
      expect(calculateBackoffMs(2)).toBe(30000);
    });

    it("returns 60s for fourth and subsequent polls (capped)", () => {
      expect(calculateBackoffMs(3)).toBe(60000);
      expect(calculateBackoffMs(4)).toBe(60000);
      expect(calculateBackoffMs(10)).toBe(60000);
      expect(calculateBackoffMs(100)).toBe(60000);
    });
  });

  describe("recordCommandPoll", () => {
    it("returns 5s on first no-output poll", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };
      const retryMs = recordCommandPoll(state, "cmd-123", false);
      expect(retryMs).toBe(5000);
      expect(state.commandPollCounts?.get("cmd-123")?.count).toBe(0); // First poll = index 0
    });

    it("increments count and increases backoff on consecutive no-output polls", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      expect(recordCommandPoll(state, "cmd-123", false)).toBe(5000); // count=0 -> 5s
      expect(recordCommandPoll(state, "cmd-123", false)).toBe(10000); // count=1 -> 10s
      expect(recordCommandPoll(state, "cmd-123", false)).toBe(30000); // count=2 -> 30s
      expect(recordCommandPoll(state, "cmd-123", false)).toBe(60000); // count=3 -> 60s
      expect(recordCommandPoll(state, "cmd-123", false)).toBe(60000); // count=4 -> 60s (capped)

      expect(state.commandPollCounts?.get("cmd-123")?.count).toBe(4); // 5 polls = index 4
    });

    it("resets count when poll returns new output", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      recordCommandPoll(state, "cmd-123", false);
      recordCommandPoll(state, "cmd-123", false);
      recordCommandPoll(state, "cmd-123", false);
      expect(state.commandPollCounts?.get("cmd-123")?.count).toBe(2); // 3 polls = index 2

      // New output resets count
      const retryMs = recordCommandPoll(state, "cmd-123", true);
      expect(retryMs).toBe(5000); // Back to first poll delay
      expect(state.commandPollCounts?.get("cmd-123")?.count).toBe(0);
    });

    it("tracks different commands independently", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      recordCommandPoll(state, "cmd-1", false);
      recordCommandPoll(state, "cmd-1", false);
      recordCommandPoll(state, "cmd-2", false);

      expect(state.commandPollCounts?.get("cmd-1")?.count).toBe(1); // 2 polls = index 1
      expect(state.commandPollCounts?.get("cmd-2")?.count).toBe(0); // 1 poll = index 0
    });
  });

  describe("getCommandPollSuggestion", () => {
    it("returns undefined for untracked command", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };
      expect(getCommandPollSuggestion(state, "unknown")).toBeUndefined();
    });

    it("returns current backoff for tracked command", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      recordCommandPoll(state, "cmd-123", false);
      recordCommandPoll(state, "cmd-123", false);

      expect(getCommandPollSuggestion(state, "cmd-123")).toBe(10000);
    });
  });

  describe("resetCommandPollCount", () => {
    it("removes command from tracking", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      recordCommandPoll(state, "cmd-123", false);
      expect(state.commandPollCounts?.has("cmd-123")).toBe(true);

      resetCommandPollCount(state, "cmd-123");
      expect(state.commandPollCounts?.has("cmd-123")).toBe(false);
    });

    it("leaves tracking empty for an untracked command", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      resetCommandPollCount(state, "unknown");
      expect(state.commandPollCounts?.has("unknown") ?? false).toBe(false);
    });
  });

  describe("pruneStaleCommandPolls", () => {
    it("removes polls older than maxAge", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
        commandPollCounts: new Map([
          ["cmd-old", { count: 5, lastPollAt: Date.now() - 7200000 }], // 2 hours ago
          ["cmd-new", { count: 3, lastPollAt: Date.now() - 1000 }], // 1 second ago
        ]),
      };

      pruneStaleCommandPolls(state, 3600000); // 1 hour max age

      expect(state.commandPollCounts?.has("cmd-old")).toBe(false);
      expect(state.commandPollCounts?.has("cmd-new")).toBe(true);
    });

    it("keeps an empty state without creating poll tracking", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "idle",
        queueDepth: 0,
      };

      pruneStaleCommandPolls(state);
      expect(state.commandPollCounts).toBeUndefined();
    });
  });
});
