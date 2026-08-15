// Session cache field tests cover cached metadata stored with sessions.
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

describe("SessionEntry cache fields", () => {
  it("supports cacheRead and cacheWrite fields", () => {
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      cacheRead: 1500,
      cacheWrite: 300,
    };

    expect(entry.cacheRead).toBe(1500);
    expect(entry.cacheWrite).toBe(300);
  });

  it("merges cache fields properly", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      cacheRead: 1000,
      cacheWrite: 200,
      totalTokens: 5000,
    };

    const patch: Partial<SessionEntry> = {
      cacheRead: 1500,
      cacheWrite: 300,
    };

    const merged = mergeSessionEntry(existing, patch);

    expect(merged.cacheRead).toBe(1500);
    expect(merged.cacheWrite).toBe(300);
    expect(merged.totalTokens).toBe(5000); // Preserved from existing
  });

  it("handles undefined cache fields", () => {
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      totalTokens: 5000,
    };

    expect(entry.cacheRead).toBeUndefined();
    expect(entry.cacheWrite).toBeUndefined();
  });

  it("allows cache fields to be cleared with undefined", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      cacheRead: 1000,
      cacheWrite: 200,
    };

    const patch: Partial<SessionEntry> = {
      cacheRead: undefined,
      cacheWrite: undefined,
    };

    const merged = mergeSessionEntry(existing, patch);

    expect(merged.cacheRead).toBeUndefined();
    expect(merged.cacheWrite).toBeUndefined();
  });
});
