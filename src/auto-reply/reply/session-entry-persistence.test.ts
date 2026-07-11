import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { persistReplySessionEntry } from "./session-entry-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("persistReplySessionEntry", () => {
  it("does not restore policy fields revoked during reply processing", async () => {
    const dir = tempDirs.make("openclaw-reply-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
        thinkingLevel: "low",
        elevatedLevel: "full",
        inheritedToolAllow: ["exec"],
        sendPolicy: "allow",
      };
      const currentEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 400,
        thinkingLevel: "low",
        sendPolicy: "deny",
      };
      await replaceSessionEntry({ sessionKey: "main", storePath }, currentEntry);

      const result = await persistReplySessionEntry({
        storePath,
        sessionKey: "main",
        initialEntry,
        entry: {
          ...initialEntry,
          thinkingLevel: "high",
          updatedAt: 250,
        },
      });

      expect(result.status).toBe("current");
      if (result.status !== "current") {
        throw new Error("expected current persisted session");
      }
      expect(result.entry).toMatchObject({
        sessionId: "session-1",
        thinkingLevel: "high",
        sendPolicy: "deny",
        updatedAt: 400,
      });
      expect(result.entry.elevatedLevel).toBeUndefined();
      expect(result.entry.inheritedToolAllow).toBeUndefined();
      expect(
        loadSessionEntry({ sessionKey: "main", storePath, readConsistency: "latest" }),
      ).toEqual(result.entry);
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("rejects persistence when the session rotated", async () => {
    const dir = tempDirs.make("openclaw-reply-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
        thinkingLevel: "low",
      };
      const currentEntry: SessionEntry = {
        sessionId: "session-2",
        updatedAt: 400,
        thinkingLevel: "medium",
      };
      await replaceSessionEntry({ sessionKey: "main", storePath }, currentEntry);

      const result = await persistReplySessionEntry({
        storePath,
        sessionKey: "main",
        initialEntry,
        entry: { ...initialEntry, thinkingLevel: "high", updatedAt: 250 },
      });

      expect(result).toEqual({
        status: "lifecycle-invalidated",
        error: 'Session "main" changed while starting work. Retry.',
        entry: currentEntry,
      });
      expect(
        loadSessionEntry({ sessionKey: "main", storePath, readConsistency: "latest" }),
      ).toEqual(currentEntry);
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("does not recreate a row deleted after reply initialization by default", async () => {
    const dir = tempDirs.make("openclaw-reply-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
      };
      const result = await persistReplySessionEntry({
        storePath,
        sessionKey: "main",
        initialEntry,
        entry: { ...initialEntry, updatedAt: 250 },
      });

      expect(result).toEqual({
        status: "lifecycle-invalidated",
        error: 'Session "main" was deleted while starting work. Retry.',
      });
      expect(
        loadSessionEntry({ sessionKey: "main", storePath, readConsistency: "latest" }),
      ).toBeUndefined();
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("rejects same-value persistence after the session is archived", async () => {
    const dir = tempDirs.make("openclaw-reply-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
        modelOverride: "gpt-5.5",
      };
      const archivedEntry: SessionEntry = {
        ...initialEntry,
        updatedAt: 400,
        archivedAt: 300,
      };
      await replaceSessionEntry({ sessionKey: "main", storePath }, archivedEntry);

      const result = await persistReplySessionEntry({
        storePath,
        sessionKey: "main",
        initialEntry,
        entry: { ...initialEntry, updatedAt: 250 },
        touchedFields: ["modelOverride"],
      });

      expect(result).toEqual({
        status: "lifecycle-invalidated",
        error: 'Session "main" is archived. Restore it before starting new work.',
        entry: archivedEntry,
      });
      expect(
        loadSessionEntry({ sessionKey: "main", storePath, readConsistency: "latest" }),
      ).toEqual(archivedEntry);
    } finally {
      clearSessionStoreCacheForTest();
    }
  });
});
