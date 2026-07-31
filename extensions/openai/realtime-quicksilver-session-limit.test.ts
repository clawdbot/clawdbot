import { describe, expect, it, vi } from "vitest";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";

describe("GPT-Live shared session limit", () => {
  it("prunes expired pending offers before reserving a relay session", () => {
    const owners = Array.from({ length: 9 }, () => Symbol("quicksilver-session"));
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      for (const owner of owners.slice(0, 8)) {
        reserveOpenAIQuicksilverSession(owner, { expiresAtMs: now + 1 });
      }
      vi.mocked(Date.now).mockReturnValue(now + 1);
      expect(() => reserveOpenAIQuicksilverSession(owners[8])).not.toThrow();
    } finally {
      for (const owner of owners) {
        releaseOpenAIQuicksilverSession(owner);
      }
      vi.restoreAllMocks();
    }
  });

  it("keeps unexpired pending offers within the shared cap", () => {
    const owners = Array.from({ length: 9 }, () => Symbol("quicksilver-session"));
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      for (const owner of owners.slice(0, 8)) {
        reserveOpenAIQuicksilverSession(owner, { expiresAtMs: now + 1 });
      }
      expect(() => reserveOpenAIQuicksilverSession(owners[8])).toThrow(
        "Too many concurrent OpenAI GPT-Live sessions",
      );
    } finally {
      for (const owner of owners) {
        releaseOpenAIQuicksilverSession(owner);
      }
      vi.restoreAllMocks();
    }
  });

  it("does not expire established sessions", () => {
    const owners = Array.from({ length: 9 }, () => Symbol("quicksilver-session"));
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      for (const owner of owners.slice(0, 8)) {
        reserveOpenAIQuicksilverSession(owner, { expiresAtMs: now + 1 });
        reserveOpenAIQuicksilverSession(owner);
      }
      vi.mocked(Date.now).mockReturnValue(now + 60_000);
      expect(() => reserveOpenAIQuicksilverSession(owners[8])).toThrow(
        "Too many concurrent OpenAI GPT-Live sessions",
      );
    } finally {
      for (const owner of owners) {
        releaseOpenAIQuicksilverSession(owner);
      }
      vi.restoreAllMocks();
    }
  });

  it("releases reservations explicitly", () => {
    const owners = Array.from({ length: 9 }, () => Symbol("quicksilver-session"));
    try {
      for (const owner of owners.slice(0, 8)) {
        reserveOpenAIQuicksilverSession(owner);
      }
      expect(() => reserveOpenAIQuicksilverSession(owners[8])).toThrow(
        "Too many concurrent OpenAI GPT-Live sessions",
      );
      releaseOpenAIQuicksilverSession(owners[0]);
      expect(() => reserveOpenAIQuicksilverSession(owners[8])).not.toThrow();
    } finally {
      for (const owner of owners) {
        releaseOpenAIQuicksilverSession(owner);
      }
    }
  });
});
