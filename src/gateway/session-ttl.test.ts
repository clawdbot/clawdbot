/**
 * Unit tests for session TTL utilities.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeSessionTtl,
  isSessionExpired,
  getExpiredSessionKeys,
  getCleanupConfig,
  DEFAULT_CLEANUP_INTERVAL_SECONDS,
} from "./session-ttl.js";
import type { SessionEntry } from "../config/sessions.js";

describe("session-ttl", () => {
  describe("normalizeSessionTtl", () => {
    it("returns undefined for undefined input", () => {
      expect(normalizeSessionTtl(undefined)).toBeUndefined();
    });

    it("converts number to idle config", () => {
      expect(normalizeSessionTtl(3600)).toEqual({ idle: 3600 });
    });

    it("passes through object form", () => {
      const ttl = { idle: 3600, maxAge: 86400 };
      expect(normalizeSessionTtl(ttl)).toEqual(ttl);
    });

    it("returns undefined for empty object", () => {
      expect(normalizeSessionTtl({})).toBeUndefined();
    });

    it("handles object with only idle", () => {
      expect(normalizeSessionTtl({ idle: 1800 })).toEqual({ idle: 1800 });
    });

    it("handles object with only maxAge", () => {
      expect(normalizeSessionTtl({ maxAge: 43200 })).toEqual({ maxAge: 43200 });
    });
  });

  describe("isSessionExpired", () => {
    const now = 1706400000000; // Fixed timestamp for testing

    it("returns false when session is active within idle timeout", () => {
      const entry: SessionEntry = {
        sessionId: "test",
        updatedAt: now - 1000 * 60 * 5, // 5 minutes ago
      };
      expect(isSessionExpired(entry, { idle: 3600 }, now)).toBe(false);
    });

    it("returns true when session is idle beyond timeout", () => {
      const entry: SessionEntry = {
        sessionId: "test",
        updatedAt: now - 1000 * 60 * 70, // 70 minutes ago
      };
      expect(isSessionExpired(entry, { idle: 3600 }, now)).toBe(true);
    });

    it("returns false when session is within maxAge", () => {
      const entry: SessionEntry = {
        sessionId: "test",
        createdAt: now - 1000 * 60 * 60 * 12, // 12 hours ago
      };
      expect(isSessionExpired(entry, { maxAge: 86400 }, now)).toBe(false);
    });

    it("returns true when session exceeds maxAge", () => {
      const entry: SessionEntry = {
        sessionId: "test",
        createdAt: now - 1000 * 60 * 60 * 25, // 25 hours ago
      };
      expect(isSessionExpired(entry, { maxAge: 86400 }, now)).toBe(true);
    });

    it("checks both idle and maxAge", () => {
      const entry: SessionEntry = {
        sessionId: "test",
        createdAt: now - 1000 * 60 * 60 * 20, // 20 hours ago
        updatedAt: now - 1000 * 60 * 30, // 30 minutes ago (active)
      };
      // Active within idle but check maxAge too
      expect(isSessionExpired(entry, { idle: 3600, maxAge: 86400 }, now)).toBe(false);
    });

    it("expires on either condition when both set", () => {
      const entry: SessionEntry = {
        sessionId: "test",
        createdAt: now - 1000 * 60 * 60 * 25, // 25 hours ago (exceeds maxAge)
        updatedAt: now - 1000 * 60 * 30, // 30 minutes ago (within idle)
      };
      expect(isSessionExpired(entry, { idle: 3600, maxAge: 86400 }, now)).toBe(true);
    });

    it("returns false when no timestamps available", () => {
      const entry: SessionEntry = { sessionId: "test" };
      expect(isSessionExpired(entry, { idle: 3600, maxAge: 86400 }, now)).toBe(false);
    });
  });

  describe("getExpiredSessionKeys", () => {
    const now = 1706400000000;

    it("returns empty array for empty store", () => {
      expect(getExpiredSessionKeys({}, { idle: 3600 }, now)).toEqual([]);
    });

    it("returns empty array when no sessions expired", () => {
      const store: Record<string, SessionEntry> = {
        "session:a": { sessionId: "a", updatedAt: now - 1000 * 60 * 5 },
        "session:b": { sessionId: "b", updatedAt: now - 1000 * 60 * 10 },
      };
      expect(getExpiredSessionKeys(store, { idle: 3600 }, now)).toEqual([]);
    });

    it("returns only expired session keys", () => {
      const store: Record<string, SessionEntry> = {
        "session:active": { sessionId: "active", updatedAt: now - 1000 * 60 * 5 },
        "session:expired": { sessionId: "expired", updatedAt: now - 1000 * 60 * 70 },
        "session:old": { sessionId: "old", updatedAt: now - 1000 * 60 * 120 },
      };
      const expired = getExpiredSessionKeys(store, { idle: 3600 }, now);
      expect(expired).toContain("session:expired");
      expect(expired).toContain("session:old");
      expect(expired).not.toContain("session:active");
      expect(expired).toHaveLength(2);
    });
  });

  describe("getCleanupConfig", () => {
    it("returns default interval when undefined", () => {
      expect(getCleanupConfig()).toEqual({
        intervalSeconds: DEFAULT_CLEANUP_INTERVAL_SECONDS,
      });
    });

    it("returns custom interval when set", () => {
      expect(getCleanupConfig({ intervalSeconds: 600 })).toEqual({
        intervalSeconds: 600,
      });
    });

    it("returns default when empty object", () => {
      expect(getCleanupConfig({})).toEqual({
        intervalSeconds: DEFAULT_CLEANUP_INTERVAL_SECONDS,
      });
    });
  });
});
