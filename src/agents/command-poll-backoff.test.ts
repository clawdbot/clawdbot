// Verifies command polling backoff state used by diagnostic/session commands.
import { describe, expect, it } from "vitest";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  pruneStaleCommandPolls,
  recordCommandPoll,
  resetCommandPollCount,
} from "./command-poll-backoff.js";

describe("command-poll-backoff", () => {
  describe("recordCommandPoll", () => {
    it("returns 5s on first no-output poll", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };
      const retryMs = recordCommandPoll(state, "cmd-123", false);
      expect(retryMs).toBe(5000);
      // Poll counts are zero-based indexes into the backoff schedule.
      expect(state.commandPollCounts?.get("cmd-123")?.count).toBe(0);
    });

    it("increments count and increases backoff on consecutive no-output polls", () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };

      expect(recordCommandPoll(state, "cmd-123", false)).toBe(5000);
      expect(recordCommandPoll(state, "cmd-123", false)).toBe(10000);
      expect(recordCommandPoll(state, "cmd-123", false)).toBe(30000);
      expect(recordCommandPoll(state, "cmd-123", false)).toBe(60000);
      expect(recordCommandPoll(state, "cmd-123", false)).toBe(60000);

      expect(state.commandPollCounts?.get("cmd-123")?.count).toBe(4);
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

      // New output resets count so the next quiet poll starts at the fast lane.
      const retryMs = recordCommandPoll(state, "cmd-123", true);
      expect(retryMs).toBe(5000);
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
          ["cmd-old", { count: 5, lastPollAt: Date.now() - 7200000 }],
          ["cmd-new", { count: 3, lastPollAt: Date.now() - 1000 }],
        ]),
      };

      pruneStaleCommandPolls(state, 3600000);

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
